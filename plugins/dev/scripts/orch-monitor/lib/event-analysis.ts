/**
 * Event log analysis (CTL-307).
 *
 * Pure-function projection + question functions over the canonical
 * (CTL-300) event log, with backward-compat for legacy v1/v2 lines.
 *
 * No IO. The CLI in `analyze-events.ts` reads files and calls these.
 */

export type Severity = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface NormalizedEvent {
  ts: string;
  eventName: string;
  orchestratorId: string | null;
  ticket: string | null;
  sessionId: string | null;
  prNumber: number | null;
  phase: number | null;
  phaseTo: string | null;
  ciConclusion: string | null;
  ciStatus: string | null;
  severityText: Severity | null;
  bodyMessage: string | null;
  raw: unknown;
}

// Map legacy event names to their canonical equivalents. Names not in the
// table pass through unchanged (forward-compat: unknown event names are
// preserved verbatim so analyzers degrade gracefully).
const LEGACY_NAME_MAP: Record<string, string> = {
  "phase-changed": "session.phase",
  "session-started": "session.started",
  "session-ended": "session.ended",
  "worker-pr-created": "orchestrator.worker.pr_created",
  "worker-pr-merged": "orchestrator.worker.pr_merged",
  "worker-done": "orchestrator.worker.done",
  "worker-dispatched": "orchestrator.worker.dispatched",
  "attention-raised": "orchestrator.attention.raised",
  "pr-opened": "github.pr.opened",
};

const HEARTBEAT_NAMES = new Set([
  "session.heartbeat",
  "heartbeat",
  "filter.daemon.heartbeat",
]);

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function extractPrNumber(
  attrs: Record<string, unknown> | null,
  scope: Record<string, unknown> | null,
  detail: Record<string, unknown> | null,
): number | null {
  // Canonical: attributes."vcs.pr.number"
  if (attrs) {
    const v = asNumber(attrs["vcs.pr.number"]);
    if (v !== null) return v;
  }
  // Legacy v2 with single PR: scope.pr
  if (scope) {
    const v = asNumber(scope["pr"]);
    if (v !== null) return v;
  }
  // Legacy v2 webhook with multi-PR fallback: detail.prNumbers[0]
  if (detail) {
    const arr = detail["prNumbers"];
    if (Array.isArray(arr) && arr.length > 0) {
      const v = asNumber(arr[0]);
      if (v !== null) return v;
    }
  }
  return null;
}

