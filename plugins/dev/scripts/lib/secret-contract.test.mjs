import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  SECRET_DELIVERY,
  ROTATION_CLASSES,
  SECRET_REGISTRY,
  getSecretRow,
  isSecretFamilyMember,
  resolveLayer2Path,
  explicitFileOverrideEnvName,
  secretFileCandidates,
  resolveSecret,
  registerRearmHook,
  clearRearmHook,
  resetArmState,
  armSecret,
} from "./secret-contract.mjs";

// Fixture-file helpers, following the deployment-mode.test.mjs convention: every test gets
// its own tmp dir so parallel runs never collide, and points paths at fixtures directly
// rather than the real filesystem or process.env.
let _tmpDirs = [];
function fixtureDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "secret-contract-test-"));
  _tmpDirs.push(dir);
  return dir;
}
function writeFile(dir, name, contents) {
  const path = resolve(dir, name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  return path;
}
afterEach(() => {
  for (const dir of _tmpDirs) rmSync(dir, { recursive: true, force: true });
  _tmpDirs = [];
  resetArmState();
});
beforeEach(() => {
  // Every re-armable seed row must start each test with no registered hook — several tests
  // below register/clear one explicitly, and a leaked registration would silently change
  // another test's code path.
  for (const row of SECRET_REGISTRY) clearRearmHook(row.id);
});

describe("SECRET_REGISTRY — shape", () => {
  test("11 seed rows, matching the design §2 seed table", () => {
    expect(SECRET_REGISTRY.length).toBe(11);
    expect(SECRET_REGISTRY.map((r) => r.id)).toEqual([
      "github-token",
      "webhook-secret",
      "linear-webhook-secret",
      "claude-accounts.env",
      "execution-core.env",
      "linear-api-token",
      "linear-orchestrator-actor",
      "linear-worker-actor",
      "groq-api-key",
      "cloud-token",
      "age-key",
    ]);
  });

  test("registry and every row are frozen — DATA, never mutated at runtime", () => {
    expect(Object.isFrozen(SECRET_REGISTRY)).toBe(true);
    for (const row of SECRET_REGISTRY) expect(Object.isFrozen(row)).toBe(true);
  });

  test("mutating the frozen registry array throws (strict-mode ESM)", () => {
    expect(() => {
      SECRET_REGISTRY.push({ id: "bogus" });
    }).toThrow();
    expect(SECRET_REGISTRY.length).toBe(11);
  });

  test("every row's delivery is a member of SECRET_DELIVERY", () => {
    for (const row of SECRET_REGISTRY) expect(SECRET_DELIVERY).toContain(row.delivery);
  });

  test("every row's rotation.class is a member of ROTATION_CLASSES", () => {
    for (const row of SECRET_REGISTRY) expect(ROTATION_CLASSES).toContain(row.rotation.class);
  });

  test("only local-only rows may declare rotation.class 'n/a'", () => {
    for (const row of SECRET_REGISTRY) {
      if (row.rotation.class === "n/a") expect(row.delivery).toBe("local-only");
      if (row.delivery === "local-only") expect(row.rotation.class).toBe("n/a");
    }
  });

  test("linear-orchestrator-actor and linear-worker-actor are separate rows with distinct config paths (design §2 judge-unanimous graft)", () => {
    const orch = getSecretRow("linear-orchestrator-actor");
    const worker = getSecretRow("linear-worker-actor");
    expect(orch).toBeDefined();
    expect(worker).toBeDefined();
    expect(orch.configJsonPath).not.toBe(worker.configJsonPath);
  });

  test("exactly one row per cloud/cluster bootstrap class (design §5)", () => {
    const cloudRows = SECRET_REGISTRY.filter((r) => r.bootstrapFor === "cloud");
    const clusterRows = SECRET_REGISTRY.filter((r) => r.bootstrapFor === "cluster");
    expect(cloudRows.map((r) => r.id)).toEqual(["cloud-token"]);
    expect(clusterRows.map((r) => r.id)).toEqual(["age-key"]);
  });

  test("getSecretRow returns undefined for an unknown id (never throws)", () => {
    expect(getSecretRow("does-not-exist")).toBeUndefined();
  });
});

describe("isSecretFamilyMember — absorbed cluster-sync.mjs predicate", () => {
  test("case-insensitive prefix match with at least one char after the dash", () => {
    expect(isSecretFamilyMember("linear-webhook-secret-CTL")).toBe(true);
    expect(isSecretFamilyMember("LINEAR-WEBHOOK-SECRET-ctl")).toBe(true);
    expect(isSecretFamilyMember("linear-webhook-secret-a")).toBe(true);
  });
  test("bare prefix (no team suffix) is NOT a member", () => {
    expect(isSecretFamilyMember("linear-webhook-secret-")).toBe(false);
  });
  test("run-on name (no dash) is NOT a member", () => {
    expect(isSecretFamilyMember("linear-webhook-secretXXX")).toBe(false);
  });
  test("the singular linear-webhook-secret exact name is NOT a family member", () => {
    expect(isSecretFamilyMember("linear-webhook-secret")).toBe(false);
  });
  test("non-string/empty input never throws", () => {
    expect(isSecretFamilyMember("")).toBe(false);
    expect(isSecretFamilyMember(undefined)).toBe(false);
    expect(isSecretFamilyMember(null)).toBe(false);
  });
});

describe("resolveLayer2Path — the §2 canonical chain (distinct from deployment-mode.mjs's)", () => {
  test("CATALYST_LAYER2_CONFIG_FILE wins", () => {
    expect(resolveLayer2Path({ CATALYST_LAYER2_CONFIG_FILE: "/explicit/path.json" })).toBe("/explicit/path.json");
  });
  test("CATALYST_MACHINE_CONFIG wins over XDG/default", () => {
    expect(resolveLayer2Path({ CATALYST_MACHINE_CONFIG: "/machine/config.json" })).toBe("/machine/config.json");
  });
  test("XDG_CONFIG_HOME wins over the bare-HOME default", () => {
    expect(resolveLayer2Path({ HOME: "/home/x", XDG_CONFIG_HOME: "/xdg" })).toBe(resolve("/xdg", "catalyst", "config.json"));
  });
  test("falls back to ~/.config/catalyst/config.json", () => {
    expect(resolveLayer2Path({ HOME: "/home/x" })).toBe(resolve("/home/x", ".config", "catalyst", "config.json"));
  });
});

describe("secretFileCandidates / explicitFileOverrideEnvName", () => {
  test("derives CATALYST_<ID>_FILE for github-token and webhook-secret (matches the pre-existing convention)", () => {
    expect(explicitFileOverrideEnvName("github-token")).toBe("CATALYST_GITHUB_TOKEN_FILE");
    expect(explicitFileOverrideEnvName("webhook-secret")).toBe("CATALYST_WEBHOOK_SECRET_FILE");
  });
  test("collapses runs of non-alnum (dash AND dot) to one underscore", () => {
    expect(explicitFileOverrideEnvName("claude-accounts.env")).toBe("CATALYST_CLAUDE_ACCOUNTS_ENV_FILE");
  });
  test("explicit override short-circuits to a single candidate", () => {
    expect(secretFileCandidates("github-token", { CATALYST_GITHUB_TOKEN_FILE: "/x/y" })).toEqual(["/x/y"]);
  });
  test("CATALYST_CONFIG_DIR short-circuits", () => {
    expect(secretFileCandidates("github-token", { CATALYST_CONFIG_DIR: "/cfgdir" })).toEqual([resolve("/cfgdir", "github-token")]);
  });
  test("default chain: cluster-sync destination dir then XDG dir, deduped", () => {
    const out = secretFileCandidates("github-token", { HOME: "/home/x" });
    expect(out).toEqual([
      resolve("/home/x", ".config", "catalyst", "github-token"),
      // Same path both rungs (default Layer-2 dir === default XDG dir) — deduped to one.
    ]);
  });
  test("distinct XDG dir yields two candidates", () => {
    const out = secretFileCandidates("github-token", {
      HOME: "/home/x",
      CATALYST_LAYER2_CONFIG_FILE: "/other/config.json",
      XDG_CONFIG_HOME: "/xdg",
    });
    expect(out).toEqual([resolve("/other", "github-token"), resolve("/xdg", "catalyst", "github-token")]);
  });
});

describe("resolveSecret — bare-file delivery (github-token)", () => {
  test("resolves from the explicit override file", () => {
    const dir = fixtureDir();
    const f = writeFile(dir, "gh", "tok-value\n");
    const r = resolveSecret("github-token", { env: { CATALYST_GITHUB_TOKEN_FILE: f } });
    expect(r.value).toBe("tok-value");
    expect(r.source).toBe("operator-override");
    expect(r.provider).toBe("bare-file");
  });
  test("resolves from CATALYST_CONFIG_DIR as shared-file", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", "abc");
    const r = resolveSecret("github-token", { env: { CATALYST_CONFIG_DIR: dir } });
    expect(r).toMatchObject({ value: "abc", source: "shared-file", provider: "bare-file" });
  });
  test("falls back to an inherited env alias when no file exists anywhere", () => {
    const dir = fixtureDir();
    const r = resolveSecret("github-token", {
      env: { CATALYST_CONFIG_DIR: dir, GH_TOKEN: "inherited-tok" },
    });
    expect(r).toMatchObject({ value: "inherited-tok", source: "inherited", provider: "bare-file" });
  });
  test("nothing anywhere resolves to none", () => {
    const dir = fixtureDir();
    const r = resolveSecret("github-token", { env: { CATALYST_CONFIG_DIR: dir } });
    expect(r).toMatchObject({ value: null, source: "none", provider: "bare-file" });
  });
  test("preserves significant boundary whitespace, strips only trailing EOL", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", " padded-value \n\n");
    const r = resolveSecret("github-token", { env: { CATALYST_CONFIG_DIR: dir } });
    expect(r.value).toBe(" padded-value ");
  });
  test("a whitespace-only file is treated as absent, falls through to env alias", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", "   \n");
    const r = resolveSecret("github-token", { env: { CATALYST_CONFIG_DIR: dir, GH_TOKEN: "fallback" } });
    expect(r).toMatchObject({ value: "fallback", source: "inherited" });
  });
  test("a NUL-containing file is rejected (parity guard), falls through to env alias", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", Buffer.from("c\0loud"));
    const r = resolveSecret("github-token", { env: { CATALYST_CONFIG_DIR: dir, GH_TOKEN: "fallback" } });
    expect(r).toMatchObject({ value: "fallback", source: "inherited" });
  });
});

