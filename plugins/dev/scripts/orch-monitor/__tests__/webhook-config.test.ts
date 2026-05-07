import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadWebhookConfig, _resetWebhookDeprecationWarning } from "../lib/webhook-config";

let tmpDir: string;
let homeDir: string;
let projectDir: string;
let projectConfigPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "webhook-config-test-"));
  homeDir = join(tmpDir, "home-config");
  projectDir = join(tmpDir, "project");
  projectConfigPath = join(projectDir, "config.json");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  _resetWebhookDeprecationWarning();
  delete process.env.CATALYST_WEBHOOK_SECRET;
  delete process.env.CATALYST_SMEE_SECRET;
  delete process.env.CATALYST_SMEE_CHANNEL;
  delete process.env.CATALYST_LINEAR_WEBHOOK_SECRET;
  delete process.env.CATALYST_LINEAR_SMEE_CHANNEL;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CATALYST_WEBHOOK_SECRET;
  delete process.env.CATALYST_SMEE_SECRET;
  delete process.env.CATALYST_SMEE_CHANNEL;
  delete process.env.CATALYST_LINEAR_WEBHOOK_SECRET;
  delete process.env.CATALYST_LINEAR_SMEE_CHANNEL;
});

function writeProject(json: object): void {
  writeFileSync(projectConfigPath, JSON.stringify(json));
}

function writeHome(json: object): void {
  writeFileSync(join(homeDir, "config.json"), JSON.stringify(json));
}

