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
  resolveLegacyPerTeamConfigPath,
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
  test("12 seed rows, matching the design §2 seed table (+ linear-linearis-actor)", () => {
    expect(SECRET_REGISTRY.length).toBe(12);
    expect(SECRET_REGISTRY.map((r) => r.id)).toEqual([
      "github-token",
      "webhook-secret",
      "linear-webhook-secret",
      "claude-accounts.env",
      "execution-core.env",
      "linear-api-token",
      "linear-orchestrator-actor",
      "linear-linearis-actor",
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
    expect(SECRET_REGISTRY.length).toBe(12); // +linear-linearis-actor
  });

  test("DEEP-FREEZE (Codex finding fix): every row's NESTED envNames array is also frozen, not just the outer row object", () => {
    for (const row of SECRET_REGISTRY) {
      expect(Object.isFrozen(row.envNames)).toBe(true);
      expect(() => {
        row.envNames.push("EVIL_ALIAS");
      }).toThrow();
    }
  });

  test("DEEP-FREEZE: every row's NESTED rotation object is also frozen — mutating it cannot permanently alter later resolution/hook/arm behavior", () => {
    const row = getSecretRow("github-token");
    expect(Object.isFrozen(row.rotation)).toBe(true);
    expect(() => {
      row.rotation.class = "boot-only";
    }).toThrow();
    // The registry itself is unaffected regardless — re-reading the row shows the original.
    expect(getSecretRow("github-token").rotation.class).toBe("re-armable");
  });

  test("DEEP-FREEZE: age-key's nested defaultLocalPath array is frozen", () => {
    const row = getSecretRow("age-key");
    expect(Object.isFrozen(row.defaultLocalPath)).toBe(true);
    expect(() => {
      row.defaultLocalPath.push("evil");
    }).toThrow();
  });

  test("DEEP-FREEZE: resolveSecret never returns a mutable live rotation reference — the caller cannot corrupt later resolutions for the same id", () => {
    const r1 = resolveSecret("github-token", { env: {} });
    expect(Object.isFrozen(r1.rotation)).toBe(true);
    expect(() => {
      r1.rotation.class = "hacked";
    }).toThrow();
    const r2 = resolveSecret("github-token", { env: {} });
    expect(r2.rotation.class).toBe("re-armable");
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

  test("linear-linearis-actor is a separate row from linear-orchestrator-actor / linear-worker-actor (same shape as that pair)", () => {
    const linearis = getSecretRow("linear-linearis-actor");
    const orch = getSecretRow("linear-orchestrator-actor");
    const worker = getSecretRow("linear-worker-actor");
    expect(linearis).toBeDefined();
    expect(linearis.configJsonPath).toBe("catalyst.linear.bot.linearis");
    expect(linearis.envNames).toEqual([]);
    expect(linearis.delivery).toBe("config-json");
    expect(linearis.configJsonPath).not.toBe(orch.configJsonPath);
    expect(linearis.configJsonPath).not.toBe(worker.configJsonPath);
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
  test("NON-UTF-8 BYTES (Codex finding fix): a file whose bytes are not valid UTF-8 is REJECTED consistently — never silently served as a U+FFFD-mutated credential — falls through to env alias", () => {
    const dir = fixtureDir();
    // 0xFF 0xFE is not a valid UTF-8 byte sequence anywhere; readFileSync(...,"utf8") would
    // silently replace it with U+FFFD U+FFFD without this guard.
    writeFile(dir, "github-token", Buffer.from([0xff, 0xfe, 0x68, 0x69]));
    const r = resolveSecret("github-token", { env: { CATALYST_CONFIG_DIR: dir, GH_TOKEN: "fallback-after-bad-utf8" } });
    expect(r).toMatchObject({ value: "fallback-after-bad-utf8", source: "inherited" });
  });
  test("valid multi-byte UTF-8 (e.g. an emoji/check-mark in a token) is preserved, not rejected", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", Buffer.from("tok-✓-value\n", "utf8"));
    const r = resolveSecret("github-token", { env: { CATALYST_CONFIG_DIR: dir } });
    expect(r).toMatchObject({ value: "tok-✓-value", source: "shared-file" });
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
  test("ACTOR ROW SHAPE (Codex finding fix): the AUTHORITATIVE Layer-2 schema stores catalyst.linear.bot.orchestrator as an OBJECT ({clientId, clientSecret, ...}), never a string — the pre-fix test here fixtured a string CONTAINING json text, masking that resolveConfigJson only accepted strings and every real production config resolved to none", () => {
    const dir = fixtureDir();
    const l2 = writeFile(
      dir,
      "config.json",
      JSON.stringify({
        catalyst: { linear: { bot: { orchestrator: { clientSecret: "s3cr3t", clientId: "abc123" } } } },
      }),
    );
    const r = resolveSecret("linear-orchestrator-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r.source).toBe("config-json");
    // Canonicalized (sorted-key) so both languages produce the identical byte string
    // regardless of source field order.
    expect(r.value).toBe('{"clientId":"abc123","clientSecret":"s3cr3t"}');
    // The row's value semantics must let a future consumer extract clientId/clientSecret.
    expect(JSON.parse(r.value)).toEqual({ clientId: "abc123", clientSecret: "s3cr3t" });
  });
  test("reads the dotted path from the Layer-2 file (string-shaped config-json value, e.g. groq-api-key)", () => {
    const dir = fixtureDir();
    const l2 = writeFile(
      dir,
      "config.json",
      JSON.stringify({ groq: { apiKey: "plain-string-value" } }),
    );
    const r = resolveSecret("groq-api-key", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: "plain-string-value", source: "config-json" });
  });
  test("an EMPTY object at the path resolves to the canonical empty-object string, not silently coerced to none", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ catalyst: { linear: { bot: { orchestrator: {} } } } }));
    const r = resolveSecret("linear-orchestrator-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: "{}", source: "config-json" });
  });
  test("an ARRAY at the path is rejected (not a valid credential shape) — settles as none", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ catalyst: { linear: { bot: { orchestrator: ["nope"] } } } }));
    const r = resolveSecret("linear-orchestrator-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: null, source: "none" });
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
  test("JSON ACCEPTANCE NORMALIZATION (Codex finding fix): an unpaired-surrogate escape ANYWHERE in the document — even outside the field being read — settles the whole layer as malformed (matches jq's whole-document rejection, exit 5)", () => {
    const dir = fixtureDir();
    // The lone \ud800 escape lives in an UNRELATED field; the real value at groq.apiKey is
    // otherwise perfectly valid. jq rejects the ENTIRE document (verified: exit 5) so the
    // bash mirror can never see ANY value out of this file — JS must degrade identically.
    const l2 = writeFile(
      dir,
      "config.json",
      '{"groq":{"apiKey":"from-config"},"unrelated":"clu\\ud800ster"}',
    );
    const r = resolveSecret("groq-api-key", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: null, source: "none" });
  });
  test("linear-linearis-actor resolves catalyst.linear.bot.linearis from the Layer-2 file (same shape as linear-orchestrator-actor)", () => {
    const dir = fixtureDir();
    const l2 = writeFile(
      dir,
      "config.json",
      JSON.stringify({
        catalyst: { linear: { bot: { linearis: { clientId: "fake-client-id", clientSecret: "fake-client-secret" } } } },
      }),
    );
    const r = resolveSecret("linear-linearis-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r.source).toBe("config-json");
    expect(r.value).toBe('{"clientId":"fake-client-id","clientSecret":"fake-client-secret"}');
    expect(JSON.parse(r.value)).toEqual({ clientId: "fake-client-id", clientSecret: "fake-client-secret" });
  });
});

// ─── resolveSecret — linear-worker-actor's CTL-1616 PR4 credentialEnvPair + legacyConfigTiers
// fold (linear-comment-post.sh's THREE config tiers + its env-pair tier, preserved verbatim).
// Every precedence fixture below is mirrored byte-for-byte in
// __tests__/secret-contract-parity.test.sh so bash and JS are proven to agree, not merely
// each internally self-consistent.
describe("resolveSecret — linear-worker-actor credentialEnvPair + legacyConfigTiers (CTL-1616 PR4)", () => {
  test("credentialEnvPair wins over every config tier when both halves are present", () => {
    const dir = fixtureDir();
    const l2 = writeFile(
      dir,
      "config.json",
      JSON.stringify({ catalyst: { linear: { bot: { worker: { clientId: "CFG", clientSecret: "CFGSEC" } } } } }),
    );
    const r = resolveSecret("linear-worker-actor", {
      env: {
        CATALYST_LAYER2_CONFIG_FILE: l2,
        CATALYST_LINEAR_AGENT_CLIENT_ID: "EID",
        CATALYST_LINEAR_AGENT_CLIENT_SECRET: "ESEC",
      },
    });
    expect(r).toMatchObject({ value: '{"clientId":"EID","clientSecret":"ESEC"}', source: "inherited" });
  });

  test("credentialEnvPair with only ONE half set does not win — falls through to the config tiers", () => {
    const dir = fixtureDir();
    const l2 = writeFile(
      dir,
      "config.json",
      JSON.stringify({ catalyst: { linear: { bot: { worker: { clientId: "CFG", clientSecret: "CFGSEC" } } } } }),
    );
    const r = resolveSecret("linear-worker-actor", {
      env: { CATALYST_LAYER2_CONFIG_FILE: l2, CATALYST_LINEAR_AGENT_CLIENT_ID: "EID" },
    });
    expect(r).toMatchObject({ value: '{"clientId":"CFG","clientSecret":"CFGSEC"}', source: "config-json" });
  });

  test("primary configJsonPath (NEW global bot.worker) wins over both legacy tiers when all three are present", () => {
    const dir = fixtureDir();
    const l2 = writeFile(
      dir,
      "config.json",
      JSON.stringify({
        catalyst: {
          linear: {
            bot: { worker: { clientId: "NEW", clientSecret: "NEWSEC" } },
            agent: { clientId: "GLOBALLEGACY", clientSecret: "GLOBALLEGACYSEC" },
          },
        },
      }),
    );
    const repo = resolve(dir, "repo");
    mkdirSync(resolve(repo, ".catalyst"), { recursive: true });
    writeFile(dir, "repo/.catalyst/config.json", JSON.stringify({ catalyst: { projectKey: "proj1" } }));
    writeFile(dir, "config-proj1.json", JSON.stringify({ catalyst: { linear: { agent: { clientId: "PERTEAM", clientSecret: "PERTEAMSEC" } } } }));
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 }, cwd: repo });
    expect(r).toMatchObject({ value: '{"clientId":"NEW","clientSecret":"NEWSEC"}', source: "config-json" });
  });

  test("per-team-legacy tier wins when the primary tier misses (only per-team agent creds present)", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({}));
    const repo = resolve(dir, "repo");
    mkdirSync(resolve(repo, ".catalyst"), { recursive: true });
    writeFile(dir, "repo/.catalyst/config.json", JSON.stringify({ catalyst: { projectKey: "proj1" } }));
    writeFile(dir, "config-proj1.json", JSON.stringify({ catalyst: { linear: { agent: { clientId: "PERTEAM", clientSecret: "PERTEAMSEC" } } } }));
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 }, cwd: repo });
    expect(r).toMatchObject({
      value: '{"clientId":"PERTEAM","clientSecret":"PERTEAMSEC"}',
      source: "legacy-config-json",
      legacyScope: "per-team-legacy",
    });
  });

  test("global-legacy tier wins when the primary tier AND the per-team tier both miss (projectKey resolves, but the per-team file lacks agent creds; only the global file's legacy agent key is set)", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ catalyst: { linear: { agent: { clientId: "GLOBALLEGACY", clientSecret: "GLOBALLEGACYSEC" } } } }));
    const repo = resolve(dir, "repo");
    mkdirSync(resolve(repo, ".catalyst"), { recursive: true });
    writeFile(dir, "repo/.catalyst/config.json", JSON.stringify({ catalyst: { projectKey: "proj1" } }));
    // No config-proj1.json at all — the per-team-legacy tier's own file is simply absent.
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 }, cwd: repo });
    expect(r).toMatchObject({
      value: '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}',
      source: "legacy-config-json",
      legacyScope: "global-legacy",
    });
  });

  test("no projectKey found anywhere in the ancestry: the per-team-legacy tier itself falls back to the canonical global path, so a global-only legacy layout still resolves via legacyScope 'per-team-legacy' (matches the pre-fold script's own fallthrough exactly — tier 2's LAYER2_CONFIG degenerates to the same file tier 3 would have read)", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ catalyst: { linear: { agent: { clientId: "GL", clientSecret: "GLSEC" } } } }));
    const cwdNoAncestry = resolve(dir, "no-ancestry-dir");
    mkdirSync(cwdNoAncestry, { recursive: true });
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 }, cwd: cwdNoAncestry });
    expect(r).toMatchObject({ value: '{"clientId":"GL","clientSecret":"GLSEC"}', source: "legacy-config-json", legacyScope: "per-team-legacy" });
  });

  test("nothing present anywhere (no env pair, no config tiers) resolves to none", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({}));
    const cwdNoAncestry = resolve(dir, "empty-dir");
    mkdirSync(cwdNoAncestry, { recursive: true });
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 }, cwd: cwdNoAncestry });
    expect(r).toMatchObject({ value: null, source: "none" });
  });

  // ─── B1 REGRESSION FIXTURES (CTL-1616 PR4 remediation): the OLD linear-comment-post.sh
  // advanced to the NEXT tier whenever clientId OR clientSecret was empty after a tier's
  // read; canonicalizeConfigJsonValue's "any non-null value wins" rule let a CREDENTIAL-FREE
  // or PARTIALLY-POPULATED object at a tier's path capture resolution instead, silently
  // starving a deeper, fully-populated tier — the caller then hard-failed on the empty
  // fields rather than falling through. Each fixture names the winning tier the OLD script
  // would have picked (the deeper FULL-credential tier) and proves the fixed engine agrees.
  // Mirrored byte-for-byte in __tests__/secret-contract-parity.test.sh and
  // __tests__/catalyst-secret-contract.test.sh.
  test("B1: primary tier holds only clientId (no clientSecret) — per-team-legacy (full) wins, not the partial primary", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ catalyst: { linear: { bot: { worker: { clientId: "partial-cid" } } } } }));
    const repo = resolve(dir, "repo");
    mkdirSync(resolve(repo, ".catalyst"), { recursive: true });
    writeFile(dir, "repo/.catalyst/config.json", JSON.stringify({ catalyst: { projectKey: "proj1" } }));
    writeFile(dir, "config-proj1.json", JSON.stringify({ catalyst: { linear: { agent: { clientId: "PERTEAM", clientSecret: "PERTEAMSEC" } } } }));
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 }, cwd: repo });
    expect(r).toMatchObject({
      value: '{"clientId":"PERTEAM","clientSecret":"PERTEAMSEC"}',
      source: "legacy-config-json",
      legacyScope: "per-team-legacy",
    });
  });

  test("B1: primary tier holds a CREDENTIAL-FREE object ({webhookSecret, botUserId} — a realistic production shape) — per-team-legacy (full) wins", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ catalyst: { linear: { bot: { worker: { webhookSecret: "whs", botUserId: "uuid-123" } } } } }));
    const repo = resolve(dir, "repo");
    mkdirSync(resolve(repo, ".catalyst"), { recursive: true });
    writeFile(dir, "repo/.catalyst/config.json", JSON.stringify({ catalyst: { projectKey: "proj1" } }));
    writeFile(dir, "config-proj1.json", JSON.stringify({ catalyst: { linear: { agent: { clientId: "PERTEAM", clientSecret: "PERTEAMSEC" } } } }));
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 }, cwd: repo });
    expect(r).toMatchObject({
      value: '{"clientId":"PERTEAM","clientSecret":"PERTEAMSEC"}',
      source: "legacy-config-json",
      legacyScope: "per-team-legacy",
    });
  });

  test("B1: primary tier holds empty-string clientId/clientSecret — global-legacy (full) wins", () => {
    const dir = fixtureDir();
    const l2 = writeFile(
      dir,
      "config.json",
      JSON.stringify({
        catalyst: {
          linear: {
            bot: { worker: { clientId: "", clientSecret: "" } },
            agent: { clientId: "GLOBALLEGACY", clientSecret: "GLOBALLEGACYSEC" },
          },
        },
      }),
    );
    const repo = resolve(dir, "repo");
    mkdirSync(resolve(repo, ".catalyst"), { recursive: true });
    writeFile(dir, "repo/.catalyst/config.json", JSON.stringify({ catalyst: { projectKey: "proj-noagent" } }));
    // No config-proj-noagent.json file at all — the per-team-legacy tier's own file is absent,
    // so that tier misses naturally and the chain falls all the way to global-legacy.
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 }, cwd: repo });
    expect(r).toMatchObject({
      value: '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}',
      source: "legacy-config-json",
      legacyScope: "global-legacy",
    });
  });

  test("B1: primary tier absent, per-team-legacy holds only clientId (no clientSecret) — global-legacy (full) wins", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ catalyst: { linear: { agent: { clientId: "GLOBALLEGACY", clientSecret: "GLOBALLEGACYSEC" } } } }));
    const repo = resolve(dir, "repo");
    mkdirSync(resolve(repo, ".catalyst"), { recursive: true });
    writeFile(dir, "repo/.catalyst/config.json", JSON.stringify({ catalyst: { projectKey: "proj1" } }));
    writeFile(dir, "config-proj1.json", JSON.stringify({ catalyst: { linear: { agent: { clientId: "pid-only" } } } }));
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 }, cwd: repo });
    expect(r).toMatchObject({
      value: '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}',
      source: "legacy-config-json",
      legacyScope: "global-legacy",
    });
  });

  // ─── B2 REGRESSION FIXTURE: no prior fixture populated BOTH legacy tiers with DISTINCT
  // credentials at once, so a swap of _CSC_LEGACY_TIERS's order survived every suite. This
  // fixture pins per-team-legacy BEFORE global-legacy — see the "MUTATION TEST" section in
  // __tests__/catalyst-secret-contract.test.sh, which actually swaps the bash array order,
  // confirms this exact scenario's bash cell fails, then restores it.
  test("B2: BOTH legacy tiers present with DISTINCT full credentials — per-team-legacy wins (pins tier ORDER: per-team before global)", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ catalyst: { linear: { agent: { clientId: "GLOBALAGENT", clientSecret: "GLOBALAGENTSEC" } } } }));
    const repo = resolve(dir, "repo");
    mkdirSync(resolve(repo, ".catalyst"), { recursive: true });
    writeFile(dir, "repo/.catalyst/config.json", JSON.stringify({ catalyst: { projectKey: "proj1" } }));
    writeFile(dir, "config-proj1.json", JSON.stringify({ catalyst: { linear: { agent: { clientId: "TEAMAGENT", clientSecret: "TEAMAGENTSEC" } } } }));
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 }, cwd: repo });
    expect(r).toMatchObject({
      value: '{"clientId":"TEAMAGENT","clientSecret":"TEAMAGENTSEC"}',
      source: "legacy-config-json",
      legacyScope: "per-team-legacy",
    });
  });

  // ─── ROUND-2 B3 REGRESSION FIXTURES (both shapes empirically pinned against
  // `git show origin/main:.../linear-comment-post.sh` in a hermetic fixture — see the
  // requiredObjectFields row-field comment in secret-contract.mjs for the two canon rules and
  // their pre-fold empirical results). Mirrored byte-for-byte in
  // __tests__/secret-contract-parity.test.sh and __tests__/catalyst-secret-contract.test.sh.
  // Each fixture ALSO populates a real legacy tier, so the assertion proves genuine
  // FALL-THROUGH to a deeper tier — not merely "resolves to none" (which a totally broken
  // engine could also produce).
  test("CANON RULE 1: a bare STRING value at the primary tier's path — even one whose OWN TEXT parses as a full {clientId,clientSecret} object — falls through to the next tier, never wins on string content", () => {
    const dir = fixtureDir();
    const l2 = writeFile(
      dir,
      "config.json",
      JSON.stringify({
        catalyst: {
          linear: {
            bot: { worker: '{"clientId":"str-cid","clientSecret":"str-csec"}' },
            agent: { clientId: "GLOBALLEGACY", clientSecret: "GLOBALLEGACYSEC" },
          },
        },
      }),
    );
    const cwdNoAncestry = resolve(dir, "no-ancestry-dir");
    mkdirSync(cwdNoAncestry, { recursive: true });
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 }, cwd: cwdNoAncestry });
    expect(r).toMatchObject({
      value: '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}',
      source: "legacy-config-json",
    });
  });

  test("CANON RULE 2: newline-only clientId/clientSecret at the primary tier ('\\n', which the OLD script's $() capture stripped to empty) falls through to the next tier, never wins on raw non-zero length", () => {
    const dir = fixtureDir();
    const l2 = writeFile(
      dir,
      "config.json",
      JSON.stringify({
        catalyst: {
          linear: {
            bot: { worker: { clientId: "\n", clientSecret: "\n" } },
            agent: { clientId: "GLOBALLEGACY", clientSecret: "GLOBALLEGACYSEC" },
          },
        },
      }),
    );
    const cwdNoAncestry = resolve(dir, "no-ancestry-dir-2");
    mkdirSync(cwdNoAncestry, { recursive: true });
    const r = resolveSecret("linear-worker-actor", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 }, cwd: cwdNoAncestry });
    expect(r).toMatchObject({
      value: '{"clientId":"GLOBALLEGACY","clientSecret":"GLOBALLEGACYSEC"}',
      source: "legacy-config-json",
    });
  });
});