describe("resolveSecret — unknown id", () => {
  test("never throws; returns the 4-field null shape", () => {
    expect(resolveSecret("does-not-exist", { env: {} })).toEqual({
      value: null,
      source: null,
      provider: null,
      rotation: null,
    });
  });
});

describe("resolveSecret — bare-file-family (linear-webhook-secret)", () => {
  test("has no single scalar value — resolveSecret returns null/null for it", () => {
    const r = resolveSecret("linear-webhook-secret", { env: {} });
    expect(r.value).toBeNull();
    expect(r.provider).toBe("bare-file-family");
  });
});

describe("resolveSecret — env-file delivery (claude-accounts.env)", () => {
  test("presence-checks the file, value is the PATH not the content", () => {
    const dir = fixtureDir();
    const f = writeFile(dir, "claude-accounts.env", "CLAUDE_CODE_OAUTH_TOKEN=abc\n");
    const r = resolveSecret("claude-accounts.env", { env: { CATALYST_CONFIG_DIR: dir } });
    expect(r).toMatchObject({ value: f, source: "shared-file", provider: "env-file" });
  });
  test("an empty file counts as absent", () => {
    const dir = fixtureDir();
    writeFile(dir, "claude-accounts.env", "");
    const r = resolveSecret("claude-accounts.env", { env: { CATALYST_CONFIG_DIR: dir } });
    expect(r).toMatchObject({ value: null, source: "none" });
  });
});

