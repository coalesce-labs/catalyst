import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { log as defaultLog } from "./config.mjs";
import { parseLinearQuotaHeaders } from "./linear-quota.mjs";
import { readLinearActorFingerprint } from "./linear-actor-fingerprint.mjs";

export function readLinearQuota(orchDir, { log = defaultLog } = {}) {
  const path = join(orchDir, "linear-quota.json");
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (err) {
    if (err?.code !== "ENOENT") log?.warn?.({ path, err: err?.message }, "linear-quota: snapshot corrupt or unreadable — skipping");
    return null;
  }
}

export function publishLinearQuota(orchDir, snapshot, { log = defaultLog, fileOps = { mkdirSync, readFileSync, writeFileSync, renameSync } } = {}) {
  if (!orchDir || !snapshot?.sampledAt) return false;
  try {
    const path = join(orchDir, "linear-quota.json");
    let current = null;
    try { current = JSON.parse(fileOps.readFileSync(path, "utf8")); } catch { /* first/corrupt write */ }
    if (Date.parse(current?.sampledAt ?? "") > Date.parse(snapshot.sampledAt)) return false;
    fileOps.mkdirSync?.(orchDir, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}`;
    fileOps.writeFileSync(tmp, JSON.stringify(snapshot));
    fileOps.renameSync(tmp, path);
    return true;
  } catch (err) {
    log?.warn?.({ err: err?.message }, "linear-quota: publish failed — continuing");
    return false;
  }
}

export function sampleAndPublish(headers, { orchDir = process.env.CATALYST_ORCHESTRATOR_DIR, host = hostname(), nowMs = Date.now(), ...deps } = {}) {
  const snapshot = parseLinearQuotaHeaders(headers, { host, nowMs });
  if (snapshot) snapshot.linearActorFingerprint = readLinearActorFingerprint();
  return snapshot ? publishLinearQuota(orchDir, snapshot, deps) : false;
}
