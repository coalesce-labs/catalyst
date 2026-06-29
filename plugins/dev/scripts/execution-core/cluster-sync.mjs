// cluster-sync.mjs — CTL-1211. Boot-time cluster control-plane sync.
//
// Clones/pulls the catalyst-cluster repo and decrypts secrets/*.sops.json into
// ~/.config/catalyst/ (mode 0o600), so every EXISTING secret consumer reads the
// same plaintext files it does today — consumer-transparent (DRY). This is the
// load-side of the GitOps control plane: "secret-sync becomes git-sync".
//
// Posture: FAIL-OPEN. Any failure (no cluster repo, sops missing, a single file
// won't decrypt, schema too new) leaves today's node-local plaintext untouched
// and never throws. Worst case is "node keeps running on its cached secrets",
// never corruption — the same guarantee dispatch already gives.
//
// Mapping (secrets/<name>.sops.json → ~/.config/catalyst/<dest>.json):
//   cluster-bots.sops.json        → config.json        (deep-merged: preserves
//                                    node-local host.name / cluster anchor /
//                                    monitor webhook state, overlays bot creds)
//   config-<projectKey>.sops.json → config-<projectKey>.json
//   cluster-cloud.sops.json       → cluster-cloud.json  (CTL-1307: the shared
//                                    catalyst-cloud token { catalyst.cloud.token } —
//                                    a separate file so its rotation/GC lifecycle is
//                                    independent of bot creds, superseded per CTC-46.
//                                    Decrypted by the generic destForSecret path
//                                    below; cloud-token-env.mjs then projects it into
//                                    the machine-level environment. No special-casing.)
//
// Roster (cluster.json.roster) is read LIVE per tick by config.getClusterHosts();
// secrets here are decrypted at BOOT. So a roster change needs no restart, but a
// secret rotation needs a worker restart to be picked up.

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { resolve, basename, dirname, delimiter } from "node:path";
import { homedir } from "node:os";
import {
  log,
  getClusterRepoDir,
  readClusterConfig,
  getLayer2ConfigPath,
  getClusterSyncStatePath,
  getEventLogPath,
  getHostName,
} from "./config.mjs";
import { writeSecretConfig } from "./write-secret-config.mjs";
import { schemaCompat } from "./config-schema.mjs";
import { nodeClass } from "./lib/node-class.mjs";

// Default age key location on every node (the private half; mode 0o600).
function defaultAgeKeyFile() {
  return resolve(homedir(), ".config", "catalyst", "age.key");
}

// The directory holding the decrypted Layer-2 plaintext files (~/.config/catalyst).
function defaultConfigDir() {
  return dirname(getLayer2ConfigPath());
}

// Known absolute install locations for the `sops` binary, checked IN ORDER before
// a PATH scan. CTL-1393 root cause: the daemon is launchd/shell-started with a
// RESTRICTED PATH that frequently omits /opt/homebrew/bin, so a bare `sops` spawn
// silently ENOENTs and decrypt fails fail-open — a node then runs forever on stale
// secrets with no signal. Resolving an ABSOLUTE path (and augmenting the spawn
// PATH) makes that impossible.
const SOPS_CANDIDATES = ["/opt/homebrew/bin/sops", "/usr/local/bin/sops", "/usr/bin/sops"];

// Directories prepended to the spawn env PATH so sops itself — and any helper it
// shells out to (e.g. age) — resolves even under a restricted daemon PATH.
const SOPS_PATH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

// resolveSopsBin — find an absolute sops path robustly. Checks the known install
// locations first, then scans PATH. Returns the absolute path, or null when sops
// cannot be found ANYWHERE (a LOUD, distinct failure — callers emit refresh-failed
// rather than silently no-op'ing). Injectable for hermetic tests.
export function resolveSopsBin(opts = {}) {
  const {
    candidates = SOPS_CANDIDATES,
    pathEnv = process.env.PATH || "",
    pathSep = delimiter,
    fileExists = (p) => existsSync(p),
  } = opts;
  for (const c of candidates) {
    if (fileExists(c)) return c;
  }
  for (const dir of pathEnv.split(pathSep)) {
    if (!dir) continue;
    const p = resolve(dir, "sops");
    if (fileExists(p)) return p;
  }
  return null;
}