describe("resolveSecret — env-alias delivery (linear-api-token)", () => {
  test("LINEAR_API_TOKEN wins over LINEAR_API_KEY", () => {
    const r = resolveSecret("linear-api-token", {
      env: { LINEAR_API_TOKEN: "tok-a", LINEAR_API_KEY: "tok-b" },
    });
    expect(r).toMatchObject({ value: "tok-a", envName: "LINEAR_API_TOKEN" });
  });
  test("LINEAR_API_KEY-only fixture resolves (the CTL-1619 regression this row folds/prevents)", () => {
    const r = resolveSecret("linear-api-token", { env: { LINEAR_API_KEY: "tok-b" } });
    expect(r).toMatchObject({ value: "tok-b", source: "inherited", envName: "LINEAR_API_KEY" });
  });
  test("neither set resolves to none", () => {
    expect(resolveSecret("linear-api-token", { env: {} })).toMatchObject({ value: null, source: "none" });
  });
});

describe("resolveSecret — config-json delivery (linear-orchestrator-actor, groq-api-key)", () => {
  test("reads the dotted path from the Layer-2 file", () => {
    const dir = fixtureDir();
    const l2 = writeFile(
      dir,
      "config.json",
      JSON.stringify({ catalyst: { linear: { bot: { orchestrator: '{"apiKey":"x"}' } } } }),
    );
    const r = resolveSecret("linear-orchestrator-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: '{"apiKey":"x"}', source: "config-json" });
  });
  test("groq-api-key prefers the env alias over the config path (matches resolveApiKey's env-first precedence)", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ groq: { apiKey: "from-config" } }));
    const r = resolveSecret("groq-api-key", {
      env: { CATALYST_LAYER2_CONFIG_FILE: l2, GROQ_API_KEY: "from-env" },
    });
    expect(r).toMatchObject({ value: "from-env", source: "inherited" });
  });
  test("groq-api-key falls back to config when env is unset", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ groq: { apiKey: "from-config" } }));
    const r = resolveSecret("groq-api-key", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: "from-config", source: "config-json" });
  });
  test("a non-string JSON value at the path (BLOCKING-1 class: bare `false`) settles as none, never silently coerced", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ groq: { apiKey: false } }));
    const r = resolveSecret("groq-api-key", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: null, source: "none" });
  });
  test("absent path falls through to none", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({}));
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: null, source: "none" });
  });
});