export function normalize(line: string): NormalizedEvent | null {
  if (!line || line.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const obj = asObject(parsed);
  if (obj === null) return null;

  const ts = asString(obj.ts);
  if (ts === null) return null;

  const attrs = asObject(obj.attributes);
  const isCanonical = attrs !== null;

  const rawEventName = isCanonical
    ? asString(attrs["event.name"])
    : asString(obj.event);
  if (rawEventName === null) return null;

  const eventName = LEGACY_NAME_MAP[rawEventName] ?? rawEventName;
  if (HEARTBEAT_NAMES.has(eventName)) return null;

  const detail = asObject(obj.detail);
  const scope = asObject(obj.scope);
  const body = asObject(obj.body);
  const payload = body !== null ? asObject(body.payload) : null;

  // ticket
  let ticket: string | null = null;
  if (isCanonical) {
    ticket = asString(attrs["catalyst.worker.ticket"]);
  }
  if (ticket === null && scope !== null) {
    ticket = asString(scope["ticket"]);
  }
  if (ticket === null && detail !== null) {
    ticket = asString(detail["ticket"]);
  }
  if (ticket === null) {
    ticket = asString(obj.ticket);
  }
  if (ticket === null) {
    // Legacy v1: top-level "worker" field carries the ticket
    ticket = asString(obj.worker);
  }

  // orchestrator
  let orchestratorId: string | null = null;
  if (isCanonical) {
    orchestratorId = asString(attrs["catalyst.orchestrator.id"]);
  }
  if (orchestratorId === null) {
    orchestratorId = asString(obj.orchestrator);
  }
  if (orchestratorId === null && scope !== null) {
    orchestratorId = asString(scope["orchestrator"]);
  }

  // session
  let sessionId: string | null = null;
  if (isCanonical) {
    sessionId = asString(attrs["catalyst.session.id"]);
  }
  if (sessionId === null) {
    sessionId = asString(obj.session);
  }

  // phase number — canonical attributes."catalyst.phase" or
  // body.payload.phase or legacy detail.phase
  let phase: number | null = null;
  if (isCanonical) {
    phase = asNumber(attrs["catalyst.phase"]);
  }
  if (phase === null && payload !== null) {
    phase = asNumber(payload["phase"]);
  }
  if (phase === null && detail !== null) {
    phase = asNumber(detail["phase"]);
  }

  // phase string — canonical body.payload.to or legacy detail.to
  let phaseTo: string | null = null;
  if (payload !== null) {
    phaseTo = asString(payload["to"]);
  }
  if (phaseTo === null && detail !== null) {
    phaseTo = asString(detail["to"]);
  }

  // PR number
  const prNumber = extractPrNumber(attrs, scope, detail);

  // CI conclusion
  let ciConclusion: string | null = null;
  if (isCanonical) {
    ciConclusion = asString(attrs["cicd.pipeline.run.result"]);
  }
  if (ciConclusion === null && detail !== null) {
    ciConclusion = asString(detail["conclusion"]);
  }

  // CI status (queued | in_progress | completed) — CTL-366
  let ciStatus: string | null = null;
  if (isCanonical) {
    ciStatus = asString(attrs["cicd.pipeline.run.status"]);
  }
  if (ciStatus === null && payload !== null) {
    ciStatus = asString(payload["status"]);
  }
  if (ciStatus === null && detail !== null) {
    ciStatus = asString(detail["status"]);
  }

  const severityRaw = asString(obj.severityText);
  const severityText: Severity | null =
    severityRaw === "DEBUG" ||
    severityRaw === "INFO" ||
    severityRaw === "WARN" ||
    severityRaw === "ERROR"
      ? severityRaw
      : null;

  const bodyMessage = body !== null ? asString(body.message) : null;

  return {
    ts,
    eventName,
    orchestratorId,
    ticket,
    sessionId,
    prNumber,
    phase,
    phaseTo,
    ciConclusion,
    ciStatus,
    severityText,
    bodyMessage,
    raw: obj,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function parseTs(ts: string): number {
  return Date.parse(ts);
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return sorted[mid];
}

function p90(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9));
  return sorted[idx];
}

// -----------------------------------------------------------------------------
// Q1 — phaseTime
// -----------------------------------------------------------------------------

export interface PhaseTimeResult {
  byTicket: Array<{
    ticket: string;
    phases: Array<{ name: string; durationSec: number; startedAt: string }>;
  }>;
  byPhase: Array<{
    phase: string;
    medianSec: number;
    p90Sec: number;
    sampleCount: number;
  }>;
}

export function phaseTime(events: NormalizedEvent[]): PhaseTimeResult {
  const byTicketMap = new Map<
    string,
    Array<{ ts: string; name: string }>
  >();

  for (const e of events) {
    if (e.eventName !== "session.phase") continue;
    if (e.ticket === null) continue;
    if (e.phaseTo === null) continue;
    const arr = byTicketMap.get(e.ticket) ?? [];
    arr.push({ ts: e.ts, name: e.phaseTo });
    byTicketMap.set(e.ticket, arr);
  }

  const byTicket: PhaseTimeResult["byTicket"] = [];
  const byPhaseDurations = new Map<string, number[]>();

  for (const [ticket, raw] of byTicketMap.entries()) {
    const sorted = [...raw].sort(
      (a, b) => parseTs(a.ts) - parseTs(b.ts),
    );
    const phases: PhaseTimeResult["byTicket"][number]["phases"] = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i];
      const next = sorted[i + 1];
      const durationSec = Math.round(
        (parseTs(next.ts) - parseTs(cur.ts)) / 1000,
      );
      if (durationSec < 0) continue;
      phases.push({
        name: cur.name,
        durationSec,
        startedAt: cur.ts,
      });
      const acc = byPhaseDurations.get(cur.name) ?? [];
      acc.push(durationSec);
      byPhaseDurations.set(cur.name, acc);
    }
    byTicket.push({ ticket, phases });
  }

  const byPhase: PhaseTimeResult["byPhase"] = [];
  for (const [phase, durations] of byPhaseDurations.entries()) {
    byPhase.push({
      phase,
      medianSec: median(durations),
      p90Sec: p90(durations),
      sampleCount: durations.length,
    });
  }

  byTicket.sort((a, b) => a.ticket.localeCompare(b.ticket));
  byPhase.sort((a, b) => b.sampleCount - a.sampleCount);

  return { byTicket, byPhase };
}

