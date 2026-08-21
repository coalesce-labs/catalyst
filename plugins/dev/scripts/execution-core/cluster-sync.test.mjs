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
  syncProfileFiles,
  defaultProfilesDir,
  pullClusterRepo,
  destForSecret,
  // CTL-1393: durable change-detection + periodic refresh.
  refreshClusterSecretsIfChanged,
  resolveSopsBin,
  readClusterSyncState,
  writeClusterSyncState,
  clusterSync,
  buildClusterSecretEnvelope,
  ENV_BACKED_SECRET_FILES,
  // CTL-1612: the boot-captured predicate that widened the restart-required set.
  isEnvBackedSecretFile,
  // CTL-2042: per-host plain posture file materialization.
  syncHostEnvFiles,
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

  test("does NOT process profile-files.sops.json (owned by syncProfileFiles, CTL-1595)", () => {
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    touchSecret("profile-files.sops.json");
    const res = syncClusterSecrets({ clusterDir, configDir, decrypt: () => ({ x: 1 }) });
    expect(res.synced).toEqual(["config.json"]);
    expect(existsSync(join(configDir, "profile-files.json"))).toBe(false);
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

  // ── CTL-1612 (Codex P2): `written` ≠ `changed`. Any commit touching secrets/
  //    re-decrypts and rewrites the WHOLE bundle, so `written` names every bare
  //    file even when a single unrelated entry rotated. `changed` is the read-back
  //    subset whose CONTENT actually moved — the only sound basis for a restart
  //    alarm. ────────────────────────────────────────────────────────────────────

  test("(CTL-1612) a byte-identical rewrite lands in written[] but NOT changed[]", () => {
    writeNodeFiles();
    // already on disk, byte-identical to what this bundle carries
    writeFileSync(join(configDir, "github-token"), "fake-github-token-v1");
    writeFileSync(join(configDir, "cma-api-key"), "fake-cma-key-v1");
    const decrypt = () => ({
      "github-token": "fake-github-token-v1", // untouched by this rotation
      "cma-api-key": "fake-cma-key-v2", // the entry that actually rotated
    });
    const res = syncSecretFiles({ clusterDir, configDir, decrypt, logger: QUIET });
    // the whole bundle is rewritten…
    expect(res.written).toEqual(["github-token", "cma-api-key"]);
    // …but only one entry MOVED
    expect(res.changed).toEqual(["cma-api-key"]);
    expect(readFileSync(join(configDir, "cma-api-key"), "utf8")).toBe("fake-cma-key-v2");
  });

  test("(CTL-1612) an absent destination counts as CHANGED (first materialization)", () => {
    writeNodeFiles();
    const decrypt = () => ({ "github-token": "fake-github-token-v1", "cma-api-key": "fake-cma-key-v1" });
    // nothing pre-exists in configDir — a fresh node must announce every file
    const res = syncSecretFiles({ clusterDir, configDir, decrypt, logger: QUIET });
    expect(res.written).toEqual(["github-token", "cma-api-key"]);
    expect(res.changed).toEqual(res.written);
  });

  test("(CTL-1612) the readFile seam is injectable; a null read-back counts as changed", () => {
    writeNodeFiles();
    writeFileSync(join(configDir, "cma-api-key"), "fake-cma-key-v1");
    const decrypt = () => ({ "cma-api-key": "fake-cma-key-v1" });
    // an UNREADABLE destination (perms, EIO) reads back null — never throws, and is
    // conservatively treated as changed rather than silently swallowing a rotation.
    const res = syncSecretFiles({
      clusterDir,
      configDir,
      decrypt,
      readFile: () => null,
      logger: QUIET,
    });
    expect(res.written).toEqual(["cma-api-key"]);
    expect(res.changed).toEqual(["cma-api-key"]);
  });

  test("(CTL-1612) `changed` is an array on EVERY return path (the fallback stays dormant)", () => {
    // refreshClusterSecretsIfChanged degrades to `written` when `changed` is absent
    // (back-compat for a legacy/injected result). That fallback must never fire for
    // the in-tree caller — dropping the field would silently restore the noisy
    // rewrite-is-a-rotation behavior this fix removed.
    const absent = syncSecretFiles({ clusterDir, configDir, decrypt: () => ({}) });
    expect(absent.reason).toBe("absent");
    expect(Array.isArray(absent.changed)).toBe(true);

    writeNodeFiles();
    const failedDecrypt = syncSecretFiles({
      clusterDir,
      configDir,
      decrypt: () => {
        throw new Error("bad mac");
      },
      logger: QUIET,
    });
    expect(failedDecrypt.reason).toBe("decrypt-failed");
    expect(Array.isArray(failedDecrypt.changed)).toBe(true);

    const empty = syncSecretFiles({ clusterDir, configDir, decrypt: () => null, logger: QUIET });
    expect(empty.reason).toBe("empty");
    expect(Array.isArray(empty.changed)).toBe(true);

    const ok = syncSecretFiles({
      clusterDir,
      configDir,
      decrypt: () => ({ "cma-api-key": "fake-cma-key-v1" }),
      logger: QUIET,
    });
    expect(Array.isArray(ok.changed)).toBe(true);
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

describe("defaultProfilesDir (CTL-1595 Codex P2 — XDG-aware)", () => {
  test("honors XDG_CONFIG_HOME when set (check-setup.sh parity)", () => {
    expect(defaultProfilesDir({ XDG_CONFIG_HOME: "/xdg" })).toBe(resolve("/xdg", "direnv", "profiles"));
  });
  test("falls back to ~/.config when XDG_CONFIG_HOME is unset/empty", () => {
    const home = defaultProfilesDir({});
    expect(home.endsWith(join(".config", "direnv", "profiles"))).toBe(true);
    expect(defaultProfilesDir({ XDG_CONFIG_HOME: "" })).toBe(home);
  });
});

describe("syncProfileFiles (CTL-1595)", () => {
  const writeProfileBundle = () =>
    writeFileSync(join(clusterDir, "secrets", "profile-files.sops.json"), "{cipher}");
  const profilesDirOf = () => join(configDir, "profiles");

  test("materializes each map entry as a 0600 file under profilesDir", () => {
    writeProfileBundle();
    const decrypt = () => ({
      "catalyst-cloud.env": "export GH_TEMP_PAT=x\nexport LINEAR_API_KEY=y\n",
    });
    const res = syncProfileFiles({ clusterDir, profilesDir: profilesDirOf(), decrypt });
    expect(res.written).toEqual(["catalyst-cloud.env"]);
    expect(readFileSync(join(profilesDirOf(), "catalyst-cloud.env"), "utf8")).toContain("GH_TEMP_PAT");
    expect(statSync(join(profilesDirOf(), "catalyst-cloud.env")).mode & 0o777).toBe(0o600);
  });

  test("refuses path-traversal / dotfile names (no escape from profilesDir)", () => {
    writeProfileBundle();
    const decrypt = () => ({ "../escape.env": "x", ".ssh": "x", "ok.env": "good" });
    const res = syncProfileFiles({ clusterDir, profilesDir: profilesDirOf(), decrypt, logger: QUIET });
    expect(res.written).toEqual(["ok.env"]);
  });

  test("absent profile bundle → reason absent (no-op — not every cluster ships profiles)", () => {
    const res = syncProfileFiles({ clusterDir, profilesDir: profilesDirOf(), decrypt: () => ({}) });
    expect(res.reason).toBe("absent");
    expect(res.written).toEqual([]);
  });

  test("decrypt failure → skipped, fail-open (never throws)", () => {
    writeProfileBundle();
    const res = syncProfileFiles({
      clusterDir,
      profilesDir: profilesDirOf(),
      decrypt: () => {
        throw new Error("bad mac");
      },
      logger: QUIET,
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("decrypt-failed");
  });

  test("rejects a bundle key without the .env suffix (use_profile can never find it)", () => {
    writeProfileBundle();
    const decrypt = () => ({ "catalyst-cloud": "x", "good.env": "y" });
    const res = syncProfileFiles({ clusterDir, profilesDir: profilesDirOf(), decrypt, logger: QUIET });
    expect(res.written).toEqual(["good.env"]);
    expect(existsSync(join(profilesDirOf(), "catalyst-cloud"))).toBe(false);
  });

  test("removes a profile deleted from the bundle; node-local profiles untouched (Codex R2)", () => {
    writeProfileBundle();
    const dir = profilesDirOf();
    // Sync 1: two managed profiles.
    let res = syncProfileFiles({
      clusterDir, profilesDir: dir,
      decrypt: () => ({ "a.env": "1", "b.env": "2" }),
      logger: QUIET,
    });
    expect(res.written.sort()).toEqual(["a.env", "b.env"]);
    // A hand-provisioned node-local profile the mechanism must never touch.
    writeFileSync(join(dir, "local.env"), "hand-made");
    // Sync 2: b.env deleted from the bundle → removed from disk; local.env stays.
    res = syncProfileFiles({
      clusterDir, profilesDir: dir,
      decrypt: () => ({ "a.env": "1" }),
      logger: QUIET,
    });
    expect(res.removed).toEqual(["b.env"]);
    expect(existsSync(join(dir, "b.env"))).toBe(false);
    expect(existsSync(join(dir, "a.env"))).toBe(true);
    expect(readFileSync(join(dir, "local.env"), "utf8")).toBe("hand-made");
  });

  test("partial write failure → records the name in failed[], keeps the rest", () => {
    writeProfileBundle();
    const decrypt = () => ({ "good.env": "x", "bad.env": "y" });
    const writeFile = (path) => {
      if (path.endsWith("bad.env")) throw new Error("EIO");
    };
    const res = syncProfileFiles({ clusterDir, profilesDir: profilesDirOf(), decrypt, writeFile, logger: QUIET });
    expect(res.written).toEqual(["good.env"]);
    expect(res.failed).toEqual(["bad.env"]);
    expect(res.reason).toBeNull();
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

  test("(b2) CTL-2042: secrets/ unchanged but hosts/<host>/ changed → materialize posture, advance marker", () => {
    seedClone();
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");
    // gitCapture that distinguishes the pathspec: secrets/ unchanged, hosts/ changed.
    const scopedGitCapture = (args) => {
      if (args.includes("rev-parse")) return { status: 0, stdout: "NEWSHA\n" };
      if (args.includes("diff")) {
        const scopedToHosts = args.some((a) => typeof a === "string" && a.startsWith("hosts/"));
        return { status: scopedToHosts ? 1 : 0, stdout: "" };
      }
      return { status: 0, stdout: "" };
    };
    let hostEnvCalls = 0;
    let decryptCalls = 0;
    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: scopedGitCapture,
      // Inject the posture materializer so the test controls its result deterministically.
      syncHostEnvFiles: () => {
        hostEnvCalls += 1;
        return { written: ["execution-core.env"], changed: ["execution-core.env"], failed: [], skipped: false, reason: null };
      },
      decrypt: () => {
        decryptCalls += 1;
        return {};
      },
      emit: (e) => emits.push(e),
      now: () => "t2",
      node: "test-node",
      logger: QUIET,
    });
    expect(res.reason).toBe("host-env-refreshed");
    expect(hostEnvCalls).toBe(1); // posture materialized despite secrets/ being unchanged
    expect(decryptCalls).toBe(0); // still no sops spawn
    expect(res.changed).toBe(true);
    // marker advanced so we don't re-diff the same range forever
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
  });

  test("(b3) CTL-2042: host-env write shortfall → refresh-failed, marker NOT advanced", () => {
    seedClone();
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");
    const scopedGitCapture = (args) => {
      if (args.includes("rev-parse")) return { status: 0, stdout: "NEWSHA\n" };
      if (args.includes("diff")) {
        const scopedToHosts = args.some((a) => typeof a === "string" && a.startsWith("hosts/"));
        return { status: scopedToHosts ? 1 : 0, stdout: "" };
      }
      return { status: 0, stdout: "" };
    };
    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: scopedGitCapture,
      syncHostEnvFiles: () => ({ written: [], changed: [], failed: ["execution-core.env"], skipped: false, reason: null }),
      emit: (e) => emits.push(e),
      now: () => "t3",
      node: "test-node",
      logger: QUIET,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("host-env-write-failed");
    expect(emits.some((e) => e.name === "refresh-failed")).toBe(true);
    // marker stays behind so the next tick retries the un-applied posture
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA");
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
          ? // CTL-1612: was "github-token", which is now BOOT-CAPTURED and so legitimately
            // emits restart-required. Re-pointed (not deleted) to cma-api-key — a genuine
            // bare bundle file that nothing sources or boot-reads — so this stays a valid
            // NEGATIVE CONTROL proving isEnvBackedSecretFile is not over-broad.
            { "cma-api-key": "cma_xyz" }
          : { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.synced).toEqual(["config.json"]);
    expect(res.written).toEqual(["cma-api-key"]);
    // full success advances the marker (guard against over-correcting the predicate)
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
    expect(emits.map((e) => e.name)).toContain("refreshed");
    expect(emits.map((e) => e.name)).not.toContain("refresh-failed");
    // a non-boot-captured bare file does NOT trigger a restart-required signal
    expect(emits.map((e) => e.name)).not.toContain("restart-required");
  });

  test("(p1) partial PROFILE write failure → marker NOT advanced, refresh-failed(profile-write-failed)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    writeFileSync(join(clusterDir, "secrets", "profile-files.sops.json"), "{cipher}");
    const profilesDir = join(configDir, "profiles");
    // Force a write failure: pre-create a DIRECTORY at the profile's destination.
    mkdirSync(join(profilesDir, "catalyst-cloud.env"), { recursive: true });
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      profilesDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true),
      decrypt: (p) =>
        p.endsWith("profile-files.sops.json")
          ? { "catalyst-cloud.env": "export GH_TEMP_PAT=x\n" }
          : { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("profile-write-failed");
    expect(emits.map((e) => e.name)).toContain("refresh-failed");
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA");
  });

  test("(p2) FULL success incl. profile bundle → profiles materialized, marker advances", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    writeFileSync(join(clusterDir, "secrets", "profile-files.sops.json"), "{cipher}");
    const profilesDir = join(configDir, "profiles");
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      profilesDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true),
      decrypt: (p) =>
        p.endsWith("profile-files.sops.json")
          ? { "catalyst-cloud.env": "export GH_TEMP_PAT=x\nexport LINEAR_API_KEY=y\n" }
          : { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(true);
    expect(res.profiles).toEqual(["catalyst-cloud.env"]);
    expect(readFileSync(join(profilesDir, "catalyst-cloud.env"), "utf8")).toContain("LINEAR_API_KEY");
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
    expect(emits.map((e) => e.name)).toContain("refreshed");
    // Codex P2: the refreshed payload must name the materialized profiles.
    const refreshed = emits.find((e) => e.name === "refreshed");
    expect(refreshed.payload.profiles).toEqual(["catalyst-cloud.env"]);
    // a profile rotation needs NO daemon restart (direnv re-evaluates per spawn)
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

  // ── CTL-1984 AC2: two env-backed files materialize; ONLY the one whose content ──
  //    actually changed should appear in restartRequired (delivery-based, not a
  //    simple "was written" flag). This is the negative-control companion to (f):
  //    the reclassification of claude-accounts.env must NOT affect which files
  //    raise restart-required — the predicate is delivery-based (env-file ∈
  //    _BOOT_CAPTURED_DELIVERIES), regardless of rotation.class.              ────

  test("(f-ac2) CTL-1984 AC2: only the CHANGED env-backed file raises restart-required; unchanged file does not", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    // Decrypt: execution-core.env changes; claude-accounts.env is NOT in the bundle
    // (cluster-sync only raises restart-required for files in res.written, which
    // requires them to appear in the decrypted output and differ from disk).
    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true),
      decrypt: (p) =>
        p.endsWith("node-secret-files.sops.json")
          ? { "execution-core.env": "SOME_VAR=new-value\n" }
          : {},
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(true);
    // Only execution-core.env materialized — not claude-accounts.env
    expect(res.written).toContain("execution-core.env");
    expect(res.written).not.toContain("claude-accounts.env");
    // Only execution-core.env needs a restart
    expect(res.restartRequired).toContain("execution-core.env");
    expect(res.restartRequired).not.toContain("claude-accounts.env");
    // Exactly one restart-required signal emitted
    const restarts = emits.filter((e) => e.name === "restart-required");
    expect(restarts).toHaveLength(1);
    expect(restarts[0].payload).toMatchObject({ file: "execution-core.env" });
  });

  // ── CTL-1612: the widened boot-captured enrollment, exercised THROUGH the call
  //    site. isEnvBackedSecretFile is unit-tested below, but a correct predicate
  //    that is never wired into the restartRequired filter is exactly the 2026-08-02
  //    outage shape — cluster-sync rewrote github-token, recorded it in `written`,
  //    emitted plain `refreshed`, and every running daemon kept 401ing on the value
  //    it had captured at boot. These three assert the wiring, not the predicate.
  //    (The negative control lives in test (e) above: a bare cma-api-key rotation
  //    must still emit NO restart-required.) ────────────────────────────────────

  test("(f1) github-token rotated → restart-required emitted (CTL-1612 — the outage file)", () => {
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
          ? { "github-token": "fake-github-token-for-tests" }
          : { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(true);
    expect(res.written).toEqual(["github-token"]);
    expect(res.restartRequired).toEqual(["github-token"]);
    const names = emits.map((e) => e.name);
    expect(names).toContain("refreshed");
    expect(names).toContain("restart-required");
    const rr = emits.find((e) => e.name === "restart-required");
    expect(rr.payload).toMatchObject({ file: "github-token", fromSha: "OLDSHA", toSha: "NEWSHA" });
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
  });

  test("(f2) linear-webhook-secret-<team> rotated → restart-required emitted (FAMILY wired at the call site)", () => {
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
          ? { "linear-webhook-secret-ctl": "fake-webhook-secret-for-tests" }
          : { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(true);
    expect(res.written).toEqual(["linear-webhook-secret-ctl"]);
    // the open-ended per-team family resolves through the predicate, not a fixed Set
    expect(res.restartRequired).toEqual(["linear-webhook-secret-ctl"]);
    const names = emits.map((e) => e.name);
    expect(names).toContain("refreshed");
    expect(names).toContain("restart-required");
    const rr = emits.find((e) => e.name === "restart-required");
    expect(rr.payload).toMatchObject({
      file: "linear-webhook-secret-ctl",
      fromSha: "OLDSHA",
      toSha: "NEWSHA",
    });
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
  });

  test("(f3) MIXED rotation → restart-required for the boot-captured file ONLY (predicate not over-broad)", () => {
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
          ? {
              // one boot-captured, one plain bare file — same rotation
              "webhook-secret": "fake-webhook-secret-for-tests",
              "cma-api-key": "fake-cma-key-for-tests",
            }
          : { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(true);
    // BOTH files materialize…
    expect(res.written).toEqual(["webhook-secret", "cma-api-key"]);
    // …but only the boot-captured one needs a restart to apply
    expect(res.restartRequired).toEqual(["webhook-secret"]);
    const restarts = emits.filter((e) => e.name === "restart-required");
    expect(restarts).toHaveLength(1);
    expect(restarts[0].payload).toMatchObject({
      file: "webhook-secret",
      fromSha: "OLDSHA",
      toSha: "NEWSHA",
    });
    expect(emits.map((e) => e.name)).toContain("refreshed");
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
  });

  // ── CTL-1612 (Codex P2): restart alarms key off CONTENT, not rewrites. Any
  //    commit under secrets/ rewrites the whole bare bundle, so filtering
  //    `written` fired a restart-required for github-token on EVERY routine
  //    rotation of some unrelated secret — a nag that trains operators to ignore
  //    the one signal that says "your daemon is running on a revoked credential".
  //    These drive the real refresh through the real read-back (syncSecretFiles is
  //    called with the module's own fs readFile, not an injected one). ───────────

  test("(g1) UNCHANGED github-token + one rotated sibling → NO restart-required (T4 regression)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    // the credential this node is ALREADY running on, byte-identical to the bundle's
    writeFileSync(join(configDir, "github-token"), "fake-github-token-v1");
    writeFileSync(join(configDir, "cma-api-key"), "fake-cma-key-v1");
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
          ? {
              "github-token": "fake-github-token-v1", // did NOT move
              "cma-api-key": "fake-cma-key-v2", // the actual rotation
            }
          : { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(true);
    // the whole bundle is re-materialized — `written` names both files…
    expect(res.written).toEqual(["github-token", "cma-api-key"]);
    // …and that is precisely why it cannot drive the alarm: nothing boot-captured moved
    expect(res.restartRequired).toEqual([]);
    const names = emits.map((e) => e.name);
    expect(names).toContain("refreshed"); // the rotation IS announced
    expect(names).not.toContain("restart-required"); // …without a spurious restart nag
    // the unrelated rotation still landed on disk, and the marker advanced
    expect(readFileSync(join(configDir, "cma-api-key"), "utf8")).toBe("fake-cma-key-v2");
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
  });

  test("(g2) genuinely rotated github-token → restart-required STILL fires (fix not over-corrected)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    writeFileSync(join(configDir, "github-token"), "fake-github-token-v1");
    writeFileSync(join(configDir, "cma-api-key"), "fake-cma-key-v1");
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
          ? {
              "github-token": "fake-github-token-v2", // the credential MOVED
              "cma-api-key": "fake-cma-key-v1", // untouched sibling, rewritten anyway
            }
          : { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(true);
    expect(res.written).toEqual(["github-token", "cma-api-key"]);
    // status names the boot-captured file that actually rotated — and ONLY it
    expect(res.restartRequired).toEqual(["github-token"]);
    const restarts = emits.filter((e) => e.name === "restart-required");
    expect(restarts).toHaveLength(1);
    expect(restarts[0].payload).toMatchObject({
      file: "github-token",
      fromSha: "OLDSHA",
      toSha: "NEWSHA",
    });
    expect(emits.map((e) => e.name)).toContain("refreshed");
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
  });

  test("(g3) legacy result shape (no `changed`) → falls back to `written`, never to nothing", () => {
    // Back-compat guard for the `Array.isArray(files?.changed) ? … : status.written`
    // selection. The in-tree caller always supplies `changed` (pinned by the
    // syncSecretFiles shape test above) and refreshClusterSecretsIfChanged calls the
    // module-local syncSecretFiles directly — so the legacy branch is reachable only
    // from an externally-injected/older result. Pin the RULE: a missing `changed`
    // must degrade to the old, noisier behavior (announce every rewritten file),
    // never to silence — a rotation that stops being announced is the 2026-08-02
    // outage all over again.
    const selectRotated = (files, written) =>
      (Array.isArray(files?.changed) ? files.changed : written).filter(isEnvBackedSecretFile);

    const legacy = { written: ["github-token", "cma-api-key"], failed: [], skipped: false, reason: null };
    expect(selectRotated(legacy, legacy.written)).toEqual(["github-token"]);

    // and the current shape wins when present — an empty `changed` means "nothing
    // moved", which is exactly what (g1) proves end-to-end.
    const current = { written: ["github-token", "cma-api-key"], changed: [], failed: [] };
    expect(selectRotated(current, current.written)).toEqual([]);
  });

  // ── CTL-1612 (Codex P1, round 3): the restart notice is emitted BEFORE the
  //    materialization-shortfall early-return. The rotated boot-captured secret is
  //    already ON DISK by then, so an UNRELATED JSON/profile entry failing to
  //    materialize has no bearing on "a restart is now required".
  //
  //    Returning first lost the notice PERMANENTLY, and the loss is invisible to any
  //    single-run test: the marker stays at the old sha, so the next attempt
  //    re-decrypts and rewrites the SAME bytes, `changed` comes back EMPTY, and once
  //    the unrelated failure clears the marker advances having never asked for the
  //    restart — daemon left 401ing on the old credential forever. (g1) is the reason
  //    run 2 is silent: a byte-identical rewrite is correctly not a rotation. So the
  //    only run that can ever carry the notice is the one that also failed. ─────────

  test("(h1) shortfall run (unrelated JSON secret skipped) → restart-required STILL emitted for the rotated github-token", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json"); // succeeds → config.json
    touchSecret("config-adva.sops.json"); // fails → skipped (the UNRELATED failure)
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    // the credential this node is running on today — the bundle rotates it below
    writeFileSync(join(configDir, "github-token"), "fake-github-token-v1");
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
        if (p.endsWith("node-secret-files.sops.json")) return { "github-token": "fake-github-token-v2" };
        if (p.endsWith("config-adva.sops.json")) throw new Error("bad mac");
        return { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } };
      },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    // the refresh DID fall short, and the marker correctly stays behind so the next
    // tick retries the skipped JSON secret
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("secrets-skipped");
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA");

    // …and the rotated boot-captured file still landed on disk, so the restart notice
    // is owed REGARDLESS of the unrelated shortfall
    expect(readFileSync(join(configDir, "github-token"), "utf8")).toBe("fake-github-token-v2");
    expect(res.restartRequired).toEqual(["github-token"]);
    const names = emits.map((e) => e.name);
    expect(names).toContain("restart-required");
    expect(names).toContain("refresh-failed");
    const rr = emits.find((e) => e.name === "restart-required");
    expect(rr.payload).toMatchObject({ file: "github-token", fromSha: "OLDSHA", toSha: "NEWSHA" });
    // a shortfall run never claims success
    expect(names).not.toContain("refreshed");
  });

  test("(h2) ORDERING — on a shortfall run restart-required is emitted BEFORE refresh-failed (profile-write variant)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    writeFileSync(join(clusterDir, "secrets", "profile-files.sops.json"), "{cipher}");
    const profilesDir = join(configDir, "profiles");
    // Force the UNRELATED failure on the profile side this time: a DIRECTORY at the
    // profile's destination makes its write throw EISDIR.
    mkdirSync(join(profilesDir, "catalyst-cloud.env"), { recursive: true });
    writeFileSync(join(configDir, "webhook-secret"), "fake-hmac-key-v1");
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    const emits = [];
    const res = refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      profilesDir,
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA", true),
      decrypt: (p) => {
        if (p.endsWith("node-secret-files.sops.json")) return { "webhook-secret": "fake-hmac-key-v2" };
        if (p.endsWith("profile-files.sops.json")) return { "catalyst-cloud.env": "export GH_TEMP_PAT=x\n" };
        return { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } };
      },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("profile-write-failed");
    expect(res.restartRequired).toEqual(["webhook-secret"]);
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA");

    // The sequence is the assertion: emitting restart-required only AFTER the
    // shortfall gate would mean never emitting it at all (the early-return returns).
    const names = emits.map((e) => e.name);
    expect(names.indexOf("restart-required")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("refresh-failed")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("restart-required")).toBeLessThan(names.indexOf("refresh-failed"));
    expect(names).toEqual(["restart-required", "refresh-failed"]);
  });

  test("(h3) END-TO-END — shortfall run then clean run: the marker advances and the restart notice was NOT lost", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    touchSecret("config-adva.sops.json"); // the unrelated entry — fails on run 1 only
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    writeFileSync(join(configDir, "github-token"), "fake-github-token-v1");
    const statePath = join(configDir, ".state.json");
    writeMarker(statePath, "OLDSHA");

    // `adva` decrypts only once the (unrelated) failure has cleared.
    let advaHealthy = false;
    const runRefresh = (emits) =>
      refreshClusterSecretsIfChanged({
        clusterDir,
        configDir,
        statePath,
        git: baseGit,
        gitCapture: makeGitCapture("NEWSHA", true),
        decrypt: (p) => {
          // the bundle serves the SAME rotated bytes on both runs — run 1 puts them on
          // disk, so run 2's read-back sees no content change (see (g1))
          if (p.endsWith("node-secret-files.sops.json")) return { "github-token": "fake-github-token-v2" };
          if (p.endsWith("config-adva.sops.json")) {
            if (!advaHealthy) throw new Error("bad mac");
            return { ok: true };
          }
          return { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } };
        },
        emit: (e) => emits.push(e),
        now: () => "t",
        node: "test-node",
        logger: QUIET,
      });

    // ── run 1: the rotation lands on disk, but an unrelated JSON secret fails ──
    const run1Emits = [];
    const run1 = runRefresh(run1Emits);
    expect(run1.ok).toBe(false);
    expect(run1.reason).toBe("secrets-skipped");
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA"); // held back
    expect(readFileSync(join(configDir, "github-token"), "utf8")).toBe("fake-github-token-v2");

    // ── run 2: the unrelated failure clears; the token bytes are now IDENTICAL ──
    advaHealthy = true;
    const run2Emits = [];
    const run2 = runRefresh(run2Emits);
    expect(run2.ok).toBe(true);
    // the marker advances — from here on the fast-path returns head-unchanged, so this
    // is the LAST run that could ever have carried the notice
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("NEWSHA");
    // …and run 2 is silent about the restart, correctly: nothing moved on disk
    expect(run2.restartRequired).toEqual([]);
    expect(run2Emits.map((e) => e.name)).not.toContain("restart-required");

    // THE REGRESSION. Across the WHOLE sequence the operator was told to restart at
    // least once. A test that inspected only run 2 would pass against the old code,
    // which returned at the shortfall gate and dropped the notice forever.
    const allEmits = [...run1Emits, ...run2Emits];
    const restarts = allEmits.filter(
      (e) => e.name === "restart-required" && e.payload?.file === "github-token",
    );
    expect(restarts.length).toBeGreaterThanOrEqual(1);
    expect(restarts[0].payload).toMatchObject({ fromSha: "OLDSHA", toSha: "NEWSHA" });
  });

  test("(h4) NEGATIVE CONTROL — a shortfall run whose only bare change is non-boot-captured emits NO restart-required", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    touchSecret("config-adva.sops.json"); // the unrelated failure → secrets-skipped
    writeFileSync(join(clusterDir, "secrets", "node-secret-files.sops.json"), "{cipher}");
    // github-token is present and does NOT move; only the plain bare file rotates
    writeFileSync(join(configDir, "github-token"), "fake-github-token-v1");
    writeFileSync(join(configDir, "cma-api-key"), "fake-cma-key-v1");
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
        if (p.endsWith("node-secret-files.sops.json")) {
          return {
            "github-token": "fake-github-token-v1", // unchanged
            "cma-api-key": "fake-cma-key-v2", // the actual rotation
          };
        }
        if (p.endsWith("config-adva.sops.json")) throw new Error("bad mac");
        return { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } };
      },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("secrets-skipped");
    expect(readClusterSyncState(statePath).lastDecryptedSha).toBe("OLDSHA");
    // hoisting the emit above the early-return must NOT turn every shortfall run into
    // a restart nag — the predicate still gates on a boot-captured file that MOVED
    expect(res.restartRequired).toEqual([]);
    expect(emits.map((e) => e.name)).toEqual(["refresh-failed"]);
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

  test("boot PROFILE shortfall with a SAME-SHA marker → marker INVALIDATED so the refresh retries (Codex P2)", () => {
    seedClone();
    writeClusterJson({ schemaVersion: 1, roster: ["mini"] });
    touchSecret("cluster-bots.sops.json");
    writeFileSync(join(clusterDir, "secrets", "profile-files.sops.json"), "{cipher}");
    const statePath = join(configDir, ".state.json");
    // A prior marker already records the clone's CURRENT head — without
    // invalidation the refresh fast-path would return head-unchanged forever.
    writeFileSync(
      statePath,
      JSON.stringify({ lastDecryptedSha: "NEWSHA", lastDecryptedAt: "old", written: [], synced: [] }),
    );

    const emits = [];
    clusterSync({
      clusterDir,
      configDir,
      profilesDir: join(configDir, "profiles"),
      statePath,
      git: baseGit,
      gitCapture: makeGitCapture("NEWSHA"),
      decrypt: (p) => {
        if (p.endsWith("profile-files.sops.json")) throw new Error("bad mac");
        return { catalyst: { linear: { bot: { worker: { accessToken: "FRESH" } } } } };
      },
      emit: (e) => emits.push(e),
      now: () => "t",
      node: "test-node",
      logger: QUIET,
    });

    expect(emits.map((e) => e.name)).toContain("refresh-failed");
    expect(emits[0].payload.reason).toBe("profile-decrypt-failed");
    // The same-SHA marker is GONE — the periodic refresh will re-attempt.
    expect(readClusterSyncState(statePath)).toBeNull();
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

// CTL-1393 Codex re-review fixes (P1 env-backed restart detection + P2 canonical severity).
describe("cluster-secret event severity + env-backed set (Codex re-review)", () => {
  test("refresh-failed carries ERROR severity (17) for severity-based alert queries", () => {
    const ev = buildClusterSecretEnvelope({
      name: "refresh-failed",
      node: "n1",
      now: () => "t",
      payload: { reason: "decrypt-failed" },
    });
    expect(ev.severityText).toBe("ERROR");
    expect(ev.severityNumber).toBe(17);
    expect(ev.attributes["event.name"]).toBe("catalyst.cluster.secrets.refresh-failed");
  });

  test("restart-required is WARN (13), refreshed/other is INFO (9)", () => {
    const warn = buildClusterSecretEnvelope({ name: "restart-required", node: "n1", now: () => "t" });
    expect(warn.severityText).toBe("WARN");
    expect(warn.severityNumber).toBe(13);
    const info = buildClusterSecretEnvelope({ name: "refreshed", node: "n1", now: () => "t" });
    expect(info.severityText).toBe("INFO");
    expect(info.severityNumber).toBe(9);
  });

  test("ENV_BACKED_SECRET_FILES covers both launcher-sourced files", () => {
    // Membership rule: every file the daemon launcher `source`s into its boot env.
    expect(ENV_BACKED_SECRET_FILES.has("claude-accounts.env")).toBe(true);
    expect(ENV_BACKED_SECRET_FILES.has("execution-core.env")).toBe(true);
  });

  // CTL-1616 (A2): ENV_BACKED_SECRET_EXACT is now DERIVED from SECRET_REGISTRY
  // (lib/secret-contract.mjs) instead of hand-maintained in parallel with it (see the
  // derivation's own header comment above its definition). This test is the
  // before/after PARITY ASSERTION the design's "same-commit derivation constraint"
  // (§2) mandates for a load-bearing marker-advance gate: the derived set must equal
  // the EXACT historical literal set this file hand-maintained before the derivation,
  // byte-for-byte — a silent membership change here would (via isEnvBackedSecretFile →
  // assessMaterialization) either mask a real rotation's restart-required signal or
  // spuriously nag on a rotation that was never boot-captured.
  test("ENV_BACKED_SECRET_EXACT (derived from SECRET_REGISTRY) equals the historical hand-maintained literal set", () => {
    const historicalLiteralSet = new Set([
      "claude-accounts.env",
      "execution-core.env",
      "execution-core-secrets.env",
      "github-token",
      "webhook-secret",
      "linear-webhook-secret",
    ]);
    expect(new Set(ENV_BACKED_SECRET_FILES)).toEqual(historicalLiteralSet);
  });

  test("LINEAR_WEBHOOK_SECRET_PREFIX (derived from the registry's family row) still matches every historical family fixture", () => {
    // Cross-check via the PUBLIC predicate rather than reaching for the private prefix
    // constant directly — this is exactly the behavior isEnvBackedSecretFile's own
    // describe block below re-verifies in full; this test only pins the derivation
    // didn't silently change the prefix STRING itself.
    expect(isEnvBackedSecretFile("linear-webhook-secret-ctl")).toBe(true);
    expect(isEnvBackedSecretFile("linear-webhook-secret-CTL")).toBe(true);
    expect(isEnvBackedSecretFile("linear-webhook-secret-")).toBe(false);
    expect(isEnvBackedSecretFile("linear-webhook-secretXXX")).toBe(false);
  });
});

// CTL-1612. The predicate that decides which rotated files get a `restart-required`
// signal. Membership rule: "CAPTURED AT PROCESS START, therefore NOT live in a running
// process until it restarts" — whether captured by `source` into the boot env or by a
// single boot-time read closed over per request. Explicit truth table, because BOTH
// columns are load-bearing: too narrow re-creates the 2026-08-02 silent-stale outage,
// too broad turns every bundle rotation into a restart nag nobody reads.
describe("isEnvBackedSecretFile", () => {
  test("TRUE — every boot-captured file, incl. the linear-webhook-secret-<team> family", () => {
    // (a) `source`d into the daemon's boot env by catalyst-execution-core
    expect(isEnvBackedSecretFile("claude-accounts.env")).toBe(true);
    expect(isEnvBackedSecretFile("execution-core.env")).toBe(true);
    expect(isEnvBackedSecretFile("github-token")).toBe(true);
    // (b) read ONCE at orch-monitor boot (loadWebhookConfig), then closed over per
    //     request — never re-read per delivery, so a rotation is inert until restart
    expect(isEnvBackedSecretFile("webhook-secret")).toBe(true);
    expect(isEnvBackedSecretFile("linear-webhook-secret")).toBe(true);
    // the per-team FAMILY: names are built from Layer-2 team keys, so the set is
    // open-ended — an exact-match Set can never enumerate it
    expect(isEnvBackedSecretFile("linear-webhook-secret-ctl")).toBe(true);
    expect(isEnvBackedSecretFile("linear-webhook-secret-adv")).toBe(true);
    // …and team keys are NOT guaranteed lowercase. The case-insensitivity IS the
    // point: an anchored /^linear-webhook-secret-[a-z0-9-]+$/ would silently no-op
    // on "CTL" — exactly the miss this predicate exists to prevent.
    expect(isEnvBackedSecretFile("linear-webhook-secret-CTL")).toBe(true);
  });

  test("FALSE — family near-misses, plain bundle files, and non-string inputs", () => {
    // bare prefix, nothing after the dash — not a team secret, just the prefix
    expect(isEnvBackedSecretFile("linear-webhook-secret-")).toBe(false);
    // run-on with no dash separator — a prefix match alone must not be enough
    expect(isEnvBackedSecretFile("linear-webhook-secretXXX")).toBe(false);
    // genuine bundle files that nothing sources or boot-reads (over-broad guard)
    expect(isEnvBackedSecretFile("cma-api-key")).toBe(false);
    expect(isEnvBackedSecretFile("age.key")).toBe(false);
    // defensive: a decrypt map is attacker-adjacent input — never throw on junk
    expect(isEnvBackedSecretFile("")).toBe(false);
    expect(isEnvBackedSecretFile(null)).toBe(false);
    expect(isEnvBackedSecretFile(undefined)).toBe(false);
    expect(isEnvBackedSecretFile(42)).toBe(false);
  });

  test("TRUE — execution-core-secrets.env is boot-captured (CTL-2042)", () => {
    expect(isEnvBackedSecretFile("execution-core-secrets.env")).toBe(true);
  });
});

// ─── CTL-2042: syncHostEnvFiles — per-host plain posture materialization ─────

describe("syncHostEnvFiles (CTL-2042)", () => {
  const MINI_CONTENT =
    "export CATALYST_HOST_NAME=mini\nexport CATALYST_EXECUTOR=sdk\nexport CATALYST_LINEAR_WRITE_DAILY_BUDGET=2000\n" +
    "[ -f \"${HOME}/.config/catalyst/execution-core-secrets.env\" ] && . \"${HOME}/.config/catalyst/execution-core-secrets.env\"\n";
  const MINI2_CONTENT =
    "export CATALYST_HOST_NAME=mini-2\nexport CATALYST_EXECUTOR=sdk\nexport CATALYST_LINEAR_WRITE_DAILY_BUDGET=2000\n" +
    "[ -f \"${HOME}/.config/catalyst/execution-core-secrets.env\" ] && . \"${HOME}/.config/catalyst/execution-core-secrets.env\"\n";

  function writeHostPosture(host, content) {
    mkdirSync(join(clusterDir, "hosts", host), { recursive: true });
    writeFileSync(join(clusterDir, "hosts", host, "execution-core.env"), content);
  }

  test("selects the file matching this host and writes it to the canonical dest name", () => {
    writeHostPosture("mini", MINI_CONTENT);
    writeHostPosture("mini-2", MINI2_CONTENT);

    const written = [];
    const writeFile = (dest, content) => {
      written.push({ dest, content });
      writeFileSync(dest, content, { mode: 0o600 });
    };

    const res = syncHostEnvFiles({
      clusterDir,
      configDir,
      hostName: "mini",
      writeFile,
      logger: QUIET,
    });

    expect(res.written).toEqual(["execution-core.env"]);
    expect(written).toHaveLength(1);
    expect(written[0].dest).toBe(resolve(configDir, "execution-core.env"));
    expect(written[0].content).toBe(MINI_CONTENT);
    // mini-2's content was never written
    expect(written.some((w) => w.content === MINI2_CONTENT)).toBe(false);
  });

  test("Codex P2: writes to the CATALYST_EXECUTION_CORE_ENV override path, not the configDir default", () => {
    writeHostPosture("mini", MINI_CONTENT);
    const overridePath = join(configDir, "custom", "exec-core.env");

    const written = [];
    const writeFile = (dest, content) => {
      written.push({ dest, content });
      writeFileSync(dest, content, { mode: 0o600 });
    };

    const res = syncHostEnvFiles({
      clusterDir,
      configDir,
      hostName: "mini",
      env: { CATALYST_EXECUTION_CORE_ENV: overridePath },
      writeFile,
      logger: QUIET,
    });

    // Tracked dest NAME stays the logical basename (restart-required filter unaffected)…
    expect(res.written).toEqual(["execution-core.env"]);
    // …but the actual write lands at the launcher's canonical override path.
    expect(written).toHaveLength(1);
    expect(written[0].dest).toBe(resolve(overridePath));
    expect(written[0].content).toBe(MINI_CONTENT);
    // the parent dir of the override (outside configDir) was created
    expect(existsSync(resolve(overridePath))).toBe(true);
    // nothing was written to the configDir default
    expect(existsSync(join(configDir, "execution-core.env"))).toBe(false);
  });

  test("reports changed[] on the dest name when on-disk content differs", () => {
    writeHostPosture("mini", MINI_CONTENT);
    // pre-existing on-disk file with different content
    writeFileSync(join(configDir, "execution-core.env"), "old content");

    const res = syncHostEnvFiles({
      clusterDir,
      configDir,
      hostName: "mini",
      logger: QUIET,
    });

    expect(res.written).toContain("execution-core.env");
    expect(res.changed).toContain("execution-core.env");
  });

  test("omits from changed[] when on-disk already matches (rewrite, not change)", () => {
    writeHostPosture("mini", MINI_CONTENT);
    // pre-existing on-disk file with SAME content
    writeFileSync(join(configDir, "execution-core.env"), MINI_CONTENT);

    const res = syncHostEnvFiles({
      clusterDir,
      configDir,
      hostName: "mini",
      logger: QUIET,
    });

    expect(res.written).toContain("execution-core.env");
    expect(res.changed).not.toContain("execution-core.env");
  });

  test("no host file for getHostName() → skipped, reason set, nothing written", () => {
    // only mini exists; mini-3 does not
    writeHostPosture("mini", MINI_CONTENT);

    const written = [];
    const res = syncHostEnvFiles({
      clusterDir,
      configDir,
      hostName: "mini-3",
      writeFile: (dest, content) => { written.push(dest); writeFileSync(dest, content); },
      logger: QUIET,
    });

    expect(res.skipped).toBe(true);
    expect(typeof res.reason).toBe("string");
    expect(res.reason.length).toBeGreaterThan(0);
    expect(written).toHaveLength(0);
  });

  test("getHostName() throws → skipped, never writes a wrong host's file", () => {
    writeHostPosture("mini", MINI_CONTENT);

    const written = [];
    const res = syncHostEnvFiles({
      clusterDir,
      configDir,
      hostName: () => { throw new Error("hostname-probe-failed"); },
      writeFile: (dest, content) => { written.push(dest); writeFileSync(dest, content); },
      logger: QUIET,
    });

    expect(res.skipped).toBe(true);
    expect(written).toHaveLength(0);
  });

  test("writes posture at mode 0o600", () => {
    writeHostPosture("mini", MINI_CONTENT);

    const res = syncHostEnvFiles({
      clusterDir,
      configDir,
      hostName: "mini",
      logger: QUIET,
    });

    expect(res.written).toContain("execution-core.env");
    const mode = statSync(join(configDir, "execution-core.env")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("write failure → records name in failed[], written[] omits it", () => {
    writeHostPosture("mini", MINI_CONTENT);

    const res = syncHostEnvFiles({
      clusterDir,
      configDir,
      hostName: "mini",
      writeFile: () => { throw new Error("EIO"); },
      logger: QUIET,
    });

    expect(res.written).not.toContain("execution-core.env");
    expect(res.failed).toContain("execution-core.env");
  });

  test("changed dest from syncHostEnvFiles feeds catalyst.cluster.secrets.restart-required", () => {
    // Set up: mini's posture file exists in clusterDir; configDir has DIFFERENT content
    writeHostPosture("mini", MINI_CONTENT);
    writeFileSync(join(configDir, "execution-core.env"), "old content");

    // Simulate the secrets bundle for syncSecretFiles (the SOPS-encrypted secrets part)
    writeFileSync(
      join(clusterDir, "secrets", "node-secret-files.sops.json"),
      "{ciphertext-placeholder}",
    );

    // gitRevParseHead checks existsSync(clusterDir/.git) before calling gitCapture,
    // and expects { status: number, stdout: string } from gitCapture (same shape as
    // the rest of the refreshClusterSecretsIfChanged test suite).
    mkdirSync(join(clusterDir, ".git"), { recursive: true });

    const restartEvents = [];
    const emit = (evt) => { if (evt.name === "restart-required") restartEvents.push(evt); };

    // refreshClusterSecretsIfChanged calls syncHostEnvFiles internally and should
    // merge its changed[] into the restart-required emitter
    refreshClusterSecretsIfChanged({
      clusterDir,
      configDir,
      statePath: join(configDir, ".state.json"),
      git: () => {},
      gitCapture: (args) => {
        // gitRevParseHead calls gitCapture(["rev-parse", "HEAD"]) and checks status+stdout
        if (args.includes("rev-parse")) return { status: 0, stdout: "abc123\n" };
        // gitSecretsChangedBetween — no prior sha (readState null) so this is never called
        return { status: 1, stdout: "" };
      },
      decrypt: () => ({ "github-token": "tok" }),
      readState: () => null, // no prior state → always re-decrypt
      writeState: () => {},
      emit,
      now: () => "2026-01-01T00:00:00Z",
      node: "mini",
      // Inject syncHostEnvFiles override that returns a changed entry
      syncHostEnvFiles: ({ configDir: cd }) => {
        writeFileSync(join(cd, "execution-core.env"), MINI_CONTENT);
        return { written: ["execution-core.env"], changed: ["execution-core.env"], failed: [], skipped: false, reason: null };
      },
      logger: QUIET,
    });

    // execution-core.env is an env-file/boot-only → isEnvBackedSecretFile → restart-required
    expect(restartEvents.some((e) => e.payload?.file === "execution-core.env")).toBe(true);
  });
});