describe("resolveSecret — platform-env delivery (cloud-token)", () => {
  test("default name, value from that env var", () => {
    const r = resolveSecret("cloud-token", { env: { CATALYST_CLOUD_TOKEN: "cloud-val" } });
    expect(r).toMatchObject({ value: "cloud-val", source: "platform-env", envVar: "CATALYST_CLOUD_TOKEN", envVarSource: "default" });
  });
  test("CATALYST_CLOUD_TOKEN_ENV overrides the NAME", () => {
    const r = resolveSecret("cloud-token", { env: { CATALYST_CLOUD_TOKEN_ENV: "MY_TOKEN", MY_TOKEN: "v" } });
    expect(r).toMatchObject({ value: "v", envVar: "MY_TOKEN", envVarSource: "env" });
  });
  test("Layer-2 catalyst.cloud.tokenEnv overrides the NAME when env override absent", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ catalyst: { cloud: { tokenEnv: "OTHER_VAR" } } }));
    const r = resolveSecret("cloud-token", { env: { CATALYST_LAYER2_CONFIG_FILE: l2, OTHER_VAR: "v2" } });
    expect(r).toMatchObject({ value: "v2", envVar: "OTHER_VAR", envVarSource: "layer2" });
  });
  test("name resolves but the var is unset ⇒ none (still reports the resolved name)", () => {
    const r = resolveSecret("cloud-token", { env: {} });
    expect(r).toMatchObject({ value: null, source: "none", envVar: "CATALYST_CLOUD_TOKEN", envVarSource: "default" });
  });
});

describe("resolveSecret — local-only delivery (age-key), never fetched", () => {
  test("presence — default path under HOME", () => {
    const dir = fixtureDir();
    writeFile(dir, ".config/catalyst/age.key", "AGE-SECRET-KEY-fake");
    const r = resolveSecret("age-key", { env: { HOME: dir } });
    expect(r.source).toBe("present");
    expect(r.value).toBe(resolve(dir, ".config", "catalyst", "age.key"));
  });
  test("absence", () => {
    const dir = fixtureDir();
    const r = resolveSecret("age-key", { env: { HOME: dir } });
    expect(r).toMatchObject({ value: null, source: "absent" });
  });
  test("SOPS_AGE_KEY_FILE override is honored", () => {
    const dir = fixtureDir();
    const f = writeFile(dir, "custom/age.key", "AGE-SECRET-KEY-fake");
    const r = resolveSecret("age-key", { env: { HOME: dir, SOPS_AGE_KEY_FILE: f } });
    expect(r).toMatchObject({ value: f, source: "present" });
  });
  test("never reads the file's contents — a directory at the path (unreadable as a key) settles absent, not a crash", () => {
    const dir = fixtureDir();
    mkdirSync(resolve(dir, ".config", "catalyst", "age.key"), { recursive: true });
    const r = resolveSecret("age-key", { env: { HOME: dir } });
    expect(r).toMatchObject({ value: null, source: "absent" });
  });
});