// -----------------------------------------------------------------------------
// Q2 — stalls
// -----------------------------------------------------------------------------

export interface StallsResult {
  totalAttentionEvents: number;
  byReason: Array<{ reason: string; count: number }>;
  perTicket: Array<{ ticket: string; count: number; lastAt: string }>;
  reviewerStats: Array<{
    pr: number;
    reviewers: string[];
    changesRequestedCount: number;
  }>;
}

function readReviewerLogin(raw: unknown): string | null {
  const r = asObject(raw);
  if (r === null) return null;
  const body = asObject(r["body"]);
  if (body === null) return null;
  const payload = asObject(body["payload"]);
  if (payload === null) return null;
  const direct = asString(payload["reviewer"]);
  if (direct !== null) return direct;
  const author = asObject(payload["author"]);
  if (author !== null) {
    return asString(author["login"]);
  }
  return null;
}

function readReviewState(raw: unknown): string | null {
  const r = asObject(raw);
  if (r === null) return null;
  const body = asObject(r["body"]);
  if (body === null) return null;
  const payload = asObject(body["payload"]);
  if (payload === null) return null;
  return asString(payload["state"]);
}

function readAttentionType(raw: unknown): string | null {
  const r = asObject(raw);
  if (r === null) return null;
  // Canonical: body.payload.attentionType
  const body = asObject(r["body"]);
  if (body !== null) {
    const payload = asObject(body["payload"]);
    if (payload !== null) {
      const v = asString(payload["attentionType"]);
      if (v !== null) return v;
    }
  }
  // Legacy v1: detail.attentionType
  const detail = asObject(r["detail"]);
  if (detail !== null) {
    return asString(detail["attentionType"]);
  }
  return null;
}

export function stalls(events: NormalizedEvent[]): StallsResult {
  const attentionEvents = events.filter(
    (e) => e.eventName === "orchestrator.attention.raised",
  );
  const reasonCounts = new Map<string, number>();
  const perTicketMap = new Map<string, { count: number; lastAt: string }>();

  for (const e of attentionEvents) {
    const reason = readAttentionType(e.raw) ?? "unknown";
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    if (e.ticket !== null) {
      const prev = perTicketMap.get(e.ticket);
      if (prev === undefined) {
        perTicketMap.set(e.ticket, { count: 1, lastAt: e.ts });
      } else {
        prev.count += 1;
        if (parseTs(e.ts) > parseTs(prev.lastAt)) {
          prev.lastAt = e.ts;
        }
      }
    }
  }

  const byReason = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
  const perTicket = [...perTicketMap.entries()]
    .map(([ticket, v]) => ({ ticket, count: v.count, lastAt: v.lastAt }))
    .sort((a, b) => b.count - a.count);

  // reviewer stats from github.pr_review.submitted
  const perPr = new Map<
    number,
    { reviewers: string[]; changesRequestedCount: number; firstAt: number }
  >();
  for (const e of events) {
    if (e.eventName !== "github.pr_review.submitted") continue;
    if (e.prNumber === null) continue;
    const reviewer = readReviewerLogin(e.raw);
    if (reviewer === null) continue;
    const state = (readReviewState(e.raw) ?? "").toLowerCase();
    const cur = perPr.get(e.prNumber) ?? {
      reviewers: [],
      changesRequestedCount: 0,
      firstAt: parseTs(e.ts),
    };
    if (!cur.reviewers.includes(reviewer)) {
      cur.reviewers.push(reviewer);
    }
    if (state === "changes_requested") {
      cur.changesRequestedCount += 1;
    }
    cur.firstAt = Math.min(cur.firstAt, parseTs(e.ts));
    perPr.set(e.prNumber, cur);
  }

  const reviewerStats: StallsResult["reviewerStats"] = [...perPr.entries()]
    .map(([pr, v]) => ({
      pr,
      reviewers: v.reviewers,
      changesRequestedCount: v.changesRequestedCount,
    }))
    .sort((a, b) => b.changesRequestedCount - a.changesRequestedCount);

  return {
    totalAttentionEvents: attentionEvents.length,
    byReason,
    perTicket,
    reviewerStats,
  };
}

