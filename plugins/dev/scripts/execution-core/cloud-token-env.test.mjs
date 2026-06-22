// cloud-token-env.test.mjs — CTL-1307. Hermetic: every test points the module at a
// throwaway tmp config dir + tmp ~/.zshenv via opts, so no real ~/.config/catalyst
// or ~/.zshenv is ever touched.
//
// Run: cd plugins/dev/scripts/execution-core && bun test cloud-token-env.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCloudToken,
  renderClusterEnv,
  shellSingleQuote,
  writeClusterEnv,
  ensureZshenvGuard,
  syncCloudTokenEnv,
  GUARD_BEGIN,
  GUARD_END,
} from "./cloud-token-env.mjs";

const QUIET = { warn() {}, info() {} };
let configDir, zshenvPath;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "cte-config-"));
  zshenvPath = join(mkdtempSync(join(tmpdir(), "cte-home-")), ".zshenv");
});
afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(zshenvPath, { force: true });
});

const writeClusterCloudJson = (token) =>
  writeFileSync(
    join(configDir, "cluster-cloud.json"),
    JSON.stringify({ catalyst: { cloud: { token } } }),
  );
const clusterEnvPath = () => join(configDir, "cluster.env");

describe("shellSingleQuote", () => {
  test("wraps a plain value", () => {
    expect(shellSingleQuote("abc123")).toBe("'abc123'");
  });
  test("escapes embedded single quotes (injection-safe)", () => {
    // a'b  ->  'a'\''b'
    expect(shellSingleQuote("a'b")).toBe("'a'\\''b'");
  });
  test("a command-injection attempt stays inert single-quoted data", () => {
    const evil = "x'; rm -rf $HOME; echo '";
    const quoted = shellSingleQuote(evil);
    // The whole thing is a single quoted literal — no unescaped quote can break out.
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted).toBe("'x'\\''; rm -rf $HOME; echo '\\'''");
  });
});

describe("readCloudToken", () => {
  test("reads catalyst.cloud.token from cluster-cloud.json", () => {
    writeClusterCloudJson("admintok_123");
    expect(readCloudToken({ configDir })).toBe("admintok_123");
  });
  test("absent file → empty string (never throws)", () => {
    expect(readCloudToken({ configDir })).toBe("");
  });
  test("malformed JSON → empty string (never throws)", () => {
    writeFileSync(join(configDir, "cluster-cloud.json"), "{not json");
    expect(readCloudToken({ configDir })).toBe("");
  });
  test("missing token key → empty string", () => {
    writeFileSync(join(configDir, "cluster-cloud.json"), JSON.stringify({ catalyst: { cloud: {} } }));
    expect(readCloudToken({ configDir })).toBe("");
  });
});

describe("renderClusterEnv", () => {
  test("emits a single export line with the token single-quoted", () => {
    const body = renderClusterEnv("tok");
    expect(body).toContain("export CATALYST_CLOUD_TOKEN='tok'\n");
    expect(body.endsWith("\n")).toBe(true);
  });
});

describe("writeClusterEnv", () => {
  test("writes cluster.env at 0600 with the export line", () => {
    const res = writeClusterEnv("tok_abc", { configDir });
    expect(res).toEqual({ written: true, reason: "written" });
    const body = readFileSync(clusterEnvPath(), "utf8");
    expect(body).toContain("export CATALYST_CLOUD_TOKEN='tok_abc'");
    expect(statSync(clusterEnvPath()).mode & 0o777).toBe(0o600);
  });

  test("idempotent: identical token → no rewrite (written:false)", () => {
    writeClusterEnv("same", { configDir });
    const res = writeClusterEnv("same", { configDir });
    expect(res).toEqual({ written: false, reason: "unchanged" });
  });

  test("rotation: changed token → rewrite with the new value", () => {
    writeClusterEnv("old", { configDir });
    const res = writeClusterEnv("new", { configDir });
    expect(res.written).toBe(true);
    const body = readFileSync(clusterEnvPath(), "utf8");
    expect(body).toContain("export CATALYST_CLOUD_TOKEN='new'");
    expect(body).not.toContain("'old'");
  });

  test("writes are atomic — final file is complete, no stray tmp left", () => {
    writeClusterEnv("tok", { configDir });
    // Only cluster.env should remain (the tmp was renamed away).
    const stray = existsSync(join(configDir, ".cluster.env." + process.pid + ".tmp"));
    expect(stray).toBe(false);
  });
});

