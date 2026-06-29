// cluster-sync.test.mjs — CTL-1211. Hermetic: injects the sops-decrypt and git
// runners so no real sops binary, age key, or network is needed.
//
// Run: cd plugins/dev/scripts/execution-core && bun test cluster-sync.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  syncClusterSecrets,
  syncSecretFiles,
  pullClusterRepo,
  destForSecret,
  // CTL-1393: durable change-detection + periodic refresh.
  refreshClusterSecretsIfChanged,
  resolveSopsBin,
  readClusterSyncState,
  writeClusterSyncState,
  clusterSync,
} from "./cluster-sync.mjs";

const QUIET = { warn() {}, info() {} };
let clusterDir, configDir;

beforeEach(() => {
  clusterDir = mkdtempSync(join(tmpdir(), "cs-cluster-"));
  configDir = mkdtempSync(join(tmpdir(), "cs-config-"));
  mkdirSync(join(clusterDir, "secrets"), { recursive: true });
});
afterEach(() => {
  rmSync(clusterDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

const writeClusterJson = (obj) =>
  writeFileSync(join(clusterDir, "cluster.json"), JSON.stringify(obj));
const touchSecret = (name) =>
  writeFileSync(join(clusterDir, "secrets", name), "{ciphertext-placeholder}");

describe("destForSecret (CTL-1211)", () => {
  test("cluster-bots maps to config.json (deep-merged into machine-global)", () => {
    expect(destForSecret("cluster-bots.sops.json", "/cfg")).toBe(resolve("/cfg", "config.json"));
  });
  test("config-<key> maps to config-<key>.json", () => {
    expect(destForSecret("config-catalyst-workspace.sops.json", "/cfg")).toBe(
      resolve("/cfg", "config-catalyst-workspace.json"),
    );
  });
  test("cluster-cloud maps to cluster-cloud.json (CTL-1307, generic path)", () => {
    expect(destForSecret("cluster-cloud.sops.json", "/cfg")).toBe(
      resolve("/cfg", "cluster-cloud.json"),
    );
  });
});

describe("syncClusterSecrets (CTL-1211)", () => {
  test("decrypts each secret into the config dir with deep-merge + 0600", () => {
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    touchSecret("config-catalyst-workspace.sops.json");
    // pre-existing node-local config.json with a NODE-ONLY key that must survive
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ catalyst: { host: { name: "mini" } } }),
    );

    const decrypt = (p) =>
      p.endsWith("cluster-bots.sops.json")
        ? { catalyst: { linear: { bot: { worker: { accessToken: "tok" } } } } }
        : { linear: { apiToken: "proj" } };

    const res = syncClusterSecrets({ clusterDir, configDir, decrypt });
    expect(res.ok).toBe(true);
    expect(res.synced.sort()).toEqual(["config-catalyst-workspace.json", "config.json"]);

    // deep-merge preserved the node-local host.name AND overlaid the bot creds
    const merged = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(merged.catalyst.host.name).toBe("mini");
    expect(merged.catalyst.linear.bot.worker.accessToken).toBe("tok");
    expect(statSync(join(configDir, "config.json")).mode & 0o777).toBe(0o600);
  });

  test("a single decrypt failure is skipped; the rest still sync (fail-open)", () => {
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    touchSecret("config-adva.sops.json");
    const decrypt = (p) => {
      if (p.endsWith("config-adva.sops.json")) throw new Error("bad mac");
      return { ok: true };
    };
    const res = syncClusterSecrets({ clusterDir, configDir, decrypt, logger: QUIET });
    expect(res.synced).toEqual(["config.json"]);
    expect(res.skipped).toEqual(["config-adva.sops.json"]);
  });

  test("schemaVersion too new → fail-closed, nothing synced", () => {
    writeClusterJson({ schemaVersion: 999, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    const res = syncClusterSecrets({
      clusterDir,
      configDir,
      decrypt: () => ({ should: "not-run" }),
      logger: QUIET,
    });
    expect(res.ok).toBe(false);
    expect(res.schemaSkipped).toBe(true);
    expect(res.synced).toEqual([]);
    expect(existsSync(join(configDir, "config.json"))).toBe(false);
  });

  test("no cluster repo → ok:false, reason no-cluster-repo (never throws)", () => {
    const res = syncClusterSecrets({ clusterDir, configDir, decrypt: () => ({}) });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-cluster-repo");
  });

  test("does NOT process node-secret-files.sops.json (owned by syncSecretFiles)", () => {
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    touchSecret("node-secret-files.sops.json");
    const res = syncClusterSecrets({ clusterDir, configDir, decrypt: () => ({ x: 1 }) });
    expect(res.synced).toEqual(["config.json"]);
    expect(existsSync(join(configDir, "node-secret-files.json"))).toBe(false);
  });
});

describe("syncSecretFiles (CTL-1211)", () => {
  const writeNodeFiles = () =>
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");

  test("materializes each map entry as a 0600 file under configDir", () => {
    writeNodeFiles();
    const decrypt = () => ({
      "linear-webhook-secret-ctl": "whsec_abc",
      "cma-api-key": "cma_xyz",
      "github-token": "ghp_tok",
    });
    const res = syncSecretFiles({ clusterDir, configDir, decrypt });
    expect(res.written.sort()).toEqual(["cma-api-key", "github-token", "linear-webhook-secret-ctl"]);
    expect(readFileSync(join(configDir, "linear-webhook-secret-ctl"), "utf8")).toBe("whsec_abc");
    expect(statSync(join(configDir, "cma-api-key")).mode & 0o777).toBe(0o600);
  });

  test("refuses path-traversal / dotfile names (no escape from configDir)", () => {
    writeNodeFiles();
    const decrypt = () => ({
      "../escape": "x",
      "/etc/evil": "x",
      ".ssh/authorized_keys": "x",
      "ok-name": "good",
    });
    const res = syncSecretFiles({ clusterDir, configDir, decrypt, logger: QUIET });
    expect(res.written).toEqual(["ok-name"]);
    expect(existsSync(join(configDir, "ok-name"))).toBe(true);
  });

  test("absent node-secret-files → reason absent (no-op, never throws)", () => {
    const res = syncSecretFiles({ clusterDir, configDir, decrypt: () => ({}) });
    expect(res.reason).toBe("absent");
    expect(res.written).toEqual([]);
  });

  test("decrypt failure → skipped, fail-open (never throws)", () => {
    writeNodeFiles();
    const res = syncSecretFiles({
      clusterDir,
      configDir,
      decrypt: () => {
        throw new Error("bad mac");
      },
      logger: QUIET,
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("decrypt-failed");
  });

  test("partial write failure → records the name in failed[], keeps the rest (Codex-A)", () => {
    writeNodeFiles();
    const decrypt = () => ({ good: "x", bad: "y" });
    // a writeFile that throws for the "bad" entry only — the decrypt succeeded but
    // materialization of one REQUESTED file failed (a partial bare-file failure).
    const writeFile = (path) => {
      if (path.endsWith("/bad") || path.endsWith("\\bad")) throw new Error("EIO");
    };
    const res = syncSecretFiles({ clusterDir, configDir, decrypt, writeFile, logger: QUIET });
    expect(res.written).toEqual(["good"]);
    expect(res.failed).toEqual(["bad"]);
    // not a wholesale decrypt failure — the bundle decrypted fine
    expect(res.reason).toBeNull();
    expect(res.skipped).toBe(false);
  });
});

describe("pullClusterRepo (CTL-1211)", () => {
  test("not a git clone → pulled:false, reason not-a-clone", () => {
    const res = pullClusterRepo({
      clusterDir,
      git: () => {
        throw new Error("should not run");
      },
    });
    expect(res).toEqual({ pulled: false, reason: "not-a-clone" });
  });

  test("git pull success → pulled:true with --ff-only", () => {
    mkdirSync(join(clusterDir, ".git"), { recursive: true });
    let called = null;
    const res = pullClusterRepo({ clusterDir, git: (args) => (called = args) });
    expect(res.pulled).toBe(true);
    expect(called).toEqual(["-C", clusterDir, "pull", "--ff-only"]);
  });

  test("git pull failure → pulled:false, reason pull-failed (never throws)", () => {
    mkdirSync(join(clusterDir, ".git"), { recursive: true });
    const res = pullClusterRepo({
      clusterDir,
      git: () => {
        throw new Error("network");
      },
      logger: QUIET,
    });
    expect(res).toEqual({ pulled: false, reason: "pull-failed" });
  });
});

// ─── CTL-1393: durable change-detection marker + periodic auto-refresh ────────

describe("resolveSopsBin (CTL-1393 PATH-robust sops)", () => {
  test("picks the first absolute candidate that exists (PATH cannot break it)", () => {
    const seen = (p) => p === "/usr/local/bin/sops"; // homebrew missing, /usr/local present
    const bin = resolveSopsBin({ fileExists: seen, pathEnv: "" });
    expect(bin).toBe("/usr/local/bin/sops");
  });

  test("falls back to a PATH scan when no known candidate exists", () => {
    const bin = resolveSopsBin({
      candidates: ["/opt/homebrew/bin/sops", "/usr/local/bin/sops", "/usr/bin/sops"],
      fileExists: (p) => p === "/custom/tools/sops",
      pathEnv: "/custom/tools:/somewhere/else",
      pathSep: ":",
    });
    expect(bin).toBe(resolve("/custom/tools", "sops"));
  });

  test("returns null when sops is found nowhere (LOUD: caller emits refresh-failed)", () => {
    const bin = resolveSopsBin({ fileExists: () => false, pathEnv: "/a:/b", pathSep: ":" });
    expect(bin).toBeNull();
  });
});

describe("cluster-sync marker read/write (CTL-1393)", () => {
  test("write → read round-trips the marker shape", () => {
    const statePath = join(configDir, ".cluster-sync-state.json");
    const marker = {
      lastDecryptedSha: "abc123",
      lastDecryptedAt: "2026-06-29T00:00:00Z",
      written: ["github-token"],
      synced: ["config.json"],
    };
    expect(writeClusterSyncState(statePath, marker, QUIET)).toBe(true);
    expect(readClusterSyncState(statePath)).toEqual(marker);
  });

  test("absent / malformed marker → null (never throws)", () => {
    expect(readClusterSyncState(join(configDir, "does-not-exist.json"))).toBeNull();
    writeFileSync(join(configDir, "broken.json"), "{not json");
    expect(readClusterSyncState(join(configDir, "broken.json"))).toBeNull();
  });

  test("marker file is written mode 0600 (posture parity with secret files)", () => {
    const statePath = join(configDir, ".cluster-sync-state-mode.json");
    expect(
      writeClusterSyncState(
        statePath,
        { lastDecryptedSha: "abc", lastDecryptedAt: "t", written: [], synced: [] },
        QUIET,
      ),
    ).toBe(true);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });
});

describe("refreshClusterSecretsIfChanged (CTL-1393)", () => {
  // gitCapture stub: rev-parse → HEAD; diff --quiet → status 1 (changed) / 0 (same).
  const makeGitCapture = (head, secretsChanged) => (args) => {
    if (args.includes("rev-parse")) return { status: 0, stdout: `${head}\n` };
    if (args.includes("diff")) return { status: secretsChanged ? 1 : 0, stdout: "" };
    return { status: 0, stdout: "" };
  };
  const baseGit = () => {}; // no-op mutating git (pullClusterRepo)

  const seedClone = () => mkdirSync(join(clusterDir, ".git"), { recursive: true });
  const writeMarker = (statePath, sha) =>
    writeFileSync(
      statePath,
      JSON.stringify({ lastDecryptedSha: sha, lastDecryptedAt: "old", written: [], synced: [] }),
    );

  test("(a) HEAD unchanged → SKIP decrypt (no sops spawn) and no marker rewrite", () => {
    seedClone();
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "HEADSHA");
    let decryptCalls = 0;
    let resolveCalls = 0;
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("HEADSHA", false),
      resolveSops: () => {
        resolveCalls += 1;
        return "/opt/homebrew/bin/sops";
      },
      decrypt: () => {
        decryptCalls += 1;
        return {};
      },
      emit: () => {},
      now: () => "now",
      node: "test-node",
      logger: QUIET,
    });
    expect(res.changed).toBe(false);
    expect(res.reason).toBe("head-unchanged");
    expect(decryptCalls).toBe(0); // no sops spawn
    expect(resolveCalls).toBe(0);
  });

  test("(b) only non-secrets/ files changed → SKIP decrypt, advance marker to HEAD", () => {
    seedClone();
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");
    let decryptCalls = 0;
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", false), // diff --quiet secrets/ → unchanged
      resolveSops: () => "/opt/homebrew/bin/sops",
      decrypt: () => {
        decryptCalls += 1;
        return {};
      },
      emit: () => {},
      now: () => "t1",
      node: "test-node",
      logger: QUIET,
    });
    expect(res.reason).toBe("secrets-unchanged");
    expect(decryptCalls).toBe(0); // no sops spawn
    // marker advanced to the new HEAD so we don't re-diff the same range forever
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
  });

  test("(c) secrets/ changed → re-decrypt + OVERWRITE stale placeholder + emit refreshed", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    // pre-existing config.json carries a STALE placeholder token
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ catalyst: { linear: { bot: { worker: { accessToken: "STALE" } } } } }),
    );
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true), // secrets/ changed
      // decrypt returns the freshly-ROTATED value
      decrypt: () => ({ catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } }),
      emit: (e) => emits.push(e),
      now: () => "2026-06-29T00:00:00Z",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.changed).toBe(true);
    expect(res.synced).toEqual(["config.json"]);
    // overwrite: the filled value replaced the stale placeholder
    const merged = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    expect(merged.catalyst.linear.bot.worker.accessToken).toBe("FRESH");
    // marker advanced + timestamp from the injected clock
    const marker = readClusterSyncState(statePath);
    expect(marker.lastDecryptedSha).toBe("NEWSHA");
    expect(marker.lastDecryptedAt).toBe("2026-06-29T00:00:00Z");
    // refreshed event emitted with the from→to shas
    expect(emits).toHaveLength(1);
    expect(emits[0].name).toBe("refreshed");
    expect(emits[0].payload).toMatchObject({ fromSha: "OLDSHA", toSha: "NEWSHA", synced: ["config.json"] });
  });

  test("(e1) sops UNRESOLVABLE on a changed HEAD → fail-open + refresh-failed event, marker NOT advanced", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    let res;
    expect(() => {
      res = refreshClusterSecretsIfChanged({
        clusterDir,
        configDir,
        statePath,
        git: baseGit,
        gitCapture: makeGitCapture("NEWSHA", true),
        resolveSops: () => null, // sops not found anywhere — the silent-stale root cause
        // no decrypt injected → forces the resolver path
        emit: (e) => emits.push(e),
        now: () => "t",
        node: "test-node",
        logger: QUIET,
      });
    }).not.toThrow();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("sops-unresolved");
    expect(emits).toHaveLength(1);
    expect(emits[0].name).toBe("refresh-failed");
    expect(emits[0].payload.reason).toBe("sops-unresolved");
    // marker stays at the old sha so the next tick retries
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA");
  });

  test("(e2) decrypt throws (bad mac) on a changed HEAD → fail-open + refresh-failed event", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    let res;
    expect(() => {
      res = refreshClusterSecretsIfChanged({
        clusterDir,
        configDir,
        statePath,
        git: baseGit,
        gitCapture: makeGitCapture("NEWSHA", true),
        resolveSops: () => "/opt/homebrew/bin/sops",
        decrypt: () => {
          throw new Error("bad mac");
        },
        emit: (e) => emits.push(e),
        now: () => "t",
        node: "test-node",
        logger: QUIET,
      });
    }).not.toThrow();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("decrypt-failed");
    expect(emits.map((e) => e.name)).toContain("refresh-failed");
    // marker NOT advanced — retry next tick
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA");
  });

  test("not a clone (no HEAD) → no-op, never throws, no event", () => {
    const statePath = join(configDir, ".state.json");
    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir, // no .git seeded
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("X", true),
      resolveSops: () => null,
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });
    expect(res.reason).toBe("no-head");
    expect(emits).toHaveLength(0);
  });

  // ── Codex-A: advance the marker ONLY on FULL materialization success ──────────

  test("(a) one JSON secret skipped while another succeeds → marker NOT advanced, refresh-failed(secrets-skipped)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json"); // succeeds → config.json
    touchSecret("config-adva.sops.json"); // fails → skipped
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true),
      decrypt: (p) => {
        if (p.endsWith("config-adva.sops.json")) throw new Error("bad mac");
        return { ok: true };
      },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("secrets-skipped");
    expect(emits).toHaveLength(1);
    expect(emits[0].name).toBe("refresh-failed");
    expect(emits[0].payload.reason).toBe("secrets-skipped");
    // marker stays at the old sha so the next tick retries the skipped secret
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA");
  });

  test("(b) config sync refused (sync.ok:false, empty skipped) → marker NOT advanced, refresh-failed(config-refused)", () => {
    seedClone();
    // NO cluster.json → syncClusterSecrets refuses entirely (no-cluster-repo): ok:false,
    // synced:[], skipped:[] — the empty-skipped refusal the old predicate let slip through.
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true),
      decrypt: () => ({}),
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("config-refused");
    expect(emits.map((e) => e.name)).toContain("refresh-failed");
    expect(emits[0].payload.reason).toBe("config-refused");
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA");
  });

  test("(c) partial bare-file write failure → marker NOT advanced, refresh-failed(bare-write-failed)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json"); // JSON secret succeeds (not wholesale)
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    // Force a write failure for one bare file: pre-create a DIRECTORY at its dest so
    // the real writeFileSync throws EISDIR while the sibling write succeeds.
    mkdirSync(join(configDir, "github-token"), { recursive: true });
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true),
      decrypt: (p) =>
        p.endsWith("node-secret-files.sops.json")
          ? { "cma-api-key": "ok", "github-token": "tok" }
          : { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bare-write-failed");
    expect(res.written).toEqual(["cma-api-key"]); // the sibling still materialized
    expect(emits.map((e) => e.name)).toContain("refresh-failed");
    expect(emits[0].payload.reason).toBe("bare-write-failed");
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA");
  });

  test("(e) FULL success (JSON + bare both materialize) → marker advances, refreshed, no refresh-failed", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true),
      decrypt: (p) =>
        p.endsWith("node-secret-files.sops.json")
          ? { "github-token": "tok" }
          : { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.synced).toEqual(["config.json"]);
    expect(res.written).toEqual(["github-token"]);
    // full success advances the marker (guard against over-correcting the predicate)
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
    expect(emits.map((e) => e.name)).toContain("refreshed");
    expect(emits.map((e) => e.name)).not.toContain("refresh-failed");
    // a non-env-backed bare file does NOT trigger a restart-required signal
    expect(emits.map((e) => e.name)).not.toContain("restart-required");
  });

  // ── Codex-B: a rotated ENV-BACKED secret needs a daemon restart to apply ──────

  test("(f) env-backed secret (claude-accounts.env) changed → restart-required emitted (distinct from refreshed)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true),
      decrypt: (p) =>
        p.endsWith("node-secret-files.sops.json")
          ? { "claude-accounts.env": "CLAUDE_CODE_OAUTH_TOKEN=newtok\n" }
          : {},
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(true);
    expect(res.written).toEqual(["claude-accounts.env"]);
    expect(res.restartRequired).toEqual(["claude-accounts.env"]);
    // BOTH signals fire: refreshed (file on disk) AND restart-required (env not live)
    const names = emits.map((e) => e.name);
    expect(names).toContain("refreshed");
    expect(names).toContain("restart-required");
    const rr = emits.find((e) => e.name === "restart-required");
    expect(rr.payload).toMatchObject({ file: "claude-accounts.env", fromSha: "OLDSHA", toSha: "NEWSHA" });
    // the marker still advances — the file IS materialized; only the env needs a restart
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
  });

  // ── CTL-1393 (Codex P2 re-review of caf6b0e2): a too-new cluster.json
  //    (schemaSkipped) must NOT mask a FAILED bare bundle. The schemaSkipped
  //    short-circuit used to run FIRST and advance the marker over the un-applied
  //    bare secret, stranding the rotation forever; bare-file failure is now assessed
  //    BEFORE schemaSkipped. ──────────────────────────────────────────────────────

  test("schemaSkipped JSON config + FAILED bare bundle (decrypt-failed) → marker NOT advanced (bare failure not masked)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 999, roster: ["mini"] }); // too-new → schemaSkipped
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true),
      // bundle decrypt fails → files.reason === "decrypt-failed" (JSON sync is
      // schema-refused before decrypt, so this throw only hits the bare bundle)
      decrypt: () => {
        throw new Error("bad mac");
      },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("decrypt-failed");
    expect(emits.map((e) => e.name)).toContain("refresh-failed");
    expect(emits[0].payload.reason).toBe("decrypt-failed");
    // marker NOT advanced — the schemaSkipped short-circuit no longer masks the
    // bare-bundle failure, so the next tick retries the rotated secret
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA");
  });

  test("schemaSkipped JSON config + FAILED bare bundle (partial bare-write) → marker NOT advanced (bare failure not masked)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 999, roster: ["mini"] }); // too-new → schemaSkipped
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    // pre-create a DIRECTORY at the bare-file dest so its write throws EISDIR
    mkdirSync(join(configDir, "github-token"), { recursive: true });
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true),
      decrypt: (p) =>
        p.endsWith("node-secret-files.sops.json") ? { "github-token": "tok" } : {},
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("bare-write-failed");
    expect(emits.map((e) => e.name)).toContain("refresh-failed");
    expect(emits[0].payload.reason).toBe("bare-write-failed");
    // marker NOT advanced — a too-new JSON schema must not mask the bare-write failure
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA");
  });

  test("schemaSkipped JSON config + bare bundle OK → marker advances (intentional fail-closed still success-for-marker)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 999, roster: ["mini"] }); // too-new → schemaSkipped
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true),
      decrypt: (p) =>
        p.endsWith("node-secret-files.sops.json") ? { "github-token": "tok" } : {},
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(true);
    expect(res.written).toEqual(["github-token"]);
    // schemaSkipped is an INTENTIONAL fail-closed; with the bare files OK it still
    // counts as success-for-marker, so the marker advances (regression guard against
    // over-correcting the predicate)
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
    expect(emits.map((e) => e.name)).not.toContain("refresh-failed");
  });
});