describe("loadWebhookConfig", () => {
  it("returns null when neither layer has config and env is unset", () => {
    const cfg = loadWebhookConfig(homeDir, projectConfigPath);
    expect(cfg).toBeNull();
  });

  it("loads channel from home-dir Layer 2 with secret env from default name (no warning)", () => {
    writeHome({
      catalyst: {
        monitor: {
          github: { smeeChannel: "https://smee.io/home-channel" },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "home-secret";
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).toEqual({
      smeeChannel: "https://smee.io/home-channel",
      secret: "home-secret",
      secretEnvName: "CATALYST_WEBHOOK_SECRET",
      watchRepos: [],
      linearSecrets: [],
      linearSmeeChannel: "",
      linearBotUserId: "",
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("loads channel from Layer 1 only and emits a single deprecation warning", () => {
    writeProject({
      catalyst: {
        monitor: {
          github: {
            smeeChannel: "https://smee.io/legacy-channel",
            webhookSecretEnv: "CATALYST_WEBHOOK_SECRET",
          },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "legacy-secret";
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).toEqual({
      smeeChannel: "https://smee.io/legacy-channel",
      secret: "legacy-secret",
      secretEnvName: "CATALYST_WEBHOOK_SECRET",
      watchRepos: [],
      linearSecrets: [],
      linearSmeeChannel: "",
      linearBotUserId: "",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0] ?? "");
    expect(msg).toContain("smeeChannel");
    expect(msg).toContain(".catalyst/config.json");
    warn.mockRestore();
  });

  it("home-dir Layer 2 wins when both layers have smeeChannel; deprecation warning still fires for Layer 1", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home-wins" } },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          github: {
            smeeChannel: "https://smee.io/legacy-loses",
            webhookSecretEnv: "CATALYST_WEBHOOK_SECRET",
          },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).toEqual({
      smeeChannel: "https://smee.io/home-wins",
      secret: "secret",
      secretEnvName: "CATALYST_WEBHOOK_SECRET",
      watchRepos: [],
      linearSecrets: [],
      linearSmeeChannel: "",
      linearBotUserId: "",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("merges Layer 1 webhookSecretEnv name with home-dir smeeChannel", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          github: { webhookSecretEnv: "MY_CUSTOM_SECRET_ENV" },
        },
      },
    });
    process.env.MY_CUSTOM_SECRET_ENV = "custom-value";
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).toEqual({
      smeeChannel: "https://smee.io/home",
      secret: "custom-value",
      secretEnvName: "MY_CUSTOM_SECRET_ENV",
      watchRepos: [],
      linearSecrets: [],
      linearSmeeChannel: "",
      linearBotUserId: "",
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    delete process.env.MY_CUSTOM_SECRET_ENV;
  });

  it("CATALYST_SMEE_CHANNEL env overrides both layers", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    process.env.CATALYST_SMEE_CHANNEL = "https://smee.io/env-override";
    process.env.CATALYST_WEBHOOK_SECRET = "secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).toEqual({
      smeeChannel: "https://smee.io/env-override",
      secret: "secret",
      secretEnvName: "CATALYST_WEBHOOK_SECRET",
      watchRepos: [],
      linearSecrets: [],
      linearSmeeChannel: "",
      linearBotUserId: "",
    });
  });

  it("falls back to CATALYST_SMEE_SECRET when the named env var is unset", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    writeProject({
      catalyst: {
        monitor: { github: { webhookSecretEnv: "CATALYST_WEBHOOK_SECRET" } },
      },
    });
    process.env.CATALYST_SMEE_SECRET = "legacy-fallback";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).toEqual({
      smeeChannel: "https://smee.io/home",
      secret: "legacy-fallback",
      secretEnvName: "CATALYST_WEBHOOK_SECRET",
      watchRepos: [],
      linearSecrets: [],
      linearSmeeChannel: "",
      linearBotUserId: "",
    });
  });

  it("returns null when channel is set but secret is empty", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    // No env var set
    const cfg = loadWebhookConfig(homeDir, projectConfigPath);
    expect(cfg).toBeNull();
  });

  it("returns null when secret is set but no channel anywhere", () => {
    process.env.CATALYST_WEBHOOK_SECRET = "secret";
    const cfg = loadWebhookConfig(homeDir, projectConfigPath);
    expect(cfg).toBeNull();
  });

  it("emits the deprecation warning at most once per process across multiple loads", () => {
    writeProject({
      catalyst: {
        monitor: {
          github: {
            smeeChannel: "https://smee.io/legacy",
            webhookSecretEnv: "CATALYST_WEBHOOK_SECRET",
          },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    loadWebhookConfig(homeDir, projectConfigPath);
    loadWebhookConfig(homeDir, projectConfigPath);
    loadWebhookConfig(homeDir, projectConfigPath);

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns null when project config is malformed JSON", () => {
    writeFileSync(projectConfigPath, "not json{{{");
    process.env.CATALYST_WEBHOOK_SECRET = "secret";
    const cfg = loadWebhookConfig(homeDir, projectConfigPath);
    expect(cfg).toBeNull();
  });

  it("ignores home-dir file with malformed JSON and falls back to Layer 1", () => {
    writeFileSync(join(homeDir, "config.json"), "garbage{");
    writeProject({
      catalyst: {
        monitor: {
          github: {
            smeeChannel: "https://smee.io/legacy",
            webhookSecretEnv: "CATALYST_WEBHOOK_SECRET",
          },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).toEqual({
      smeeChannel: "https://smee.io/legacy",
      secret: "secret",
      secretEnvName: "CATALYST_WEBHOOK_SECRET",
      watchRepos: [],
      linearSecrets: [],
      linearSmeeChannel: "",
      linearBotUserId: "",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("returns null when configs exist but lack the catalyst.monitor.github shape", () => {
    writeHome({ unrelated: "value" });
    writeProject({ catalyst: { other: "thing" } });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);
    expect(cfg).toBeNull();
  });

  it("uses default secret env name CATALYST_WEBHOOK_SECRET when webhookSecretEnv is absent", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    // Project config has no webhookSecretEnv at all
    writeProject({});
    process.env.CATALYST_WEBHOOK_SECRET = "default-secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).toEqual({
      smeeChannel: "https://smee.io/home",
      secret: "default-secret",
      secretEnvName: "CATALYST_WEBHOOK_SECRET",
      watchRepos: [],
      linearSecrets: [],
      linearSmeeChannel: "",
      linearBotUserId: "",
    });
  });
});

describe("loadWebhookConfig watchRepos (CTL-216)", () => {
  it("returns an empty watchRepos array when the field is absent", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).not.toBeNull();
    expect(cfg!.watchRepos).toEqual([]);
  });

  it("reads watchRepos from Layer 1 (project config)", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          github: {
            webhookSecretEnv: "CATALYST_WEBHOOK_SECRET",
            watchRepos: ["coalesce-labs/catalyst", "coalesce-labs/adva"],
          },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).not.toBeNull();
    expect(cfg!.watchRepos).toEqual(["coalesce-labs/catalyst", "coalesce-labs/adva"]);
  });

  it("ignores watchRepos in Layer 2 (home-dir config) — Layer 1 only", () => {
    // watchRepos is a team-default field; per CTL-217's split, only Layer 1
    // contributes. A user putting watchRepos in their home-dir config should
    // be a no-op rather than an override.
    writeHome({
      catalyst: {
        monitor: {
          github: {
            smeeChannel: "https://smee.io/home",
            watchRepos: ["should/be-ignored"],
          },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).not.toBeNull();
    expect(cfg!.watchRepos).toEqual([]);
  });

  it("merges Layer 1 watchRepos with Layer 2 smeeChannel", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          github: {
            webhookSecretEnv: "CATALYST_WEBHOOK_SECRET",
            watchRepos: ["a/b"],
          },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).toEqual({
      smeeChannel: "https://smee.io/home",
      secret: "secret",
      secretEnvName: "CATALYST_WEBHOOK_SECRET",
      watchRepos: ["a/b"],
      linearSecrets: [],
      linearSmeeChannel: "",
      linearBotUserId: "",
    });
  });

  it("filters out non-string entries", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          github: {
            webhookSecretEnv: "CATALYST_WEBHOOK_SECRET",
            // Mixed types — only valid owner/repo strings should survive.
            watchRepos: ["good/repo", 42, null, { not: "string" }, ["nested"]],
          },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg!.watchRepos).toEqual(["good/repo"]);
    warn.mockRestore();
  });

  it("filters out empty and whitespace-only strings", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          github: {
            webhookSecretEnv: "CATALYST_WEBHOOK_SECRET",
            watchRepos: ["a/b", "", "   ", "c/d"],
          },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg!.watchRepos).toEqual(["a/b", "c/d"]);
    warn.mockRestore();
  });

  it("filters entries that don't match owner/repo shape", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          github: {
            webhookSecretEnv: "CATALYST_WEBHOOK_SECRET",
            watchRepos: ["a/b", "no-slash", "/leading", "trailing/", "a/b/c"],
          },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    // Only "a/b" matches the owner/repo shape (single slash, non-empty parts,
    // no path components). Entries like "a/b/c" are not GitHub repos.
    expect(cfg!.watchRepos).toEqual(["a/b"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns empty array when watchRepos is not an array", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          github: {
            webhookSecretEnv: "CATALYST_WEBHOOK_SECRET",
            watchRepos: "not-an-array",
          },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg!.watchRepos).toEqual([]);
  });

  it("dedupes duplicate entries while preserving first-occurrence order", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          github: {
            webhookSecretEnv: "CATALYST_WEBHOOK_SECRET",
            watchRepos: ["a/b", "c/d", "a/b", "e/f", "c/d"],
          },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg!.watchRepos).toEqual(["a/b", "c/d", "e/f"]);
  });
});

