import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { log as defaultLog } from "./config.mjs";

export const ACCOUNT_QUOTA_MAX_AGE_MS =
  Number(process.env.CATALYST_ACCOUNT_QUOTA_MAX_AGE_MS) || 1_800_000;

export function accountQuotaPath(orchDir) {
  return join(orchDir, "account-quota.json");
}

export function writeAccountQuota(
  orchDir,
  sample,
  { now = Date.now, log = defaultLog, fileOps = { mkdirSync, writeFileSync, renameSync } } = {},
) {
  if (!orchDir) return false;
  try {
    const snapshot = {
      sampledAt: sample?.sampledAt ?? new Date(now()).toISOString(),
      fiveHourPct: sample?.fiveHourPct ?? null,
      sevenDayPct: sample?.sevenDayPct ?? null,
      fiveHourResetsAt: sample?.fiveHourResetsAt ?? null,
      sevenDayResetsAt: sample?.sevenDayResetsAt ?? null,
      opusPct: sample?.opusPct ?? null,
      sonnetPct: sample?.sonnetPct ?? null,
      subscriptionType: sample?.subscriptionType ?? null,
      rateLimitTier: sample?.rateLimitTier ?? null,
    };
    fileOps.mkdirSync(orchDir, { recursive: true });
    const finalPath = accountQuotaPath(orchDir);
    const tmpPath = `${finalPath}.tmp.${process.pid}`;
    fileOps.writeFileSync(tmpPath, JSON.stringify(snapshot));
    fileOps.renameSync(tmpPath, finalPath);
    return true;
  } catch (err) {
    log?.warn?.({ orchDir, err: err?.message }, "account-quota: snapshot write failed — continuing");
    return false;
  }
}

export function readAccountQuota(orchDir, { now = Date.now, log = defaultLog } = {}) {
  const path = accountQuotaPath(orchDir);
  try {
    const snapshot = JSON.parse(readFileSync(path, "utf8"));
    const sampledAtMs = Date.parse(snapshot?.sampledAt ?? "");
    if (!Number.isFinite(sampledAtMs) || now() - sampledAtMs > ACCOUNT_QUOTA_MAX_AGE_MS) return null;
    return snapshot;
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log?.warn?.({ path, err: err?.message }, "account-quota: snapshot unreadable — ignoring");
    }
    return null;
  }
}

export function resolveAccountResetsAt(orchDir, { now = Date.now } = {}) {
  const snapshot = readAccountQuota(orchDir, { now });
  if (!snapshot) return null;
  const fiveHourPct = snapshot.fiveHourPct;
  const sevenDayPct = snapshot.sevenDayPct;
  const hasFiveHourPct = typeof fiveHourPct === "number" && Number.isFinite(fiveHourPct);
  const hasSevenDayPct = typeof sevenDayPct === "number" && Number.isFinite(sevenDayPct);
  if (hasFiveHourPct && hasSevenDayPct) {
    return fiveHourPct > sevenDayPct
      ? snapshot.fiveHourResetsAt ?? snapshot.sevenDayResetsAt ?? null
      : snapshot.sevenDayResetsAt ?? snapshot.fiveHourResetsAt ?? null;
  }
  if (hasFiveHourPct) return snapshot.fiveHourResetsAt ?? snapshot.sevenDayResetsAt ?? null;
  if (hasSevenDayPct) return snapshot.sevenDayResetsAt ?? snapshot.fiveHourResetsAt ?? null;
  return snapshot.sevenDayResetsAt ?? snapshot.fiveHourResetsAt ?? null;
}