describe("resolveLegacyPerTeamConfigPath — linear-comment-post.sh's _find_layer2_config, CTL-1616 PR4", () => {
  test("nested .catalyst.projectKey resolves to a sibling config-<key>.json next to the canonical Layer-2 path", () => {
    const dir = fixtureDir();
    const l2 = resolve(dir, "config.json");
    const repo = resolve(dir, "a", "b", "repo");
    mkdirSync(resolve(repo, ".catalyst"), { recursive: true });
    writeFileSync(resolve(repo, ".catalyst", "config.json"), JSON.stringify({ catalyst: { projectKey: "proj1" } }));
    const path = resolveLegacyPerTeamConfigPath({ CATALYST_LAYER2_CONFIG_FILE: l2 }, repo);
    expect(path).toBe(resolve(dir, "config-proj1.json"));
  });

  test("bare top-level .projectKey (legacy layout) is also honored", () => {
    const dir = fixtureDir();
    const l2 = resolve(dir, "config.json");
    const repo = resolve(dir, "repo");
    mkdirSync(resolve(repo, ".catalyst"), { recursive: true });
    writeFileSync(resolve(repo, ".catalyst", "config.json"), JSON.stringify({ projectKey: "legacy-key" }));
    const path = resolveLegacyPerTeamConfigPath({ CATALYST_LAYER2_CONFIG_FILE: l2 }, repo);
    expect(path).toBe(resolve(dir, "config-legacy-key.json"));
  });

  test("walks past a malformed ancestor .catalyst/config.json to find a projectKey further up", () => {
    const dir = fixtureDir();
    const l2 = resolve(dir, "config.json");
    const mid = resolve(dir, "mid");
    const leaf = resolve(mid, "leaf");
    mkdirSync(resolve(mid, ".catalyst"), { recursive: true });
    mkdirSync(resolve(leaf, ".catalyst"), { recursive: true });
    writeFileSync(resolve(leaf, ".catalyst", "config.json"), "not-json");
    writeFileSync(resolve(mid, ".catalyst", "config.json"), JSON.stringify({ catalyst: { projectKey: "mid-key" } }));
    const path = resolveLegacyPerTeamConfigPath({ CATALYST_LAYER2_CONFIG_FILE: l2 }, leaf);
    expect(path).toBe(resolve(dir, "config-mid-key.json"));
  });

  test("no projectKey found anywhere in the ancestry falls back to the canonical global path itself", () => {
    const dir = fixtureDir();
    const l2 = resolve(dir, "config.json");
    const noAncestry = resolve(dir, "no", "ancestry", "dir");
    mkdirSync(noAncestry, { recursive: true });
    const path = resolveLegacyPerTeamConfigPath({ CATALYST_LAYER2_CONFIG_FILE: l2 }, noAncestry);
    expect(path).toBe(l2);
  });
});

