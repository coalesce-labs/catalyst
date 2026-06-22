// cloud-token-env.mjs — CTL-1307. Project the cluster-shared CATALYST_CLOUD_TOKEN
// into the node's MACHINE-LEVEL environment.
//
// WHAT
// ----
// CATALYST_CLOUD_TOKEN is a single SHARED service credential (the catalyst-cloud
// ADMIN_TOKEN, interim per CTC-27 / ADR-0006), IDENTICAL on every node. It lives
// encrypted in the private catalyst-cluster repo as secrets/cluster-cloud.sops.json
// and is decrypted at daemon boot by cluster-sync.mjs (syncClusterSecrets) into
// ~/.config/catalyst/cluster-cloud.json (mode 0o600), exactly like every other
// cluster-shared secret. This module reads that decrypted artifact and projects the
// token as an ENVIRONMENT VARIABLE so the opt-in, OUT-OF-THIS-REPO host-sync daemon
// (catalyst-replica / catalyst-cloud) can present it as a bearer to the cloud feed.
//
// WHERE (two surfaces, mirroring how every other machine-level secret env var is
// provisioned on this fleet — see ~/.zshenv's existing CATALYST_WEBHOOK_SECRET,
// GITHUB_TOKEN, etc.):
//   1. ~/.config/catalyst/cluster.env  (mode 0o600)  — `export CATALYST_CLOUD_TOKEN=…`
//      The SECRET lives here only, never in the (commonly 0644) shell profile.
//   2. ~/.zshenv  — a single NON-secret guard line that sources cluster.env, so
//      every login/zsh shell — and any daemon (re)started in a shell context, which
//      is this fleet's convention for env-key pickup — inherits CATALYST_CLOUD_TOKEN.
//
// WHO RUNS IT
// ----------
// This is a SHORT-LIVED script invoked by the shell launcher (catalyst-stack
// cmd_start at boot + keep-alive, and `catalyst-stack sync-cloud-env` on demand) —
// NOT the long-lived execution-core daemon. The launcher decides WHEN to project;
// this module owns HOW. cluster-sync.mjs stays a pure decrypt module.
//
// POSTURE: FAIL-OPEN. Any failure (no decrypted token yet, unwritable file) leaves
// the node exactly as it was and never throws / never exits non-zero. A node with no
// token decrypted is a no-op — so a non-cloud node and a not-yet-synced node are both
// left untouched. Setting the token changes NO local catalyst behavior: nothing in
// this repo reads CATALYST_CLOUD_TOKEN; only the opt-in cloud host-sync daemon does.

