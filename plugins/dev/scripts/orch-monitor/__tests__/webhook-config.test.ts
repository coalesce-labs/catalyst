import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadWebhookConfig,
  _resetWebhookDeprecationWarning,
} from "../lib/webhook-config";

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
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CATALYST_WEBHOOK_SECRET;
  delete process.env.CATALYST_SMEE_SECRET;
  delete process.env.CATALYST_SMEE_CHANNEL;
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
    });
  });
});
