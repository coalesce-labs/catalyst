import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getJobsRoot } from "./config.mjs";

export const USAGE_LIMIT_TEXT_RE = /\bhit\s+your\s+(?:[A-Za-z0-9][A-Za-z0-9-]*\s+){0,3}limit\b/i;
export const USAGE_LIMIT_FALLBACK_MS = Number(process.env.CATALYST_USAGE_LIMIT_FALLBACK_MS) || 3_600_000;

export function readJobTimelineBlock(bgJobId, { readFileFn = readFileSync, jobsRoot = null, tailLines = 50 } = {}) {
  const miss = { blocked: false, at: null, detail: null };
  if (!bgJobId) return miss;
  let raw;
  try {
    // EVENT-LOG-FULL-READ-OK(CTL-1442): one job's bounded timeline, not the shared event log.
    raw = readFileFn(join(jobsRoot ?? getJobsRoot(), bgJobId, "timeline.jsonl"), "utf8");
  } catch {
    return miss;
  }
  const lines = String(raw).split("\n").filter((line) => line.trim());
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - tailLines); i--) {
    let entry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry?.state !== "blocked") continue;
    const detail = typeof entry.detail === "string" ? entry.detail : typeof entry.text === "string" ? entry.text : "";
    if (USAGE_LIMIT_TEXT_RE.test(detail)) return { blocked: true, at: entry.at ?? null, detail };
  }
  return miss;
}

export function parseResetFromDetail(detail, { pollerResetsAt = null, now = Date.now } = {}) {
  const nowMs = now();
  const polled = Date.parse(pollerResetsAt ?? "");
  if (Number.isFinite(polled) && polled > nowMs) return { resetsAt: new Date(polled).toISOString(), resetSource: "poller" };
  const match = /resets\s+([A-Z][a-z]{2}\s+\d{1,2})\s+at\s+(\d{1,2})\s*(am|pm)/i.exec(detail ?? "");
  if (match) {
    const year = new Date(nowMs).getUTCFullYear();
    let hour = Number(match[2]) % 12;
    if (/pm/i.test(match[3])) hour += 12;
    const parsed = Date.parse(`${match[1]} ${year} ${String(hour).padStart(2, "0")}:00:00Z`);
    if (Number.isFinite(parsed) && parsed > nowMs) return { resetsAt: new Date(parsed).toISOString(), resetSource: "detail" };
  }
  return { resetsAt: new Date(nowMs + USAGE_LIMIT_FALLBACK_MS).toISOString(), resetSource: "default" };
}

export function detectUsageLimitBlock(bgJobId, { readTimelineFn = readJobTimelineBlock, detectTranscriptFn = null, pollerResetsAt = null, now = Date.now } = {}) {
  const miss = { blocked: false, source: null, detail: null, at: null, resetsAt: null, resetSource: null };
  if (!bgJobId) return miss;
  let timeline;
  try { timeline = readTimelineFn(bgJobId); } catch { timeline = null; }
  if (timeline?.blocked) return { blocked: true, source: "timeline", detail: timeline.detail, at: timeline.at, ...parseResetFromDetail(timeline.detail, { pollerResetsAt, now }) };
  let transcript = false;
  try { transcript = detectTranscriptFn ? !!detectTranscriptFn(bgJobId) : false; } catch { transcript = false; }
  return transcript ? { blocked: true, source: "transcript", detail: null, at: null, ...parseResetFromDetail(null, { pollerResetsAt, now }) } : miss;
}

export function buildUsageLimitExplanation({ ticket = "ticket", phase = "phase", resetsAt = null, lane = "bg", fallbackLane = null, detail = null } = {}) {
  const when = resetsAt ? new Date(resetsAt).toISOString() : "an unknown time";
  return {
    problem: `${ticket} ${phase} did not fail — the Claude account's usage limit is exhausted, so the ${lane} worker blocked before doing any work (${detail ?? "usage limit reached"}). The ticket itself is healthy.`,
    call_to_action: fallbackLane
      ? `No action needed to keep ${ticket} moving — it is rerouted to the ${fallbackLane} lane and the ${lane} lane is suppressed until ${when}. Intervene only to change lanes or raise the account's quota.`
      : `Retrying cannot succeed before ${when} and no healthy alternate lane is available on this node. Either wait for the reset, raise the account's quota, or route this phase to another executor/host.`,
    observed: { likely_cause: "account-usage-limit", resets_at: resetsAt, lane, fallback_lane: fallbackLane },
  };
}