import {
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  renameSync,
  appendFileSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

// Sentinel-delimited managed block in ~/.zshenv. The block holds only the
// NON-secret source-guard; the token itself stays in the 0o600 cluster.env.
export const GUARD_BEGIN = "# >>> catalyst cloud-token env (CTL-1307) >>>";
export const GUARD_END = "# <<< catalyst cloud-token env (CTL-1307) <<<";
// Literal $HOME so the line is portable to whatever user sources it.
export const GUARD_SOURCE_LINE =
  '[ -r "$HOME/.config/catalyst/cluster.env" ] && . "$HOME/.config/catalyst/cluster.env"';

function defaultConfigDir() {
  return process.env.CATALYST_CONFIG_DIR || resolve(homedir(), ".config", "catalyst");
}
function defaultZshenvPath() {
  return process.env.CATALYST_ZSHENV_FILE || resolve(homedir(), ".zshenv");
}

// shellSingleQuote — wrap a value as a safe single-quoted POSIX-shell literal,
// escaping embedded single quotes ('  ->  '\'' ). Defeats command/expansion
// injection from a hostile token value when the line is later sourced.
export function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// renderClusterEnv — the exact 0o600 cluster.env content for a token. Pure.
export function renderClusterEnv(token) {
  return (
    "# Managed by catalyst (CTL-1307) — cluster-shared cloud token. Do not edit by hand.\n" +
    "# Source: catalyst-cluster secrets/cluster-cloud.sops.json -> ~/.config/catalyst/cluster-cloud.json (cluster-sync).\n" +
    `export CATALYST_CLOUD_TOKEN=${shellSingleQuote(token)}\n`
  );
}

// readCloudToken — extract .catalyst.cloud.token from the decrypted cluster-cloud.json.
// Returns "" when absent / unreadable / malformed / non-string (never throws).
export function readCloudToken(opts = {}) {
  const { configDir = defaultConfigDir(), readFile = (p) => readFileSync(p, "utf8") } = opts;
  try {
    const obj = JSON.parse(readFile(resolve(configDir, "cluster-cloud.json")));
    const t = obj?.catalyst?.cloud?.token;
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

// defaultWriteFileAtomic — write via tmp + rename so a concurrent daemon boot
// never observes a half-written cluster.env. 0o600 on both tmp and final.
function defaultWriteFileAtomic(dest, body) {
  const dir = dirname(dest);
  mkdirSync(dir, { recursive: true });
  const tmp = resolve(dir, `.cluster.env.${process.pid}.tmp`);
  writeFileSync(tmp, body, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, dest);
  chmodSync(dest, 0o600);
}

// writeClusterEnv — atomically write cluster.env (0o600) IFF the content changed.
// Idempotent: a repeated boot with the same token is a no-op (no rewrite). A
// rotated token (value changed) is detected by the content diff and rewritten.
// Returns { written: boolean, reason }.
export function writeClusterEnv(token, opts = {}) {
  const {
    configDir = defaultConfigDir(),
    readFile = (p) => readFileSync(p, "utf8"),
    writeFileAtomic = defaultWriteFileAtomic,
  } = opts;
  const dest = resolve(configDir, "cluster.env");
  const body = renderClusterEnv(token);
  try {
    if (readFile(dest) === body) return { written: false, reason: "unchanged" };
  } catch {
    /* missing / unreadable → fall through and write */
  }
  writeFileAtomic(dest, body);
  return { written: true, reason: "written" };
}

// ensureZshenvGuard — idempotently add the sentinel-marked NON-secret source-guard
// block to ~/.zshenv. grep-style presence check on GUARD_BEGIN so it is never
// duplicated across boots. Creates ~/.zshenv if absent (append). The token never
// touches this file — only the guard that sources the 0o600 cluster.env.
// Returns { added: boolean, reason }.
export function ensureZshenvGuard(opts = {}) {
  const {
    zshenvPath = defaultZshenvPath(),
    readFile = (p) => readFileSync(p, "utf8"),
    appendFile = (p, s) => appendFileSync(p, s),
  } = opts;
  let existing = "";
  try {
    existing = readFile(zshenvPath);
  } catch {
    /* missing → append creates it */
  }
  if (existing.includes(GUARD_BEGIN)) return { added: false, reason: "present" };
  const block = `\n${GUARD_BEGIN}\n${GUARD_SOURCE_LINE}\n${GUARD_END}\n`;
  appendFile(zshenvPath, block);
  return { added: true, reason: "added" };
}

// syncCloudTokenEnv — the entrypoint. FAIL-OPEN: never throws.
// No token decrypted → no-op (node left untouched). Otherwise: write the 0o600
// cluster.env and ensure the ~/.zshenv guard. Returns a status object.
export function syncCloudTokenEnv(opts = {}) {
  const { logger = console } = opts;
  const result = { token: false, clusterEnv: null, zshenv: null, reason: null };

  let token = "";
  try {
    token = readCloudToken(opts);
  } catch {
    token = "";
  }
  if (!token) {
    result.reason = "no-token";
    return result;
  }
  // A multi-line value can't sit on one `export` line and signals corruption —
  // refuse rather than emit a broken (and potentially injectable) profile entry.
  if (/[\r\n]/.test(token)) {
    logger.warn?.("[cloud-token-env] refusing multi-line CATALYST_CLOUD_TOKEN (corrupt?)");
    result.reason = "multiline-token";
    return result;
  }

  result.token = true;
  try {
    result.clusterEnv = writeClusterEnv(token, opts);
  } catch (err) {
    logger.warn?.(`[cloud-token-env] cluster.env write failed (${err?.message ?? err}); continuing`);
    result.clusterEnv = { written: false, reason: "error" };
  }
  try {
    result.zshenv = ensureZshenvGuard(opts);
  } catch (err) {
    logger.warn?.(`[cloud-token-env] ~/.zshenv guard failed (${err?.message ?? err}); continuing`);
    result.zshenv = { added: false, reason: "error" };
  }
  return result;
}

// CLI entry — invoked by catalyst-stack (cmd_start + `sync-cloud-env`). Always
// exits 0 (fail-open): provisioning the token must never wedge stack startup.
const _invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  process.argv[1].endsWith("cloud-token-env.mjs");

if (_invokedDirectly) {
  const res = syncCloudTokenEnv();
  if (res.token) {
    const parts = [];
    if (res.clusterEnv?.written) parts.push("cluster.env updated");
    else if (res.clusterEnv?.reason === "unchanged") parts.push("cluster.env unchanged");
    if (res.zshenv?.added) parts.push("~/.zshenv guard added");
    process.stdout.write(
      `[cloud-token-env] ${parts.length ? parts.join("; ") : "up to date"}\n`,
    );
  } else if (res.reason === "multiline-token") {
    process.stdout.write("[cloud-token-env] refused malformed (multi-line) token — nothing written\n");
  } else {
    process.stdout.write(
      "[cloud-token-env] no cloud token provisioned — node stays local-only (nothing to do)\n",
    );
  }
  process.exit(0);
}