describe("loadWebhookConfig — Linear webhook secret (CTL-210)", () => {
  it("resolves linearSecret from the env-var named in Layer 1", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          github: { webhookSecretEnv: "CATALYST_WEBHOOK_SECRET" },
          linear: { webhookSecretEnv: "MY_LINEAR_SECRET" },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "github-secret";
    process.env.MY_LINEAR_SECRET = "linear-from-named-env";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).not.toBeNull();
    expect(cfg!.linearSecrets).toEqual([]);

    delete process.env.MY_LINEAR_SECRET;
  });

  it("falls back to CATALYST_LINEAR_WEBHOOK_SECRET when no env-var name is configured", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          github: { webhookSecretEnv: "CATALYST_WEBHOOK_SECRET" },
          linear: {},
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "github-secret";
    process.env.CATALYST_LINEAR_WEBHOOK_SECRET = "linear-fallback";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg!.linearSecrets).toEqual([]);
  });

  it("returns linearSecret as empty string when no Linear config and no env var", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/home" } },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "github-secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg!.linearSecrets).toEqual([]);
  });

  it("Linear-only config (no GitHub channel) still loads with smeeChannel/secret empty", () => {
    writeHome({
      catalyst: {
        monitor: {
          linear: {
            workspace: {
              webhookId: "linear-webhook-123",
            },
          },
        },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          linear: { webhookSecretEnv: "MY_LINEAR_SECRET" },
        },
      },
    });
    process.env.MY_LINEAR_SECRET = "linear-only";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).not.toBeNull();
    expect(cfg!.smeeChannel).toBe("");
    expect(cfg!.secret).toBe("");
    expect(cfg!.linearSecrets).toEqual([{ key: "workspace", secret: "linear-only" }]);
    expect(cfg!.linearSmeeChannel).toBe("");

    delete process.env.MY_LINEAR_SECRET;
  });

  it("exposes secretEnvName from project config webhookSecretEnv", () => {
    writeProject({
      catalyst: {
        monitor: {
          github: {
            webhookSecretEnv: "MY_SECRET",
          },
        },
      },
    });
    writeHome({
      catalyst: { monitor: { github: { smeeChannel: "https://smee.io/ch" } } },
    });
    process.env.MY_SECRET = "s";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);
    expect(cfg?.secretEnvName).toBe("MY_SECRET");

    delete process.env.MY_SECRET;
  });

  it("defaults secretEnvName to CATALYST_WEBHOOK_SECRET when not in config", () => {
    writeHome({
      catalyst: { monitor: { github: { smeeChannel: "https://smee.io/ch" } } },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "s";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);
    expect(cfg?.secretEnvName).toBe("CATALYST_WEBHOOK_SECRET");
  });
});