// -----------------------------------------------------------------------------
// Q3 — ciFunnel
// -----------------------------------------------------------------------------

export interface CiFunnelResult {
  prsOpened: number;
  prsWithFailingCheckSuite: number;
  prsMerged: number;
  medianOpenToFirstGreenSec: number | null;
  medianFirstGreenToMergeSec: number | null;
  perPr: Array<{
    pr: number;
    openedAt: string;
    firstGreenAt: string | null;
    mergedAt: string | null;
    failingCheckSuites: number;
  }>;
}

interface PrAccumulator {
  pr: number;
  openedAt: string | null;
  firstGreenAt: string | null;
  mergedAt: string | null;
  failingCheckSuites: number;
}

export function ciFunnel(events: NormalizedEvent[]): CiFunnelResult {
  const byPr = new Map<number, PrAccumulator>();

  for (const e of events) {
    if (e.prNumber === null) continue;
    const acc = byPr.get(e.prNumber) ?? {
      pr: e.prNumber,
      openedAt: null,
      firstGreenAt: null,
      mergedAt: null,
      failingCheckSuites: 0,
    };

    if (e.eventName === "github.pr.opened") {
      if (acc.openedAt === null || parseTs(e.ts) < parseTs(acc.openedAt)) {
        acc.openedAt = e.ts;
      }
    } else if (e.eventName === "github.check_suite.completed") {
      if (e.ciConclusion === "success") {
        if (
          acc.firstGreenAt === null ||
          parseTs(e.ts) < parseTs(acc.firstGreenAt)
        ) {
          acc.firstGreenAt = e.ts;
        }
      } else if (
        e.ciConclusion === "failure" ||
        e.ciConclusion === "timed_out" ||
        e.ciConclusion === "cancelled"
      ) {
        // Only count failures that happened before merge to match the
        // funnel question ("CI gated the merge"). If never merged, count
        // them all.
        if (acc.mergedAt === null || parseTs(e.ts) < parseTs(acc.mergedAt)) {
          acc.failingCheckSuites += 1;
        }
      }
    } else if (e.eventName === "github.pr.merged") {
      if (acc.mergedAt === null || parseTs(e.ts) > parseTs(acc.mergedAt)) {
        acc.mergedAt = e.ts;
      }
    }

    byPr.set(e.prNumber, acc);
  }

  const perPr: CiFunnelResult["perPr"] = [];
  let prsOpened = 0;
  let prsMerged = 0;
  let prsWithFailingCheckSuite = 0;
  const openToGreen: number[] = [];
  const greenToMerge: number[] = [];

  for (const acc of byPr.values()) {
    if (acc.openedAt === null) continue; // we only count PRs with an opened event
    prsOpened += 1;
    if (acc.mergedAt !== null) prsMerged += 1;
    if (acc.failingCheckSuites > 0) prsWithFailingCheckSuite += 1;
    if (acc.openedAt !== null && acc.firstGreenAt !== null) {
      openToGreen.push(
        Math.round(
          (parseTs(acc.firstGreenAt) - parseTs(acc.openedAt)) / 1000,
        ),
      );
    }
    if (acc.firstGreenAt !== null && acc.mergedAt !== null) {
      greenToMerge.push(
        Math.round(
          (parseTs(acc.mergedAt) - parseTs(acc.firstGreenAt)) / 1000,
        ),
      );
    }
    perPr.push({
      pr: acc.pr,
      openedAt: acc.openedAt,
      firstGreenAt: acc.firstGreenAt,
      mergedAt: acc.mergedAt,
      failingCheckSuites: acc.failingCheckSuites,
    });
  }

  perPr.sort((a, b) => a.pr - b.pr);

  return {
    prsOpened,
    prsMerged,
    prsWithFailingCheckSuite,
    medianOpenToFirstGreenSec:
      openToGreen.length > 0 ? median(openToGreen) : null,
    medianFirstGreenToMergeSec:
      greenToMerge.length > 0 ? median(greenToMerge) : null,
    perPr,
  };
}
