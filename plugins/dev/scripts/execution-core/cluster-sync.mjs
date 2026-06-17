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
//
// Roster (cluster.json.roster) is read LIVE per tick by config.getClusterHosts();
// secrets here are decrypted at BOOT. So a roster change needs no restart, but a
// secret rotation needs a worker restart to be picked up.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import {
  log,
  getClusterRepoDir,
  readClusterConfig,
  getLayer2ConfigPath,
} from "./config.mjs";
import { writeSecretConfig } from "./write-secret-config.mjs";
import { schemaCompat } from "./config-schema.mjs";

// Default age key location on every node (the private half; mode 0o600).
function defaultAgeKeyFile() {
  return resolve(homedir(), ".config", "catalyst", "age.key");
}

// The directory holding the decrypted Layer-2 plaintext files (~/.config/catalyst).
function defaultConfigDir() {
  return dirname(getLayer2ConfigPath());
}

// Real `sops --decrypt` runner. Injected as `decrypt` so tests never shell out.
function makeSopsDecrypt(ageKeyFile) {
  return (secretPath) => {
    const out = execFileSync(
      "sops",
      ["--decrypt", "--input-type", "json", "--output-type", "json", secretPath],
      {
        env: { ...process.env, SOPS_AGE_KEY_FILE: ageKeyFile },
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
export function syncSecretFiles(opts = {}) {
  const {
    clusterDir = getClusterRepoDir(),
    configDir = defaultConfigDir(),
    ageKeyFile = defaultAgeKeyFile(),
    decrypt = makeSopsDecrypt(ageKeyFile),
    writeFile = defaultWriteFile,
    logger = log,
  } = opts;

  const result = { written: [], skipped: false, reason: null };
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
    }
  }
  return result;
}

// clusterSync — the boot entrypoint: pull, then decrypt JSON configs, then
// materialize bare secret files. Never throws.
export function clusterSync(opts = {}) {
  const pull = pullClusterRepo(opts);
  const sync = syncClusterSecrets(opts);
  const files = syncSecretFiles(opts);
  return { pull, sync, files };
}

// Exposed for doctor + tests.
export { destForSecret };