// augmentedPath — the spawn PATH with the known sops/age dirs prepended (deduped),
// so a restricted daemon PATH still resolves sops + its helpers.
function augmentedPath(basePath = process.env.PATH || "") {
  const seen = new Set();
  const parts = [];
  for (const d of [...SOPS_PATH_DIRS, ...basePath.split(delimiter)]) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    parts.push(d);
  }
  return parts.join(delimiter);
}

// makeSopsDecrypt — build a `sops --decrypt` runner bound to an age key file.
// Injected as `decrypt` so tests never shell out. Resolves an ABSOLUTE sops path
// (PATH-robust, CTL-1393) and augments the spawn PATH; throws a distinct
// SOPS_NOT_FOUND error when sops is unresolvable so callers surface it LOUDLY
// instead of silently keeping stale secrets.
function makeSopsDecrypt(ageKeyFile, deps = {}) {
  const { resolveSops = resolveSopsBin, spawn = execFileSync } = deps;
  return (secretPath) => {
    const sopsBin = resolveSops();
    if (!sopsBin) {
      const err = new Error(
        "sops binary not found (checked known install dirs + PATH); cannot decrypt cluster secrets",
      );
      err.code = "SOPS_NOT_FOUND";
      throw err;
    }
    const out = spawn(
      sopsBin,
      ["--decrypt", "--input-type", "json", "--output-type", "json", secretPath],
      {
        env: { ...process.env, SOPS_AGE_KEY_FILE: ageKeyFile, PATH: augmentedPath() },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return JSON.parse(out);
  };
}

// Real `git` runner. Injected as `git` so tests never shell out.
function defaultGit(args) {
  execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// destForSecret — map a secrets/ filename to its ~/.config/catalyst destination.
function destForSecret(name, configDir) {
  const base = basename(name).replace(/\.sops\.json$/, "");
  if (base === "cluster-bots") return resolve(configDir, "config.json");
  return resolve(configDir, `${base}.json`);
}

// pullClusterRepo — best-effort `git pull --ff-only` on the cluster clone.
// Never throws; returns a small status object.
export function pullClusterRepo(opts = {}) {
  const {
    clusterDir = getClusterRepoDir(),
    git = defaultGit,
    logger = log,
  } = opts;
  if (!existsSync(resolve(clusterDir, ".git"))) {
    return { pulled: false, reason: "not-a-clone" };
  }
  try {
    git(["-C", clusterDir, "pull", "--ff-only"]);
    return { pulled: true };
  } catch (err) {
    logger.warn(
      `[cluster-sync] git pull failed (${err?.message ?? err}); using cached cluster config`,
    );
    return { pulled: false, reason: "pull-failed" };
  }
}

// syncClusterSecrets — decrypt every secrets/*.sops.json into ~/.config/catalyst.
// Fail-open per file (a single bad decrypt is skipped, the rest proceed) and
// fail-closed on a too-new schema (refuse the whole sync, keep node-local).
export function syncClusterSecrets(opts = {}) {
  const {
    clusterDir = getClusterRepoDir(),
    configDir = defaultConfigDir(),
    ageKeyFile = defaultAgeKeyFile(),
    decrypt = makeSopsDecrypt(ageKeyFile),
    writeSecret = writeSecretConfig,
    logger = log,
  } = opts;

  const result = { ok: true, synced: [], skipped: [], schemaSkipped: false, reason: null };

  const cluster = readClusterConfig(clusterDir);
  if (!cluster) {
    result.ok = false;
    result.reason = "no-cluster-repo";
    return result;
  }

  const compat = schemaCompat(cluster.schemaVersion);
  if (compat === "too-new") {
    logger.warn(
      `[cluster-sync] cluster.json schemaVersion ${cluster.schemaVersion} exceeds supported; ` +
        `refusing secret sync (fail-closed). Upgrade this node's stack.`,
    );
    result.ok = false;
    result.schemaSkipped = true;
    result.reason = "schema-too-new";
    return result;
  }

  const secretsDir = resolve(clusterDir, "secrets");
  let files;
  try {
    // node-secret-files.sops.json is the bare-file bundle handled by
    // syncSecretFiles(), NOT a JSON config — exclude it here so it isn't
    // double-processed into a stray config-style file.
    files = readdirSync(secretsDir).filter(
      (f) => f.endsWith(".sops.json") && f !== "node-secret-files.sops.json",
    );
  } catch {
    result.ok = false;
    result.reason = "no-secrets-dir";
    return result;
  }

  for (const f of files) {
    try {
      const obj = decrypt(resolve(secretsDir, f));
      if (!obj || typeof obj !== "object") throw new Error("decrypt produced non-object");
      const dest = destForSecret(f, configDir);
      writeSecret(dest, obj);
      result.synced.push(basename(dest));
    } catch (err) {
      logger.warn(
        `[cluster-sync] decrypt failed for ${f} (${err?.message ?? err}); keeping node-local plaintext`,
      );
      result.skipped.push(f);
    }
  }
  return result;
}

// Default 0o600 writer for a single bare secret file.
function defaultWriteFile(path, content) {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// syncSecretFiles — decrypt secrets/node-secret-files.sops.json (a { filename:
// content } map of cluster-shared BARE secret files — Linear webhook secrets,
// cma-api-key, the workflow GitHub token) and materialize each as a 0o600 file
// directly under ~/.config/catalyst. This covers the secrets that live outside
// the JSON configs (the .env / bare-file surface). Fail-open; never throws.
// Path-traversal-safe: only bare basenames are written into configDir.
//
// Return shape (CTL-1393 / Codex-A): `written[]` is the subset that materialized
// AND `failed[]` is the subset that was REQUESTED (a valid basename with string
// content) but whose write threw. A non-empty `failed[]` is a PARTIAL bare-file
// failure — the change-detection marker must NOT advance over it (else the stale
// fast-path strands the un-written secret forever). `failed[]` deliberately
// excludes unsafe/path-traversal names and non-string values: those are invalid
// INPUT we refuse, not materialization failures. Backward-compatible additive field.
export function syncSecretFiles(opts = {}) {
  const {
    clusterDir = getClusterRepoDir(),
    configDir = defaultConfigDir(),
    ageKeyFile = defaultAgeKeyFile(),
    decrypt = makeSopsDecrypt(ageKeyFile),
    writeFile = defaultWriteFile,
    logger = log,
  } = opts;

  const result = { written: [], failed: [], skipped: false, reason: null };
  const src = resolve(clusterDir, "secrets", "node-secret-files.sops.json");
  if (!existsSync(src)) {
    result.reason = "absent";
    return result;
  }
  let map;
  try {
    map = decrypt(src);
  } catch (err) {
    logger.warn(
      `[cluster-sync] decrypt node-secret-files failed (${err?.message ?? err}); keeping node-local`,
    );
    result.skipped = true;
    result.reason = "decrypt-failed";
    return result;
  }
  if (!map || typeof map !== "object") {
    result.reason = "empty";
    return result;
  }
  try {
    mkdirSync(configDir, { recursive: true });
  } catch {
    /* configDir usually exists; ignore */
  }
  for (const [name, content] of Object.entries(map)) {
    // Refuse anything that isn't a bare, non-dotfile basename — no path traversal.
    if (typeof name !== "string" || name !== basename(name) || name.startsWith(".") || name.length === 0) {
      logger.warn(`[cluster-sync] refusing unsafe secret-file name "${name}"`);
      continue;
    }
    if (typeof content !== "string") continue;
    try {
      writeFile(resolve(configDir, name), content);
      result.written.push(name);
    } catch (err) {
      logger.warn(`[cluster-sync] write ${name} failed (${err?.message ?? err})`);
      // Partial bare-file failure: a REQUESTED file decrypted but did not
      // materialize. Surfaced so the marker does not advance over it (Codex-A).
      result.failed.push(name);
    }
  }
  return result;
}

// ─── CTL-1393: durable change-detection + periodic refresh ───────────────────

// Default ISO clock for the marker's lastDecryptedAt. Injectable as `now` so tests
// stay deterministic (never call Date.now() in a way tests can't pin).
const defaultNow = () => new Date().toISOString();

// defaultGitCapture — a CAPTURING git runner (rev-parse / diff) that NEVER throws;
// returns { status, stdout }. Injected as `gitCapture` so tests never shell out.
// (defaultGit above is the MUTATING runner used by pullClusterRepo.)
function defaultGitCapture(args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return { status: r.status ?? (r.error ? 1 : 0), stdout: r.stdout ?? "" };
}

// gitRevParseHead — resolve the cluster clone's current HEAD sha, or null when the
// dir is not a clone / rev-parse fails. Never throws.
function gitRevParseHead({ clusterDir, gitCapture }) {
  if (!existsSync(resolve(clusterDir, ".git"))) return null;
  const r = gitCapture(["-C", clusterDir, "rev-parse", "HEAD"]);
  if (!r || r.status !== 0) return null;
  const sha = (r.stdout || "").trim();
  return sha.length ? sha : null;
}

// gitSecretsChangedBetween — does `secrets/` differ between two shas? Uses
// `git diff --quiet <from> <to> -- secrets/` (exit 0 = identical, 1 = changed). Any
// other exit (e.g. an unknown sha) → assume CHANGED: a needless re-decrypt is cheap,
// a missed rotation is the bug we're fixing. Never throws.
function gitSecretsChangedBetween({ clusterDir, fromSha, toSha, gitCapture }) {
  const r = gitCapture(["-C", clusterDir, "diff", "--quiet", fromSha, toSha, "--", "secrets/"]);
  if (r && r.status === 0) return false;
  return true;
}

// readClusterSyncState — parse the change-detection marker, or null when
// absent/malformed (treated as "never decrypted"). Never throws.
export function readClusterSyncState(statePath = getClusterSyncStatePath()) {
  try {
    const obj = JSON.parse(readFileSync(statePath, "utf8"));
    if (obj && typeof obj === "object") return obj;
  } catch {
    /* absent/malformed → null */
  }
  return null;
}

// writeClusterSyncState — atomically persist the marker (tmp + rename). Best-effort;
// returns true/false, never throws.
export function writeClusterSyncState(statePath, state, logger = log) {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`;
    // 0o600 for posture parity with the 0o600 secret files. The marker holds no
    // secret VALUES (only shas + filenames), but keeping it owner-only matches the
    // rest of ~/.config/catalyst and costs nothing.
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, statePath);
    return true;
  } catch (err) {
    logger?.warn?.(`[cluster-sync] marker write failed (${err?.message ?? err})`);
    return false;
  }
}

// buildClusterSecretEnvelope — OTel envelope for the catalyst.cluster.secrets.*
// namespace (CTL-1393). This is a NEW namespace: it does NOT collide with the
// broker-protected filter.* / broker.daemon.* / session.heartbeat / phase.* spaces,
// and resource.service.name is "catalyst.execution-core" (NOT "catalyst.broker"), so
// the broker's shouldSkipEvent self-filter passes it through.
export function buildClusterSecretEnvelope({ name, node, now = defaultNow, payload = {} }) {
  return {
    ts: now(),
    attributes: { "event.name": `catalyst.cluster.secrets.${name}` },
    resource: {
      "service.name": "catalyst.execution-core",
      "host.name": node,
      "catalyst.node.class": nodeClass(),
    },
    body: { payload: { node, ...payload } },
  };
}

// emitClusterSecretEvent — append a cluster-secret event to the unified log.
// Best-effort: NEVER throws (a logging failure must not break the refresh tick).
export function emitClusterSecretEvent(opts = {}, io = {}) {
  const { logPath = getEventLogPath(), appendFile = appendFileSync, logger = log } = io;
  try {
    const env = buildClusterSecretEnvelope(opts);
    mkdirSync(dirname(logPath), { recursive: true });
    appendFile(logPath, JSON.stringify(env) + "\n");
  } catch (err) {
    logger?.warn?.(
      `[cluster-sync] emit catalyst.cluster.secrets.${opts?.name} failed (${err?.message ?? err})`,
    );
  }
}

// ENV_BACKED_SECRET_FILES — bare secret files whose VALUE is consumed from
// process.env at boot (sourced by the daemon launcher), NOT re-read from disk per
// use. CTL-1398: the launcher sources claude-accounts.env to export
// CLAUDE_CODE_OAUTH_TOKEN, which resolveSdkBootExecutor + sdkRunPhaseAgent read from
// process.env. Re-materializing such a file on disk does NOT make the new value live
// in the running daemon — only a restart re-sources it. So when a refresh touches one
// of these, we must emit a DISTINCT "restart-required" signal rather than let the
// "refreshed" event imply the env secret is already applied (Codex-B).
export const ENV_BACKED_SECRET_FILES = new Set(["claude-accounts.env"]);

// assessMaterialization — Codex-A. Decide whether a refresh/boot decrypt FULLY
// succeeded, given the syncClusterSecrets (`sync`) and syncSecretFiles (`files`)
// results. The durable change-detection marker may advance ONLY on full success;
// any partial shortfall must keep the marker behind so the lastSha===HEAD fast-path
// retries on the next tick instead of stranding an un-applied rotation forever.
//
// "Fully succeeded" = config sync did not refuse (sync.ok !== false) AND no JSON
// secret was skipped (sync.skipped empty) AND every REQUESTED bare file was written
// (files.failed empty AND the bundle did not wholesale-fail). A too-new schema is an
// INTENTIONAL fail-closed, NOT a failure — it keeps the current behavior (counts as
// success-for-marker so a deliberate refusal does not alarm or thrash the retry loop).
//
// CTL-1393 (Codex P2 re-review of caf6b0e2): the BARE-FILE failure conditions are
// evaluated BEFORE the schemaSkipped short-circuit. A too-new `cluster.json` (which
// fails the JSON config sync CLOSED → schemaSkipped) must NOT mask a concurrent
// bare-bundle failure: when `secrets/` rotates the bare `node-secret-files.sops.json`
// alongside a too-new schema, returning success-for-marker on schemaSkipped would
// advance the durable marker over the FAILED bare secret, stranding the un-applied
// rotation forever (lastSha===HEAD then skips the retry). So the bundle/partial
// bare-file checks run first; only once the bare-file part is confirmed OK does the
// intentional schemaSkipped fail-closed count as success-for-marker.
//
// Returns { fullSuccess, reason }; `reason` names the shortfall when not full:
//   decrypt-failed   — wholesale: the bare bundle failed, or every JSON secret skipped
//   config-refused   — syncClusterSecrets refused (sync.ok === false), empty skipped
//   secrets-skipped  — a JSON secret was skipped while another succeeded (partial)
//   bare-write-failed — a bare file decrypted but its write failed (partial)
function assessMaterialization({ sync, files }) {
  const synced = Array.isArray(sync?.synced) ? sync.synced : [];
  const skipped = Array.isArray(sync?.skipped) ? sync.skipped : [];
  const bareFailed = Array.isArray(files?.failed) ? files.failed : [];

  // 1. Bare-bundle wholesale failure — the whole node-secret-files.sops.json bundle
  //    failed to decrypt. Checked BEFORE schemaSkipped so a too-new JSON schema can
  //    never mask it.
  if (files?.reason === "decrypt-failed") {
    return { fullSuccess: false, reason: "decrypt-failed" };
  }
  // 2. Partial bare-file failure — a bare file decrypted but its write failed. Also
  //    checked BEFORE schemaSkipped (same masking rationale).
  if (bareFailed.length > 0) {
    return { fullSuccess: false, reason: "bare-write-failed" };
  }
  // 3. Schema too-new is fail-CLOSED by design — treat as success for the marker.
  //    Reaching here means the bare-file part is already confirmed OK (1–2 above), so
  //    the intentional JSON refusal does not alarm or thrash the retry loop.
  if (sync?.schemaSkipped === true) return { fullSuccess: true, reason: null };
  // 4. Config sync refused entirely (e.g. missing/malformed cluster.json), empty skipped.
  if (sync?.ok === false) return { fullSuccess: false, reason: "config-refused" };
  // 5. Every JSON secret skipped with none synced — wholesale JSON failure. Preserve
  //    the legacy "decrypt-failed" reason for this all-skipped case.
  if (skipped.length > 0 && synced.length === 0) {
    return { fullSuccess: false, reason: "decrypt-failed" };
  }
  // 6. A JSON secret was skipped while another succeeded (partial JSON failure).
  if (skipped.length > 0) return { fullSuccess: false, reason: "secrets-skipped" };
  return { fullSuccess: true, reason: null };
}

// refreshClusterSecretsIfChanged — CTL-1393. The periodic-timer entrypoint and the
// root-cause fix for silent-stale nodes. Pulls the clone, then uses the persisted
// marker to decide whether secrets actually changed BEFORE spending a single sops
// spawn:
//   • HEAD === marker.lastDecryptedSha        → SKIP (no sops), {changed:false}
//   • secrets/ unchanged across lastSha..HEAD → SKIP (no sops), advance the marker
//   • secrets/ changed (or first run)         → re-decrypt + materialize, advance
//                                                the marker, emit `refreshed`
// A sops-resolve or wholesale decrypt failure is LOUD: emit `refresh-failed` and do
// NOT advance the marker (next tick retries) — but NEVER throw (fail-open, exactly
// like the rest of this module).
export function refreshClusterSecretsIfChanged(opts = {}) {
  const {
    clusterDir = getClusterRepoDir(),
    configDir = defaultConfigDir(),
    ageKeyFile = defaultAgeKeyFile(),
    statePath = getClusterSyncStatePath(),
    git = defaultGit,
    gitCapture = defaultGitCapture,
    resolveSops = resolveSopsBin,
    decrypt, // optional override; else a PATH-robust sops runner is built lazily
    readState = readClusterSyncState,
    writeState = writeClusterSyncState,
    emit = emitClusterSecretEvent,
    now = defaultNow,
    node = getHostName(),
    logger = log,
  } = opts;

  const status = {
    changed: false, ok: true, reason: null,
    fromSha: null, toSha: null, written: [], synced: [], restartRequired: [],
  };

  // 1. Refresh the clone (reuse pullClusterRepo — fail-open; no-op when not a clone).
  status.pull = pullClusterRepo({ clusterDir, git, logger });

  // 2. Resolve HEAD. No clone / rev-parse failure → nothing to refresh (fail-open).
  const head = gitRevParseHead({ clusterDir, gitCapture });
  if (!head) {
    status.reason = "no-head";
    return status;
  }
  status.toSha = head;

  // 3. Read the marker.
  const state = readState(statePath);
  const lastSha = typeof state?.lastDecryptedSha === "string" ? state.lastDecryptedSha : null;
  status.fromSha = lastSha;

  // 4. Change-detection — skip the decrypt (no sops spawn) when nothing relevant moved.
  if (lastSha && lastSha === head) {
    status.reason = "head-unchanged";
    return status;
  }
  if (
    lastSha &&
    !gitSecretsChangedBetween({ clusterDir, fromSha: lastSha, toSha: head, gitCapture })
  ) {
    // HEAD advanced but secrets/ did not — advance the marker so we don't re-diff the
    // same range every tick, but DON'T spend a sops spawn.
    writeState(
      statePath,
      {
        lastDecryptedSha: head,
        lastDecryptedAt: now(),
        written: Array.isArray(state?.written) ? state.written : [],
        synced: Array.isArray(state?.synced) ? state.synced : [],
      },
      logger,
    );
    status.reason = "secrets-unchanged";
    return status;
  }

  // 5. secrets/ changed (or first decrypt) — sops MUST be resolvable. A failure here
  // is the silent-stale root cause: make it LOUD (emit refresh-failed), keep the
  // node-local plaintext, and DON'T advance the marker (retry next tick). Never throw.
  let sopsDecrypt = decrypt;
  if (!sopsDecrypt) {
    if (!resolveSops()) {
      status.ok = false;
      status.reason = "sops-unresolved";
      logger?.warn?.(
        "[cluster-sync] sops binary unresolvable on this node — cannot refresh rotated secrets; " +
          "keeping stale secrets (install sops or fix the daemon PATH)",
      );
      emit({ name: "refresh-failed", node, now, payload: { reason: "sops-unresolved", toSha: head } });
      return status;
    }
    sopsDecrypt = makeSopsDecrypt(ageKeyFile, { resolveSops });
  }

  // 6. Re-decrypt + materialize (reuse the existing CTL-1211 machinery).
  const sync = syncClusterSecrets({ clusterDir, configDir, ageKeyFile, decrypt: sopsDecrypt, logger });
  const files = syncSecretFiles({ clusterDir, configDir, ageKeyFile, decrypt: sopsDecrypt, logger });
  status.synced = Array.isArray(sync?.synced) ? sync.synced : [];
  status.written = Array.isArray(files?.written) ? files.written : [];

  // 7. Advance the marker ONLY on FULL materialization success (Codex-A). A PARTIAL
  // shortfall (a single JSON secret skipped while another succeeded, the config sync
  // refused with empty skipped, or a bare file that decrypted but failed to write) is
  // a failure too: advancing the marker over it would make lastSha===HEAD skip the
  // retry forever, stranding the un-applied rotation. On ANY shortfall: emit
  // refresh-failed naming the shortfall, do NOT advance the marker, return ok:false.
  const { fullSuccess, reason: shortfall } = assessMaterialization({ sync, files });
  if (!fullSuccess) {
    status.ok = false;
    status.reason = shortfall;
    emit({ name: "refresh-failed", node, now, payload: { reason: shortfall, toSha: head } });
    // Do NOT advance the marker — retry on the next tick.
    return status;
  }

  // 8. Full success — advance the marker and (on a REAL change) emit refreshed.
  writeState(
    statePath,
    {
      lastDecryptedSha: head,
      lastDecryptedAt: now(),
      written: status.written,
      synced: status.synced,
    },
    logger,
  );
  status.changed = true;
  status.reason = "refreshed";
  // Emit only on a real change: sha advanced AND something was materialized.
  if (lastSha !== head && (status.written.length > 0 || status.synced.length > 0)) {
    emit({
      name: "refreshed",
      node,
      now,
      payload: { fromSha: lastSha, toSha: head, written: status.written, synced: status.synced },
    });
  }

  // 8b. Codex-B: a rotated ENV-BACKED secret file (sourced into process.env at boot)
  // is NOT live in the running daemon until a restart — the SDK path reads
  // CLAUDE_CODE_OAUTH_TOKEN from process.env, captured at boot. Emit a DISTINCT loud
  // signal so the "refreshed" event above is never mistaken for "the env secret is
  // applied". This is the timer's restart-required surface (the daemon timer calls
  // this fn); best-effort like every other emit here. Auto-restart is out of scope
  // (CTL-1398 re-sources the file on the next start, so a manual restart re-arms it).
  const restartRequired = status.written.filter((f) => ENV_BACKED_SECRET_FILES.has(f));
  status.restartRequired = restartRequired;
  for (const file of restartRequired) {
    logger?.warn?.(
      `[cluster-sync] env-backed secret rotated (${file}) — daemon restart required to apply ` +
        "(CLAUDE_CODE_OAUTH_TOKEN is read from process.env at boot)",
    );
    emit({ name: "restart-required", node, now, payload: { file, fromSha: lastSha, toSha: head } });
  }
  return status;
}

// clusterSync — the BOOT entrypoint: pull, then decrypt JSON configs, then
// materialize bare secret files — and (re)seed the change-detection marker so the
// periodic refresh (refreshClusterSecretsIfChanged) has a baseline HEAD to diff
// against. Boot ALWAYS attempts decrypt (it must materialize secrets on a fresh
// node regardless of the marker).
//
// CTL-1393 correctness: the marker MUST NOT be seeded when boot's decrypt failed
// WHOLESALE (sops genuinely absent, or every secret skipped). Seeding it to HEAD
// in that case re-creates the exact silent-stale failure mode this work kills:
// marker === HEAD ⇒ refreshClusterSecretsIfChanged skips forever ("head-unchanged")
// and doctor.checkClusterSecretFreshness reports PASS, masking an un-applied
// rotation. So the seed is CONDITIONAL on decrypt success, mirroring the
// wholesale-failure detection in refreshClusterSecretsIfChanged: on failure we WARN
// and emit `refresh-failed` (same envelope/seams) and DON'T advance the marker, so
// the periodic refresh keeps retrying and doctor keeps flagging. A fresh node with
// an EMPTY secrets repo (nothing to decrypt) is NOT a failure and still seeds the
// marker. Never throws (boot must never break).
export function clusterSync(opts = {}) {
  const {
    clusterDir = getClusterRepoDir(),
    statePath = getClusterSyncStatePath(),
    gitCapture = defaultGitCapture,
    writeState = writeClusterSyncState,
    emit = emitClusterSecretEvent,
    now = defaultNow,
    node = getHostName(),
    logger = log,
  } = opts;
  const pull = pullClusterRepo(opts);
  const sync = syncClusterSecrets(opts);
  const files = syncSecretFiles(opts);

  // Seed the marker ONLY when boot materialization FULLY succeeded — the SAME
  // hardened predicate the periodic refresh uses (Codex-A). A WHOLESALE failure (sops
  // unresolvable / every secret skipped / bundle failed) AND any PARTIAL shortfall (a
  // single JSON secret skipped, config sync refused, or a bare file that failed to
  // write) must keep the marker behind, so the periodic refresh keeps retrying and
  // doctor keeps flagging instead of masking the un-applied rotation. A too-new schema
  // stays fail-CLOSED (intentional, not a failure) and still seeds. An empty secrets
  // repo (nothing to decrypt) is full success and still seeds.
  const synced = Array.isArray(sync?.synced) ? sync.synced : [];
  const { fullSuccess, reason: shortfall } = assessMaterialization({ sync, files });

  try {
    const head = gitRevParseHead({ clusterDir, gitCapture });
    if (head && fullSuccess) {
      // Success path: seed/refresh the marker to the clone's HEAD.
      writeState(
        statePath,
        {
          lastDecryptedSha: head,
          lastDecryptedAt: now(),
          written: Array.isArray(files?.written) ? files.written : [],
          synced,
        },
        logger,
      );
    } else if (head && !fullSuccess) {
      // Boot materialization shortfall: DON'T seed the marker (so the periodic
      // refresh keeps retrying and doctor keeps flagging), make it LOUD.
      logger?.warn?.(
        `[cluster-sync] boot decrypt did not fully succeed (${shortfall}) — ` +
          "NOT seeding the change-detection marker; keeping node-local plaintext and retrying on the refresh timer",
      );
      emit({ name: "refresh-failed", node, now, payload: { reason: shortfall, toSha: head } });
    }
  } catch (err) {
    logger?.warn?.(`[cluster-sync] boot marker seed failed (${err?.message ?? err})`);
  }
  return { pull, sync, files };
}

// Exposed for doctor + tests.
export { destForSecret };
