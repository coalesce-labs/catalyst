import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveLayer2Path } from "../lib/secret-contract.mjs";

export function fingerprintLinearActor(clientId) {
  const value = typeof clientId === "string" ? clientId.trim() : "";
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 16) : null;
}

let cached;
export function readLinearActorFingerprint(path = resolveLayer2Path(), { readFile = readFileSync } = {}) {
  if (path === resolveLayer2Path() && cached !== undefined) return cached;
  try {
    const cfg = JSON.parse(readFile(path, "utf8"));
    const fp = fingerprintLinearActor(cfg?.catalyst?.linear?.bot?.orchestrator?.clientId);
    if (path === resolveLayer2Path()) cached = fp;
    return fp;
  } catch { return null; }
}
