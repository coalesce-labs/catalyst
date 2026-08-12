import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { getEventLogPath } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const RESEED_EVENT = "catalyst.replica.reseed_requested";
export const RESEED_COOLDOWN_MS = Number(process.env.CATALYST_REPLICA_RESEED_COOLDOWN_MS) || 3_600_000;
export function decideReseed(completeness, { agentInstalled, tokenPresent, lastAttemptMs, now, cooldownMs = RESEED_COOLDOWN_MS } = {}) {
  const state = completeness?.state;
  if (state !== "empty" && state !== "absent") return { action: "skip", reason: state === "unknown" || state == null ? "unknown-state" : "already-populated", state: state ?? null };
  if (!agentInstalled) return { action: "skip", reason: "no-writer-agent", state };
  if (!tokenPresent) return { action: "skip", reason: "no-token", state };
  if (Number.isFinite(lastAttemptMs) && Number.isFinite(now) && now - lastAttemptMs < cooldownMs) return { action: "skip", reason: "cooldown", state };
  return { action: "request", reason: state, state };
}
export function requestReplicaReseed({ mode = "shadow", completeness, ctx = {}, kickstart, emit, writeMarker, log } = {}) {
  if (mode === "off") return { outcome: "off" };
  const decision = decideReseed(completeness, ctx); const base = { mode, state: decision.state, reason: decision.reason, issueRows: completeness?.issueRows ?? null };
  if (decision.action === "skip") { log?.info?.(base, `replica reseed: skipped (${decision.reason})`); return { outcome: "skipped", reason: decision.reason }; }
  const event = (outcome) => ({ "event.name": RESEED_EVENT, "event.entity": "replica", "event.action": "reseed_requested", "reseed.mode": mode, "reseed.outcome": outcome, "reseed.state": decision.state, "replica.issue_rows": base.issueRows });
  if (mode !== "enforce") { log?.info?.(base, `replica reseed: would request (${decision.reason}) — shadow mode, not actuating`); emit?.(event("would-request")); return { outcome: "would-request" }; }
  let ok = false; try { ok = kickstart?.() === true; } catch (err) { log?.warn?.({ ...base, err: err?.message }, "replica reseed: writer restart threw"); }
  try { writeMarker?.({ lastAttemptMs: ctx.now, state: decision.state, ok }); } catch { /* best effort */ }
  const outcome = ok ? "requested" : "failed"; log?.[ok ? "info" : "warn"]?.(base, `replica reseed: ${outcome} (writer restart; ${decision.reason})`); emit?.(event(outcome)); return { outcome };
}
export const kickstartCloudSync = () => spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/ai.coalesce.catalyst-cloud-sync`], { timeout: 10_000 }).status === 0;
export function readReseedMarker(orchDir) { try { return JSON.parse(readFileSync(join(orchDir, ".replica-reseed.json"), "utf8")); } catch { return null; } }
export function writeReseedMarker(orchDir, marker) { const path = join(orchDir, ".replica-reseed.json"); const tmp = `${path}.tmp.${process.pid}`; writeFileSync(tmp, JSON.stringify(marker)); renameSync(tmp, path); }
export function emitReseedEvent(attributes) {
  try { const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); const path = getEventLogPath(); mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify({ ts, id: randomBytes(8).toString("hex"), observedTs: ts, severityText: "WARN", severityNumber: 13, traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"), resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }), attributes })}\n`); } catch { /* boot hook is fail-open */ }
}