describe("clusterSync boot (CTL-1393 conditional marker seed)", () => {
  // rev-parse → HEAD; everything else status 0. Boot only ever rev-parses.
  const makeGitCapture = (head) => (args) =>
    args.includes("rev-parse") ? { status: 0, stdout: `${head}\n` } : { status: 0, stdout: "" };
  const baseGit = () => {}; // no-op mutating git (pullClusterRepo)
  const seedClone = () => mkdirSync(join(clusterDir, ".git"), { recursive: true });
  const touchNodeFiles = () =>
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");

  test("boot decrypt fails WHOLESALE → marker NOT seeded + refresh-failed emitted (never throws)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json"); // the only JSON secret → all-skipped on throw
    touchNodeFiles(); // bare-file bundle present → files.reason === "decrypt-failed" on throw
    const statePath = join(configDir, ".state.json");

    const writeCalls = [];
    const emits = [];
    let res;
    expect(() => {
      res = clusterSync({
        clusterDir,
        configDir,
        statePath,
        git: baseGit,
        gitCapture: makeGitCapture("NEWSHA"),
        // every decrypt throws → JSON secret skipped (synced empty) AND bundle fails
        decrypt: () => {
          throw new Error("bad mac");
        },
        writeState: (sp, state) => {
          writeCalls.push(state);
          return true;
        },
        emit: (e) => emits.push(e),
        now: () => "t",
        node: "test-node",
        logger: QUIET,
      });
    }).not.toThrow();

    // marker NOT advanced — the silent-stale failure mode is averted
    expect(writeCalls).toHaveLength(0);
    // and the failure is LOUD via the same envelope the refresh path uses
    expect(emits.map((e) => e.name)).toContain("refresh-failed");
    expect(emits[0].payload.reason).toBe("decrypt-failed");
    expect(emits[0].payload.toSha).toBe("NEWSHA");
    // return shape stays {pull, sync, files}
    expect(res).toHaveProperty("pull");
    expect(res).toHaveProperty("sync");
    expect(res).toHaveProperty("files");
  });

  test("boot decrypt SUCCEEDS → marker seeded to HEAD, no refresh-failed (guard against over-correcting)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    const statePath = join(configDir, ".state.json");

    const writeCalls = [];
    const emits = [];
    const res = clusterSync({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("BOOTSHA"),
      decrypt: () => ({ catalyst: { linear: { bot: { worker: { accessToken: "tok" } } } } }),
      writeState: (sp, state) => {
        writeCalls.push(state);
        return true;
      },
      emit: (e) => emits.push(e),
      now: () => "t1",
      node: "test-node",
      logger: QUIET,
    });

    // success path still seeds the marker at the clone's HEAD
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].lastDecryptedSha).toBe("BOOTSHA");
    expect(writeCalls[0].synced).toEqual(["config.json"]);
    // boot success does not alarm
    expect(emits.map((e) => e.name)).not.toContain("refresh-failed");
    expect(res.sync.synced).toEqual(["config.json"]);
  });

  test("fresh node, EMPTY secrets repo (nothing to decrypt) → still seeds marker (not a failure)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    // no secret files touched, no node-secret-files bundle → nothing skipped, nothing failed
    const statePath = join(configDir, ".state.json");

    const writeCalls = [];
    const emits = [];
    const res = clusterSync({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("EMPTYSHA"),
      decrypt: () => {
        throw new Error("should never be called — no secrets present");
      },
      writeState: (sp, state) => {
        writeCalls.push(state);
        return true;
      },
      emit: (e) => emits.push(e),
      now: () => "t2",
      node: "test-node",
      logger: QUIET,
    });

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].lastDecryptedSha).toBe("EMPTYSHA");
    expect(emits.map((e) => e.name)).not.toContain("refresh-failed");
    expect(res.sync.synced).toEqual([]);
  });

  test("(d) boot PARTIAL failure (one JSON skipped, another ok) → marker NOT seeded + refresh-failed(secrets-skipped)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json"); // succeeds → config.json
    touchSecret("config-adva.sops.json"); // fails → skipped (partial, not wholesale)
    const statePath = join(configDir, ".state.json");

    const writeCalls = [];
    const emits = [];
    let res;
    expect(() => {
      res = clusterSync({
        clusterDir,
        configDir,
        statePath,
        git: baseGit,
        gitCapture: makeGitCapture("NEWSHA"),
        decrypt: (p) => {
          if (p.endsWith("config-adva.sops.json")) throw new Error("bad mac");
          return { ok: true };
        },
        writeState: (sp, state) => {
          writeCalls.push(state);
          return true;
        },
        emit: (e) => emits.push(e),
        now: () => "t",
        node: "test-node",
        logger: QUIET,
      });
    }).not.toThrow();

    // a PARTIAL boot decrypt must NOT seed the marker (the silent-stale fast-path trap)
    expect(writeCalls).toHaveLength(0);
    expect(emits.map((e) => e.name)).toContain("refresh-failed");
    expect(emits[0].payload.reason).toBe("secrets-skipped");
    expect(res.sync.synced).toEqual(["config.json"]);
    expect(res.sync.skipped).toEqual(["config-adva.sops.json"]);
  });
});