describe("resolveSecret — cloud guard (design §4)", () => {
  test("mode:cloud but inferred:true does NOT activate the cloud branch — file chain still runs", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", "file-value");
    const r = resolveSecret("github-token", {
      env: { CATALYST_CONFIG_DIR: dir },
      deploymentMode: { mode: "cloud", inferred: true },
    });
    expect(r).toMatchObject({ value: "file-value", source: "shared-file" });
  });
  test("mode:single-host never activates cloud, even with envNames coincidentally set", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", "file-value");
    const r = resolveSecret("github-token", {
      env: { CATALYST_CONFIG_DIR: dir, GH_TOKEN: "env-value-should-not-win" },
      deploymentMode: { mode: "single-host", inferred: true },
    });
    expect(r.value).toBe("file-value");
  });
  test("mode:cluster never activates cloud — same file chain as single-host (design §4: zero new cluster resolution code)", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", "file-value");
    const r = resolveSecret("github-token", {
      env: { CATALYST_CONFIG_DIR: dir },
      deploymentMode: { mode: "cluster", inferred: false },
    });
    expect(r.value).toBe("file-value");
  });
  test("genuinely cloud (inferred:false) short-circuits to env-alias ONLY — the file is never consulted, even when it would have resolved", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", "file-value-must-be-ignored");
    const r = resolveSecret("github-token", {
      env: { CATALYST_CONFIG_DIR: dir, CATALYST_CLOUD_TOKEN: "boot" },
      deploymentMode: { mode: "cloud", inferred: false },
    });
    expect(r.value).toBeNull(); // no GH_TOKEN/GITHUB_TOKEN env set — file MUST be ignored
    expect(r.source).toBe("none");
  });
  test("genuinely cloud with the env alias present resolves via env, not the file", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", "file-value-must-be-ignored");
    const r = resolveSecret("github-token", {
      env: { CATALYST_CONFIG_DIR: dir, GH_TOKEN: "cloud-injected", CATALYST_CLOUD_TOKEN: "boot" },
      deploymentMode: { mode: "cloud", inferred: false },
    });
    expect(r).toMatchObject({ value: "cloud-injected", provider: "bare-file" });
  });
  test("bootstrap short-circuit: cloud-token itself absent ⇒ every OTHER row's cloud resolution is null/null, without probing further", () => {
    const r = resolveSecret("github-token", {
      env: { GH_TOKEN: "should-not-be-returned" },
      deploymentMode: { mode: "cloud", inferred: false },
    });
    expect(r).toEqual({ value: null, source: null, provider: "bare-file", rotation: expect.any(Object) });
  });
  test("bootstrap short-circuit does not apply to cloud-token itself", () => {
    const r = resolveSecret("cloud-token", { env: {}, deploymentMode: { mode: "cloud", inferred: false } });
    expect(r.source).toBe("none"); // resolves normally (absent), not short-circuited to null/null-provider
    expect(r.provider).toBe("platform-env");
  });
});