describe("ensureZshenvGuard", () => {
  test("adds the sentinel-marked guard block once", () => {
    const res = ensureZshenvGuard({ zshenvPath });
    expect(res).toEqual({ added: true, reason: "added" });
    const body = readFileSync(zshenvPath, "utf8");
    expect(body).toContain(GUARD_BEGIN);
    expect(body).toContain(GUARD_END);
    expect(body).toContain("cluster.env");
    // The token is NOT in the profile — only the source guard.
    expect(body).not.toContain("CATALYST_CLOUD_TOKEN=");
  });

  test("idempotent: second call does not duplicate the block", () => {
    ensureZshenvGuard({ zshenvPath });
    const res = ensureZshenvGuard({ zshenvPath });
    expect(res).toEqual({ added: false, reason: "present" });
    const body = readFileSync(zshenvPath, "utf8");
    const occurrences = body.split(GUARD_BEGIN).length - 1;
    expect(occurrences).toBe(1);
  });

  test("preserves existing ~/.zshenv content (append, not overwrite)", () => {
    writeFileSync(zshenvPath, "export EXISTING=1\n");
    ensureZshenvGuard({ zshenvPath });
    const body = readFileSync(zshenvPath, "utf8");
    expect(body).toContain("export EXISTING=1");
    expect(body).toContain(GUARD_BEGIN);
  });

  test("missing ~/.zshenv → created with the guard", () => {
    expect(existsSync(zshenvPath)).toBe(false);
    ensureZshenvGuard({ zshenvPath });
    expect(existsSync(zshenvPath)).toBe(true);
    expect(readFileSync(zshenvPath, "utf8")).toContain(GUARD_BEGIN);
  });
});

describe("syncCloudTokenEnv (entrypoint, fail-open)", () => {
  test("no cluster-cloud.json → no-op, no files touched", () => {
    const res = syncCloudTokenEnv({ configDir, zshenvPath, logger: QUIET });
    expect(res.token).toBe(false);
    expect(res.reason).toBe("no-token");
    expect(existsSync(clusterEnvPath())).toBe(false);
    expect(existsSync(zshenvPath)).toBe(false);
  });

  test("token present → writes cluster.env AND the ~/.zshenv guard", () => {
    writeClusterCloudJson("admintok_xyz");
    const res = syncCloudTokenEnv({ configDir, zshenvPath, logger: QUIET });
    expect(res.token).toBe(true);
    expect(res.clusterEnv.written).toBe(true);
    expect(res.zshenv.added).toBe(true);
    expect(readFileSync(clusterEnvPath(), "utf8")).toContain("export CATALYST_CLOUD_TOKEN='admintok_xyz'");
    expect(readFileSync(zshenvPath, "utf8")).toContain(GUARD_BEGIN);
  });

  test("repeated sync is fully idempotent (nothing rewritten/duplicated)", () => {
    writeClusterCloudJson("tok");
    syncCloudTokenEnv({ configDir, zshenvPath, logger: QUIET });
    const res = syncCloudTokenEnv({ configDir, zshenvPath, logger: QUIET });
    expect(res.clusterEnv.written).toBe(false);
    expect(res.zshenv.added).toBe(false);
    const occurrences = readFileSync(zshenvPath, "utf8").split(GUARD_BEGIN).length - 1;
    expect(occurrences).toBe(1);
  });

  test("rotation: new token in cluster-cloud.json → cluster.env updated", () => {
    writeClusterCloudJson("old");
    syncCloudTokenEnv({ configDir, zshenvPath, logger: QUIET });
    writeClusterCloudJson("rotated");
    const res = syncCloudTokenEnv({ configDir, zshenvPath, logger: QUIET });
    expect(res.clusterEnv.written).toBe(true);
    expect(readFileSync(clusterEnvPath(), "utf8")).toContain("export CATALYST_CLOUD_TOKEN='rotated'");
  });

  test("multi-line token → refused, nothing written (fail-open)", () => {
    writeClusterCloudJson("line1\nline2");
    const res = syncCloudTokenEnv({ configDir, zshenvPath, logger: QUIET });
    expect(res.token).toBe(false);
    expect(res.reason).toBe("multiline-token");
    expect(existsSync(clusterEnvPath())).toBe(false);
  });

  test("token with shell metacharacters stays inert single-quoted data", () => {
    writeClusterCloudJson("a'b$c`d");
    syncCloudTokenEnv({ configDir, zshenvPath, logger: QUIET });
    const body = readFileSync(clusterEnvPath(), "utf8");
    expect(body).toContain("export CATALYST_CLOUD_TOKEN='a'\\''b$c`d'");
  });

  test("never throws even when cluster.env dir is read-only (write failure)", () => {
    writeClusterCloudJson("tok");
    const boom = () => {
      throw new Error("EROFS");
    };
    // Inject a failing atomic writer to simulate an unwritable target.
    const res = syncCloudTokenEnv({
      configDir,
      zshenvPath,
      writeFileAtomic: boom,
      logger: QUIET,
    });
    expect(res.token).toBe(true);
    expect(res.clusterEnv.reason).toBe("error");
    // ~/.zshenv guard still attempted (independent of cluster.env failure).
    expect(res.zshenv.added).toBe(true);
  });
});
