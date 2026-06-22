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