describe("loadWebhookConfig — linearSmeeChannel (CTL-242)", () => {
  it("loads linearSmeeChannel from home-dir Layer 2 config", () => {
    writeHome({
      catalyst: {
        monitor: {
          github: { smeeChannel: "https://smee.io/github-chan" },
          linear: { smeeChannel: "https://smee.io/linear123" },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).not.toBeNull();
    expect(cfg!.linearSmeeChannel).toBe("https://smee.io/linear123");
  });

  it("linearSmeeChannel is empty when neither config nor env present", () => {
    writeHome({
      catalyst: {
        monitor: { github: { smeeChannel: "https://smee.io/github-chan" } },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).not.toBeNull();
    expect(cfg!.linearSmeeChannel).toBe("");
  });

  it("CATALYST_LINEAR_SMEE_CHANNEL env override beats file value", () => {
    writeHome({
      catalyst: {
        monitor: {
          github: { smeeChannel: "https://smee.io/github-chan" },
          linear: { smeeChannel: "https://smee.io/file-value" },
        },
      },
    });
    process.env.CATALYST_WEBHOOK_SECRET = "secret";
    process.env.CATALYST_LINEAR_SMEE_CHANNEL = "https://smee.io/env-override";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).not.toBeNull();
    expect(cfg!.linearSmeeChannel).toBe("https://smee.io/env-override");
  });

  it("linearSmeeChannel and smeeChannel are independent (one set, other empty)", () => {
    writeHome({
      catalyst: {
        monitor: {
          linear: { smeeChannel: "https://smee.io/linear-only" },
        },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          linear: { webhookSecretEnv: "CATALYST_LINEAR_WEBHOOK_SECRET" },
        },
      },
    });
    process.env.CATALYST_LINEAR_WEBHOOK_SECRET = "linear-secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).not.toBeNull();
    expect(cfg!.smeeChannel).toBe("");
    expect(cfg!.linearSmeeChannel).toBe("https://smee.io/linear-only");
  });

  // CTL-263: linearBotUserId
  it("reads catalyst.monitor.linear.botUserId from Layer 1 into linearBotUserId", () => {
    writeHome({
      catalyst: {
        monitor: {
          linear: {
            workspace: {
              webhookId: "linear-webhook-123",
            },
          },
        },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          linear: {
            webhookSecretEnv: "CATALYST_LINEAR_WEBHOOK_SECRET",
            botUserId: "bot-linear-uuid-abc",
          },
        },
      },
    });
    process.env.CATALYST_LINEAR_WEBHOOK_SECRET = "linear-secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).not.toBeNull();
    expect(cfg!.linearBotUserId).toBe("bot-linear-uuid-abc");
  });

  it("linearBotUserId is empty string when not configured", () => {
    writeHome({
      catalyst: {
        monitor: {
          linear: {
            workspace: {
              webhookId: "linear-webhook-123",
            },
          },
        },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          linear: { webhookSecretEnv: "CATALYST_LINEAR_WEBHOOK_SECRET" },
        },
      },
    });
    process.env.CATALYST_LINEAR_WEBHOOK_SECRET = "linear-secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).not.toBeNull();
    expect(cfg!.linearBotUserId).toBe("");
  });
});

describe("loadWebhookConfig — per-team secret files (CTL-285)", () => {
  it("reads linearSecret from per-team file when file exists", () => {
    writeFileSync(join(homeDir, "linear-webhook-secret-ctl"), "file-secret-ctl\n");
    writeHome({
      catalyst: {
        monitor: {
          linear: {
            ctl: { webhookId: "linear-webhook-123" },
          },
        },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          linear: { webhookSecretEnv: "MY_LINEAR_SECRET" },
        },
      },
    });
    process.env.MY_LINEAR_SECRET = "env-fallback-should-not-be-used";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg).not.toBeNull();
    expect(cfg!.linearSecrets).toEqual([{ key: "ctl", secret: "file-secret-ctl" }]);

    delete process.env.MY_LINEAR_SECRET;
  });

  it("falls back to env var when per-team file does not exist", () => {
    writeHome({
      catalyst: {
        monitor: {
          linear: {
            ctl: { webhookId: "linear-webhook-123" },
          },
        },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          linear: { webhookSecretEnv: "CATALYST_LINEAR_WEBHOOK_SECRET" },
        },
      },
    });
    process.env.CATALYST_LINEAR_WEBHOOK_SECRET = "env-secret";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg!.linearSecrets).toEqual([{ key: "ctl", secret: "env-secret" }]);
  });

  it("reads workspace secret from linear-webhook-secret file for workspace key", () => {
    writeFileSync(join(homeDir, "linear-webhook-secret"), "workspace-file-secret\n");
    writeHome({
      catalyst: {
        monitor: {
          linear: {
            workspace: { webhookId: "linear-webhook-456" },
          },
        },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          linear: { webhookSecretEnv: "MY_LINEAR_SECRET" },
        },
      },
    });
    process.env.MY_LINEAR_SECRET = "env-fallback-should-not-be-used";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg!.linearSecrets).toEqual([{ key: "workspace", secret: "workspace-file-secret" }]);

    delete process.env.MY_LINEAR_SECRET;
  });

  it("reads legacy single-object secret from linear-webhook-secret file", () => {
    writeFileSync(join(homeDir, "linear-webhook-secret"), "legacy-file-secret\n");
    writeHome({
      catalyst: {
        monitor: {
          linear: { webhookId: "linear-webhook-legacy" },
        },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          linear: { webhookSecretEnv: "MY_LINEAR_SECRET" },
        },
      },
    });
    process.env.MY_LINEAR_SECRET = "env-should-not-be-used";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg!.linearSecrets).toEqual([{ key: "workspace", secret: "legacy-file-secret" }]);

    delete process.env.MY_LINEAR_SECRET;
  });

  it("trims trailing newlines from file-based secrets", () => {
    writeFileSync(join(homeDir, "linear-webhook-secret-adv"), "secret-with-newline\n");
    writeHome({
      catalyst: {
        monitor: {
          linear: { adv: { webhookId: "adv-webhook-123" } },
        },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          linear: { webhookSecretEnv: "CATALYST_LINEAR_WEBHOOK_SECRET" },
        },
      },
    });

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg!.linearSecrets).toEqual([{ key: "adv", secret: "secret-with-newline" }]);
  });

  it("prefers file over env var when both are present", () => {
    writeFileSync(join(homeDir, "linear-webhook-secret-ctl"), "file-wins\n");
    writeHome({
      catalyst: {
        monitor: {
          linear: { ctl: { webhookId: "ctl-webhook-id" } },
        },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          linear: { webhookSecretEnv: "CATALYST_LINEAR_WEBHOOK_SECRET" },
        },
      },
    });
    process.env.CATALYST_LINEAR_WEBHOOK_SECRET = "env-loses";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg!.linearSecrets).toEqual([{ key: "ctl", secret: "file-wins" }]);
  });

  it("handles multiple teams each with their own secret files", () => {
    writeFileSync(join(homeDir, "linear-webhook-secret-adv"), "adv-secret\n");
    writeFileSync(join(homeDir, "linear-webhook-secret-ctl"), "ctl-secret\n");
    writeHome({
      catalyst: {
        monitor: {
          linear: {
            adv: { webhookId: "adv-webhook-id" },
            ctl: { webhookId: "ctl-webhook-id" },
          },
        },
      },
    });
    writeProject({
      catalyst: {
        monitor: {
          linear: { webhookSecretEnv: "CATALYST_LINEAR_WEBHOOK_SECRET" },
        },
      },
    });
    process.env.CATALYST_LINEAR_WEBHOOK_SECRET = "shared-fallback";

    const cfg = loadWebhookConfig(homeDir, projectConfigPath);

    expect(cfg!.linearSecrets).toHaveLength(2);
    expect(cfg!.linearSecrets).toContainEqual({ key: "adv", secret: "adv-secret" });
    expect(cfg!.linearSecrets).toContainEqual({ key: "ctl", secret: "ctl-secret" });
  });
});