// hasLiveLoneHighSurrogateEscape is an unexported module-internal helper (same convention as
// every other readJsonField primitive in this file — containsNul, stripEol, etc. are never
// exported either); these tests exercise its documented semantics through the one public
// boundary that observes it, resolveSecret's config-json path, exactly like the "JSON
// ACCEPTANCE NORMALIZATION" test right above. Verified against real jq 1.7.1 throughout (see
// the scanner's own doc comment in lib/secret-contract.mjs for the exact jq invocations).
describe("hasLiveLoneHighSurrogateEscape scanner — E4/E6 jq parity", () => {
  test("odd backslash run (length 1) before a HIGH surrogate escape is LIVE; unpaired ⇒ rejects the whole document (E4/control)", () => {
    const dir = fixtureDir();
    const l2 = writeFile(
      dir,
      "config.json",
      '{"groq":{"apiKey":"good"},"unrelated":"clu\\ud800ster"}',
    );
    const r = resolveSecret("groq-api-key", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: null, source: "none" });
  });

  test("odd backslash run (length 1) before a LOW surrogate escape is LIVE; lone LOW is ACCEPTED (jq exit 0), not rejected (E4a)", () => {
    const dir = fixtureDir();
    const l2 = writeFile(
      dir,
      "config.json",
      '{"groq":{"apiKey":"good"},"unrelated":"clu\\udc00ster"}',
    );
    const r = resolveSecret("groq-api-key", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: "good", source: "config-json" });
  });

  test("even backslash run (length 2) before 'u' is NOT live — it is an escaped literal backslash followed by ordinary text; the document is not rejected (E6)", () => {
    const dir = fixtureDir();
    // Raw file text carries the LITERAL 7-character sequence \\ud800 (escaped backslash +
    // the 5 literal characters "ud800") — valid JSON, and not an escape at all.
    const l2 = writeFile(
      dir,
      "config.json",
      '{"groq":{"apiKey":"good"},"unrelated":"literal \\\\ud800 text"}',
    );
    const r = resolveSecret("groq-api-key", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: "good", source: "config-json" });
    // The literal backslash+text itself round-trips untouched when it IS the read field.
    const l2b = writeFile(
      dir,
      "config2.json",
      '{"groq":{"apiKey":"literal \\\\ud800 text"}}',
    );
    const r2 = resolveSecret("groq-api-key", { env: { CATALYST_LAYER2_CONFIG_FILE: l2b } });
    expect(r2).toMatchObject({ value: "literal \\ud800 text", source: "config-json" });
  });

  test("a live HIGH surrogate escape immediately (textually adjacent) followed by a live LOW surrogate escape is a paired astral character — accepted, not rejected", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", '{"groq":{"apiKey":"x\\ud800\\udc00y"}}');
    const r = resolveSecret("groq-api-key", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: "x\u{10000}y", source: "config-json" });
  });

  test("a live HIGH surrogate escape NOT textually adjacent to a following LOW escape remains unpaired — rejects the document", () => {
    const dir = fixtureDir();
    // A literal "Y" sits between the two escapes, breaking adjacency.
    const l2 = writeFile(dir, "config.json", '{"groq":{"apiKey":"x\\ud800Y\\udc00y"}}');
    const r = resolveSecret("groq-api-key", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: null, source: "none" });
  });

  test("a live HIGH surrogate escape immediately followed by a NON-live (even-backslash-run) low-looking escape remains unpaired — rejects the document", () => {
    const dir = fixtureDir();
    // "\ud800" (live, HIGH) directly followed by "\\udc00" (even run — literal text, not an
    // escape) — the pairing candidate must itself be LIVE to count, so this does not pair.
    const l2 = writeFile(dir, "config.json", '{"groq":{"apiKey":"x\\ud800\\\\udc00y"}}');
    const r = resolveSecret("groq-api-key", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: null, source: "none" });
  });

  test("a live lone LOW surrogate escape INSIDE the resolved value itself is normalized to U+FFFD at the value-extraction boundary, mirroring jq's own replacement (E4b)", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", '{"groq":{"apiKey":"x\\udc00y"}}');
    const r = resolveSecret("groq-api-key", { env: { CATALYST_LAYER2_CONFIG_FILE: l2 } });
    expect(r).toMatchObject({ value: "x�y", source: "config-json" });
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
  test("CLOUD-TOKEN NAME OVERRIDE (Codex finding fix): genuine cloud mode honors CATALYST_CLOUD_TOKEN_ENV, not only the hardcoded default name — a direct resolveSecret('cloud-token', {deploymentMode}) call previously bypassed resolveCloudTokenName entirely", () => {
    const r = resolveSecret("cloud-token", {
      env: { CATALYST_CLOUD_TOKEN_ENV: "MY_PLATFORM_TOKEN", MY_PLATFORM_TOKEN: "the-real-token" },
      deploymentMode: { mode: "cloud", inferred: false },
    });
    expect(r).toMatchObject({ value: "the-real-token", source: "platform-env", envVar: "MY_PLATFORM_TOKEN", envVarSource: "env" });
  });
  test("CLOUD-TOKEN NAME OVERRIDE: genuine cloud mode honors the Layer-2 catalyst.cloud.tokenEnv override too", () => {
    const dir = fixtureDir();
    const l2 = writeFile(dir, "config.json", JSON.stringify({ catalyst: { cloud: { tokenEnv: "OTHER_TOKEN_VAR" } } }));
    const r = resolveSecret("cloud-token", {
      env: { CATALYST_LAYER2_CONFIG_FILE: l2, OTHER_TOKEN_VAR: "v2" },
      deploymentMode: { mode: "cloud", inferred: false },
    });
    expect(r).toMatchObject({ value: "v2", source: "platform-env", envVar: "OTHER_TOKEN_VAR", envVarSource: "layer2" });
  });
  test("CLOUD-TOKEN NAME OVERRIDE: an overridden name with only the DEFAULT var set (not the override) still resolves none — the override name is genuinely the one consulted, not silently ignored in favor of the default", () => {
    const r = resolveSecret("cloud-token", {
      env: { CATALYST_CLOUD_TOKEN_ENV: "MY_PLATFORM_TOKEN", CATALYST_CLOUD_TOKEN: "should-not-be-used" },
      deploymentMode: { mode: "cloud", inferred: false },
    });
    expect(r).toMatchObject({ value: null, source: "none", envVar: "MY_PLATFORM_TOKEN" });
  });

  // CTL-1616 PR6 (design §12 Q3 belt-and-suspenders extension): mode==="cloud" &&
  // inferred===false && recognized===false cannot actually be produced by the real
  // resolveDeploymentMode (classifyCandidate degrades an unrecognized explicit value's
  // MODE to single-host before this ever sees "cloud") — so this exercises a
  // hand-constructed deploymentMode object, proving the engine's OWN defense-in-depth
  // guard, independent of whether any real caller can currently reach it.
  test("recognized:false does NOT activate the cloud branch even with mode:cloud and inferred:false — the file chain still runs", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", "file-value");
    const r = resolveSecret("github-token", {
      env: { CATALYST_CONFIG_DIR: dir, GH_TOKEN: "env-value-should-not-win" },
      deploymentMode: { mode: "cloud", inferred: false, recognized: false },
    });
    expect(r).toMatchObject({ value: "file-value", source: "shared-file" });
  });
  test("recognized:undefined (omitted) still activates cloud — the guard is ADDITIVE, not a new required field (backward compat with every pre-existing caller)", () => {
    const r = resolveSecret("github-token", {
      env: { GH_TOKEN: "should-not-be-returned" },
      deploymentMode: { mode: "cloud", inferred: false },
    });
    // Same bootstrap short-circuit result as the "recognized omitted" tests above —
    // proves cloud activated (no cloud-token bootstrap ⇒ short-circuit to null/null).
    expect(r).toEqual({ value: null, source: null, provider: "bare-file", rotation: expect.any(Object) });
  });
  test("recognized:true (explicit) activates cloud exactly like recognized omitted", () => {
    const r = resolveSecret("github-token", {
      env: { GH_TOKEN: "cloud-injected", CATALYST_CLOUD_TOKEN: "boot" },
      deploymentMode: { mode: "cloud", inferred: false, recognized: true },
    });
    expect(r).toMatchObject({ value: "cloud-injected", provider: "bare-file" });
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

  test("IN THIS ZERO-IMPORT LEAF (no consumer imported, this file's own beforeEach clears every hook): every SEED re-armable row degrades to the hookless shape a boot-only row gets — the underlying degrade mechanism, proven independently of any production wiring", () => {
    // UPDATE (CTL-1616 PR4, exactly the update this test's own PR1-era comment anticipated:
    // "that list must shrink as later PRs call registerRearmHook, and the test will need
    // updating then — that is by design, not an oversight"): linear-orchestrator-actor now
    // HAS a real production hook — registered in execution-core/linear-remint.mjs against
    // the process-wide linearReminter singleton (see linear-remint.test.mjs's own
    // "rearm-hook wiring" suite for that integration, exercised with an injected fake
    // reminter — never the real singleton, to avoid a hermetic test triggering a genuine
    // network mint). UPDATE (CTL-1623): github-token ALSO now has a real production hook —
    // registered in execution-core/daemon.mjs at module scope
    // (registerRearmHook("github-token", ...), wrapping rearmGithubTokenFromFile), so it
    // joins linear-orchestrator-actor as no longer genuinely hookless anywhere in the
    // codebase. This file stays a zero-import leaf and never imports daemon.mjs or
    // linear-remint.mjs, so from ITS isolated perspective (and this describe block's own
    // beforeEach, which unconditionally clears every row's hook before each test) every
    // re-armable row still degrades identically here — this test proves that degrade
    // mechanism in isolation, not "no hook exists anywhere in the codebase" (which is no
    // longer true for linear-orchestrator-actor OR github-token). Only linear-api-token
    // remains genuinely hookless everywhere in the codebase as of this PR.
    // UPDATE: linear-linearis-actor joins the re-armable list (same rotation
    // class as linear-orchestrator-actor, per the design §2 pattern that row's own comment
    // documents) — it has no production rearm hook either, same hookless-here status as
    // linear-worker-actor and every other re-armable row this test exercises.
    const reArmable = SECRET_REGISTRY.filter((r) => r.rotation.class === "re-armable");
    expect(reArmable.map((r) => r.id).sort()).toEqual(
      ["github-token", "linear-api-token", "linear-linearis-actor", "linear-orchestrator-actor"].sort(),
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

describe("armSecret — deployment-mode threading (Codex finding fix, design §8)", () => {
  test("cloud mode with an injected env token AND a stale local file: arm's baseline matches DIRECT resolution (the env value), not the file — a file-only edit must not report a false restartRequired, and the real env rotation MUST be detected", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", "stale-file-value-v1");
    const deploymentMode = { mode: "cloud", inferred: false };
    const env1 = { CATALYST_CONFIG_DIR: dir, GH_TOKEN: "cloud-injected-v1", CATALYST_CLOUD_TOKEN: "boot" };

    // Direct resolution (the ground truth armSecret's baseline must match) resolves via the
    // env alias, never the file, in genuine cloud mode.
    const direct = resolveSecret("github-token", { env: env1, deploymentMode });
    expect(direct).toMatchObject({ value: "cloud-injected-v1", source: "inherited" });

    // First arm call establishes the baseline.
    expect(armSecret("github-token", { env: env1, deploymentMode })).toEqual({
      armed: false,
      rotated: false,
      restartRequired: false,
    });

    // Rewriting the STALE FILE ONLY must NOT be observed as a rotation — the arm baseline is
    // the env-derived value, exactly like direct resolution, never the file's contents.
    writeFileSync(resolve(dir, "github-token"), "stale-file-value-v2-changed");
    expect(armSecret("github-token", { env: env1, deploymentMode })).toEqual({
      armed: false,
      rotated: false,
      restartRequired: false,
    });

    // Rotating the ACTUAL cloud-injected env value MUST be detected.
    const env2 = { ...env1, GH_TOKEN: "cloud-injected-v2-rotated" };
    expect(armSecret("github-token", { env: env2, deploymentMode })).toEqual({
      armed: false,
      rotated: true,
      restartRequired: true,
    });
  });

  test("omitting deploymentMode entirely preserves today's non-cloud behavior exactly (default parity with resolveSecret's own default)", () => {
    const dir = fixtureDir();
    writeFile(dir, "github-token", "file-v1");
    const env = { CATALYST_CONFIG_DIR: dir };
    expect(armSecret("github-token", { env })).toEqual({ armed: false, rotated: false, restartRequired: false });
    writeFileSync(resolve(dir, "github-token"), "file-v2");
    expect(armSecret("github-token", { env })).toEqual({ armed: false, rotated: true, restartRequired: true });
  });

  test("hook path also receives deploymentMode in its context object", () => {
    let received;
    registerRearmHook("github-token", (ctx) => {
      received = ctx;
      return { rearmed: true };
    });
    const deploymentMode = { mode: "cluster", inferred: false };
    armSecret("github-token", { env: {}, deploymentMode });
    expect(received.deploymentMode).toEqual(deploymentMode);
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