// ─── Registry validation (design §6) ─────────────────────────────────────────────────────
describe("registry validation (§6) — the rearm-hook honesty rules", () => {
  test("capability ceiling: registerRearmHook rejects a hook against any row whose declared rotation.class !== 're-armable'", () => {
    const boot = SECRET_REGISTRY.filter((r) => r.rotation.class === "boot-only");
    expect(boot.length).toBeGreaterThan(0);
    for (const row of boot) {
      expect(registerRearmHook(row.id, () => ({ rearmed: true }))).toBe(false);
    }
    const localOnly = SECRET_REGISTRY.find((r) => r.rotation.class === "n/a");
    expect(registerRearmHook(localOnly.id, () => ({ rearmed: true }))).toBe(false);
  });

  test("registerRearmHook rejects an unknown id or a non-function", () => {
    expect(registerRearmHook("does-not-exist", () => ({ rearmed: true }))).toBe(false);
    expect(registerRearmHook("github-token", "not-a-function")).toBe(false);
    expect(registerRearmHook("github-token", null)).toBe(false);
  });

  test("PR1 STATE (self-documenting, expected to shrink as later PRs wire real hooks): every SEED re-armable row currently has NO hook registered, so armSecret degrades ALL of them to the same shape a boot-only row gets", () => {
    const reArmable = SECRET_REGISTRY.filter((r) => r.rotation.class === "re-armable");
    expect(reArmable.map((r) => r.id).sort()).toEqual(
      ["github-token", "linear-api-token", "linear-orchestrator-actor"].sort(),
    );
    for (const row of reArmable) {
      const env = { PROBE_UNSET_VAR_FOR_TEST: "x" }; // resolves to none for every one of these rows
      const first = armSecret(row.id, { env });
      expect(first).toEqual({ armed: false, rotated: false, restartRequired: false });
    }
  });

  test("hookless re-armable row degrades EXACTLY like a boot-only row: restartRequired flips true iff the resolved value changed (Gherkin Scenario 2, proven before any real hook exists)", () => {
    const dir = fixtureDir();
    const f = writeFile(dir, "linear-orchestrator.json", JSON.stringify({ catalyst: { linear: { bot: { orchestrator: "cred-v1" } } } }));
    const env = { CATALYST_LAYER2_CONFIG_FILE: f };
    expect(armSecret("linear-orchestrator-actor", { env })).toEqual({ armed: false, rotated: false, restartRequired: false });
    expect(armSecret("linear-orchestrator-actor", { env })).toEqual({ armed: false, rotated: false, restartRequired: false });
    writeFileSync(f, JSON.stringify({ catalyst: { linear: { bot: { orchestrator: "cred-v2-rotated" } } } }));
    expect(armSecret("linear-orchestrator-actor", { env })).toEqual({ armed: false, rotated: true, restartRequired: true });
  });

  test("once a hook IS registered (simulating a later PR), armSecret switches to the hook path: armed:true, restartRequired ALWAYS false (in-process rearm needs no restart)", () => {
    let calls = 0;
    registerRearmHook("github-token", ({ env }) => {
      calls += 1;
      return { rearmed: true, reason: "test-hook" };
    });
    const result = armSecret("github-token", { env: {} });
    expect(result).toEqual({ armed: true, rotated: true, restartRequired: false });
    expect(calls).toBe(1);
  });

  test("hook path: rearmed:false from the hook reports no rotation", () => {
    registerRearmHook("github-token", () => ({ rearmed: false, reason: "unchanged" }));
    expect(armSecret("github-token", { env: {} })).toEqual({ armed: false, rotated: false, restartRequired: false });
  });

  test("hook path: a throwing hook is swallowed, never propagates (armSecret never throws)", () => {
    registerRearmHook("github-token", () => {
      throw new Error("boom");
    });
    expect(() => armSecret("github-token", { env: {} })).not.toThrow();
    expect(armSecret("github-token", { env: {} })).toEqual({ armed: false, rotated: false, restartRequired: false });
  });

  test("clearRearmHook removes a registered hook and armSecret reverts to the hookless-degrade path", () => {
    registerRearmHook("github-token", () => ({ rearmed: true }));
    expect(clearRearmHook("github-token")).toBe(true);
    expect(clearRearmHook("github-token")).toBe(false); // already removed
    const env = {};
    armSecret("github-token", { env }); // establishes baseline via the degrade path
    const r = armSecret("github-token", { env });
    expect(r.armed).toBe(false); // hook path never entered
  });
});

describe("armSecret — n/a rows and unknown ids", () => {
  test("age-key (rotation.class n/a) is always a no-op, regardless of presence changes", () => {
    expect(armSecret("age-key", { env: {} })).toEqual({ armed: false, rotated: false, restartRequired: false });
  });
  test("unknown id never throws", () => {
    expect(armSecret("does-not-exist", { env: {} })).toEqual({ armed: false, rotated: false, restartRequired: false });
  });
});

describe("resetArmState", () => {
  test("resets a single row's baseline", () => {
    const env = { CATALYST_CONFIG_DIR: fixtureDir(), GH_TOKEN: "v1" };
    armSecret("github-token", { env });
    resetArmState("github-token");
    const env2 = { ...env, GH_TOKEN: "v2" };
    // With the baseline cleared, this call re-establishes rather than reporting a rotation.
    expect(armSecret("github-token", { env: env2 })).toEqual({ armed: false, rotated: false, restartRequired: false });
  });
  test("resets every row's baseline when called with no id", () => {
    armSecret("github-token", { env: {} });
    armSecret("linear-api-token", { env: {} });
    resetArmState();
    expect(armSecret("github-token", { env: { GH_TOKEN: "x" } })).toEqual({ armed: false, rotated: false, restartRequired: false });
  });
});
