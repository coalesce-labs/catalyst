// write-secret-config.mjs — CTL-1203.
// Shared 0o600 writer for Catalyst Layer-2 secrets.
//
// The join receiver (CTL-1183 / CTL-1185) MUST route all Layer-2 writes
// through writeSecretConfig. NEVER log `obj` directly — pass it through
// redactBundleForLog() (join-bundle.mjs) before any logging.

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from "node:fs";
import { dirname } from "node:path";

function deepMerge(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] !== null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      out[key] = deepMerge(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

// writeSecretConfig(path, obj)
// Deep-merges `obj` into any existing contents of `path`, then writes the
// result at mode 0o600. Creates parent directories as needed.
export function writeSecretConfig(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const prev = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8") || "{}")
    : {};
  const next = deepMerge(prev, obj);
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  // Existing files keep their old mode on writeFileSync on some platforms —
  // enforce explicitly so overwrites always land at 0o600.
  chmodSync(path, 0o600);
}
