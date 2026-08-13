// drop-surface.ts — CTL-1818. The host-local surface for events this daemon DISCARDS.
//
// ⚠️ WHY THIS CANNOT BE AN EVENT CONSUMER. `OtlpSender.emitDrop` already appends
// `catalyst.observability.forward_dropped` to the event log, and that event is then shipped
// through the very path that just discarded something. An alarm sourced from the forwarded
// stream measures the SURVIVORS and reads clean during exactly the outage it exists to
// detect. Worse, the two guards at the top of `emitDrop` (`!eventLogPath`, `isSelfBatch`)
// mean some discards emit no event at all. So the accounting lives HERE, on the host:
//
//   1. process-exact counters, per drop reason, in both events (batches) and records
//   2. a durable marker `~/catalyst/otel-forward-drops.json` — atomic tmp+rename, carried
//      across restarts, sitting beside the checkpoint and the DLQ so an operator finds it
//      where they already look
//   3. the daemon's pino `.log`, which Alloy tails and ships to Loki INDEPENDENTLY of this
//      daemon's own OTLP egress (log-shipper/config.alloy:22)
//
// None of the three existing forwarder guardrails can see an aged drop:
//   - `forward_failed` / the CTL-1502 watchdog's DLQ-size predicate — an aged record never
//     rides the DLQ in the primary path (otlp.ts, "Aged records never ride the DLQ"), so the
//     DLQ stays flat while records are thrown away;
//   - the watchdog's forwarding-lag predicate — the checkpoint keeps advancing, because a
//     discard IS forward progress as far as the read position is concerned;
//   - `forward_dropped` itself — 87,706 of them on the fleet's mirrored 2026-08 log, read by
//     nothing in this repo and by nothing in `catalyst-otel` either (the provisioned Grafana
//     rule reads `forward_failed`, a different name).
//
// ⚠️ ALERT-ONLY BY DESIGN. This module raises an alarm; it never restarts or otherwise
// actuates anything. A sustained aged-drop is a Loki-accept-window / backlog condition, and
// bouncing the forwarder does not fix it — it only loses the in-memory buffer. In particular
// this is deliberately NOT wired into `classifyDaemonStuck`, whose `tripped` list feeds
// `restart()` in the CTL-1502 probe.

import { mkdirSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { log as defaultLog } from "./logger.ts";
import { createSparseWarnGate } from "./sparse-warn.ts";

export type DropReason = "aged" | "terminal_4xx";

export interface DropSurfaceConfig {
  /** Rolling window the drop rate is measured over. */
  windowMs: number;
  /** Records discarded within the window that constitutes a breach (inclusive `>=`). */
  thresholdRecords: number;
  /** How long a breach must persist before the alert fires. */
  sustainMs: number;
}

// Defaults chosen against MEASURED fleet behavior (mirrored `~/catalyst/events/2026-08.jsonl`,
// coverage 2026-08-08 → 08-13, both worker hosts): 87,706 `forward_dropped` events carrying
// 7,623,269 discarded records, 100% `reason: "aged"`. A quiet day on `mini` was ~234k
// records/day ≈ 813 records per 5-minute window; the loss storms of 08-10/08-11 ran
// ~2.0M records/day ≈ 6,900 per 5-minute window. 1,000 records per 5-minute window therefore
// sits between the two regimes that are actually present in the data, rather than at a number
// picked from nowhere. `windowMs`/`sustainMs` mirror the provisioned Grafana rule for
// `forward_failed` (5-minute window, `for: 10m`) so an operator reasons in one unit.
export const DROP_SURFACE_DEFAULTS: Readonly<DropSurfaceConfig> = Object.freeze({
  windowMs: 300_000,
  thresholdRecords: 1_000,
  sustainMs: 600_000,
});

// The rolling window is kept as a small ring of time buckets rather than a list of samples,
// so memory is O(BUCKET_COUNT) no matter how fast drops arrive — an unbounded sample array in
// a long-lived daemon is the very shape this repo keeps getting bitten by.
const BUCKET_COUNT = 60;

// A marker write per discarded batch is cheap (a few hundred bytes, tmp+rename), but under a
// storm it is pointless churn. Throttle it — EXCEPT on an alert state change, which is always
// written immediately. The in-memory counters stay exact regardless; the file may lag by up
// to this interval, and the periodic `evaluateDropSurface` tick refreshes it anyway.
const MARKER_MIN_WRITE_INTERVAL_MS = 1_000;

export interface DropWindowVerdict {
  windowRecords: number;
  byReason: Record<string, number>;
  topReason: string | null;
  breaching: boolean;
  breachSinceMs: number | null;
  sustainedMs: number;
  sustained: boolean;
}

export interface DropBucket {
  records: number;
  byReason: Record<string, number>;
}

/** A count that is not a finite positive number contributes 0 — never NaN, never negative. */
function safeCount(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * classifyDropWindow — pure. Sums the buckets that fall inside the rolling window, decides
 * whether the rate is breaching, and carries the breach start forward so "sustained" is
 * measured from the FIRST crossing rather than the latest sample.
 *
 * Boundary-exact `>=` on both the threshold and the sustain window (mirrors
 * `classifyDaemonStuck`). A garbage reading can only ever push the sum DOWN (see
 * `safeCount`), so a bad bucket can never fabricate a breach.
 */
export function classifyDropWindow(
  buckets: Iterable<readonly [number, DropBucket]>,
  cfg: DropSurfaceConfig,
  nowMs: number,
  prevBreachSinceMs: number | null,
): DropWindowVerdict {
  const cutoff = nowMs - cfg.windowMs;
  let windowRecords = 0;
  const byReason: Record<string, number> = {};
  for (const [startMs, bucket] of buckets) {
    if (!(startMs >= cutoff)) continue; // outside the window (and NaN-safe)
    for (const [reason, count] of Object.entries(bucket?.byReason ?? {})) {
      const n = safeCount(count);
      if (n === 0) continue;
      byReason[reason] = (byReason[reason] ?? 0) + n;
      windowRecords += n;
    }
  }
  let topReason: string | null = null;
  for (const [reason, n] of Object.entries(byReason)) {
    if (topReason === null || n > byReason[topReason]) topReason = reason;
  }
  // `windowRecords > 0` is not redundant: a `thresholdRecords: 0` configuration means "alert on
  // any discard", and must still not read as breaching on a window in which nothing was discarded.
  const breaching = windowRecords > 0 && windowRecords >= cfg.thresholdRecords;
  const breachSinceMs = breaching ? (prevBreachSinceMs ?? nowMs) : null;
  const sustainedMs = breachSinceMs === null ? 0 : Math.max(0, nowMs - breachSinceMs);
  return {
    windowRecords,
    byReason,
    topReason,
    breaching,
    breachSinceMs,
    sustainedMs,
    sustained: breaching && sustainedMs >= cfg.sustainMs,
  };
}

// --- configuration ladder: env > forwarder config file > frozen default -------------------

function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  // A malformed or out-of-range override is IGNORED rather than silently disabling the
  // surface — the failure direction has to be "keep measuring", not "go quiet".
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export function resolveDropSurfaceConfig(fileCfg: Partial<DropSurfaceConfig> = {}): DropSurfaceConfig {
  const pick = (key: keyof DropSurfaceConfig, min: number) => {
    const v = fileCfg?.[key];
    return typeof v === "number" && Number.isFinite(v) && v >= min ? Math.floor(v) : DROP_SURFACE_DEFAULTS[key];
  };
  return {
    windowMs: envInt("CATALYST_FORWARD_DROP_WINDOW_MS", pick("windowMs", 1), 1),
    thresholdRecords: envInt("CATALYST_FORWARD_DROP_THRESHOLD_RECORDS", pick("thresholdRecords", 0), 0),
    sustainMs: envInt("CATALYST_FORWARD_DROP_SUSTAIN_MS", pick("sustainMs", 0), 0),
  };
}

// --- module state -------------------------------------------------------------------------

export interface DropTotals {
  events: number;
  records: number;
}

interface DropState {
  startedAt: string;
  totals: Record<string, DropTotals>;
  /** Cumulative totals read once from a marker written by a PREVIOUS process. */
  carried: Record<string, DropTotals> | null;
  carriedSeeded: boolean;
  buckets: Map<number, DropBucket>;
  breachSinceMs: number | null;
  alertRaised: boolean;
  alertSinceIso: string | null;
  alertReason: string | null;
  lastDrop: { ts: string; reason: string; count: number } | null;
  lastMarkerWriteMs: number;
  warnGate: (key: string, total: number) => boolean;
}

function freshState(): DropState {
  return {
    startedAt: new Date().toISOString(),
    totals: {},
    carried: null,
    carriedSeeded: false,
    buckets: new Map(),
    breachSinceMs: null,
    alertRaised: false,
    alertSinceIso: null,
    alertReason: null,
    lastDrop: null,
    lastMarkerWriteMs: 0,
    // Reasons are a closed two-value set today, so a small cap is plenty; it exists so a
    // future caller passing an open-ended reason string cannot grow the set without bound.
    warnGate: createSparseWarnGate({ maxTracked: 8 }),
  };
}

let state: DropState = freshState();
let cfg: DropSurfaceConfig = resolveDropSurfaceConfig();

/** Apply the forwarder config file's `otlp.dropSurface` block (env still wins). */
export function configureDropSurface(fileCfg: Partial<DropSurfaceConfig> = {}): void {
  cfg = resolveDropSurfaceConfig(fileCfg);
}

/** Test seam — drop all process state and re-read the config ladder. */
export function resetDropSurfaceForTest(): void {
  state = freshState();
  cfg = resolveDropSurfaceConfig();
}

/** In-memory view of the surface. Exact by construction; the marker file may lag it by ≤1 s. */
export function dropSurfaceSnapshot(): {
  startedAt: string;
  totals: Record<string, DropTotals>;
  alertRaised: boolean;
  config: DropSurfaceConfig;
} {
  return {
    startedAt: state.startedAt,
    totals: JSON.parse(JSON.stringify(state.totals)),
    alertRaised: state.alertRaised,
    config: { ...cfg },
  };
}

// --- the marker ----------------------------------------------------------------------------

function catalystDir(): string {
  return process.env.CATALYST_DIR ?? join(homedir(), "catalyst");
}

/**
 * Resolved PER CALL (the CTL-1502 predicates' discipline) so a pinned `CATALYST_DIR` is
 * honored no matter when the module was imported. Sits beside
 * `otel-forward.checkpoint.json` / `otel-forward-dlq-otlp.jsonl`.
 */
export function getDropMarkerPath(): string {
  return join(catalystDir(), "otel-forward-drops.json");
}

export interface DropSurfaceIo {
  now?: () => number;
  markerPath?: string;
  log?: { warn: Function; error: Function; info: Function };
}

function mergeTotals(
  a: Record<string, DropTotals> | null,
  b: Record<string, DropTotals>,
): Record<string, DropTotals> {
  const out: Record<string, DropTotals> = {};
  for (const src of [a ?? {}, b]) {
    for (const [reason, t] of Object.entries(src)) {
      const prev = out[reason] ?? { events: 0, records: 0 };
      out[reason] = {
        events: prev.events + safeCount(t?.events),
        records: prev.records + safeCount(t?.records),
      };
    }
  }
  return out;
}

/** buildDropMarker — pure. The exact JSON an operator (or a future HUD panel) reads. */
export function buildDropMarker(args: {
  nowIso: string;
  host: string;
  pid: number;
  startedAt: string;
  cfg: DropSurfaceConfig;
  totals: Record<string, DropTotals>;
  carried: Record<string, DropTotals> | null;
  verdict: DropWindowVerdict;
  alert: { raised: boolean; sinceIso: string | null; reason: string | null };
  lastDrop: { ts: string; reason: string; count: number } | null;
}) {
  return {
    daemon: "otel-forward",
    ticket: "CTL-1818",
    host: args.host,
    pid: args.pid,
    updatedAt: args.nowIso,
    processStartedAt: args.startedAt,
    /** Discards by THIS process — exact. */
    process: args.totals,
    /** Discards carried across restarts (seeded from a marker a previous process wrote). */
    cumulative: mergeTotals(args.carried, args.totals),
    window: {
      windowMs: args.cfg.windowMs,
      records: args.verdict.windowRecords,
      byReason: args.verdict.byReason,
      thresholdRecords: args.cfg.thresholdRecords,
      breaching: args.verdict.breaching,
      sustainMs: args.cfg.sustainMs,
      sustainedMs: args.verdict.sustainedMs,
    },
    alert: {
      raised: args.alert.raised,
      since: args.alert.sinceIso,
      reason: args.alert.reason,
    },
    lastDrop: args.lastDrop,
  };
}

function seedCarried(path: string): void {
  if (state.carriedSeeded) return;
  state.carriedSeeded = true;
  try {
    const prior = JSON.parse(readFileSync(path, "utf8")) as { cumulative?: Record<string, DropTotals> };
    // Only a well-shaped prior marker seeds the carry-forward; anything else starts clean
    // rather than importing garbage into the operator-facing number.
    if (prior?.cumulative && typeof prior.cumulative === "object") state.carried = prior.cumulative;
  } catch {
    /* no prior marker (or unreadable) — cumulative starts at this process's totals */
  }
}

function writeMarker(io: DropSurfaceIo, verdict: DropWindowVerdict, nowMs: number): void {
  try {
    const path = io.markerPath ?? getDropMarkerPath();
    seedCarried(path);
    const marker = buildDropMarker({
      nowIso: new Date(nowMs).toISOString(),
      host: hostname(),
      pid: process.pid,
      startedAt: state.startedAt,
      cfg,
      totals: state.totals,
      carried: state.carried,
      verdict,
      alert: { raised: state.alertRaised, sinceIso: state.alertSinceIso, reason: state.alertReason },
      lastDrop: state.lastDrop,
    });
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(marker, null, 2));
    renameSync(tmp, path); // atomic — a reader never sees a half-written marker
    state.lastMarkerWriteMs = nowMs;
  } catch {
    /* best-effort: the file is the convenience, the in-memory counter is the measurement */
  }
}

function safeLog(io: DropSurfaceIo, level: "warn" | "error" | "info", obj: object, msg: string): void {
  try {
    const l = (io.log ?? defaultLog) as Record<string, Function>;
    // Called through `.call(l, …)` — pino's level methods need the logger as their `this`
    // receiver, and a bare extracted call would throw into the catch below, silently
    // swallowing every record on the one sink that is independent of the OTLP egress
    // (the same trap CTL-1502's alert module documents).
    (l[level] ?? l.info ?? (() => {})).call(l, obj, msg);
  } catch {
    /* best-effort */
  }
}

// --- evaluation -----------------------------------------------------------------------------

function bucketMs(): number {
  return Math.max(1_000, Math.ceil(cfg.windowMs / BUCKET_COUNT));
}

function pruneBuckets(nowMs: number): void {
  const cutoff = nowMs - cfg.windowMs;
  for (const startMs of state.buckets.keys()) {
    if (startMs < cutoff) state.buckets.delete(startMs);
  }
}

/**
 * Prune → classify → apply the alert edges → refresh the marker. Shared by `recordDrop` and
 * the periodic `evaluateDropSurface` tick; returns the verdict so the caller can log it.
 */
function evaluate(nowMs: number, io: DropSurfaceIo): DropWindowVerdict {
  pruneBuckets(nowMs);
  const verdict = classifyDropWindow(state.buckets.entries(), cfg, nowMs, state.breachSinceMs);
  state.breachSinceMs = verdict.breachSinceMs;

  let alertChanged = false;
  if (verdict.sustained && !state.alertRaised) {
    // RAISE — edge-triggered, once per episode. Alert-only: no restart, no actuation.
    state.alertRaised = true;
    state.alertSinceIso = new Date(nowMs).toISOString();
    state.alertReason = verdict.topReason;
    alertChanged = true;
    safeLog(
      io,
      "error",
      {
        host: hostname(),
        reason: verdict.topReason,
        window_records: verdict.windowRecords,
        window_ms: cfg.windowMs,
        threshold_records: cfg.thresholdRecords,
        sustained_ms: verdict.sustainedMs,
        by_reason: verdict.byReason,
        marker: io.markerPath ?? getDropMarkerPath(),
      },
      "otel-forward SUSTAINED EVENT LOSS — discard rate above threshold for the sustain window; these events were never delivered and never dead-lettered (CTL-1818)",
    );
  } else if (!verdict.breaching && state.alertRaised) {
    // CLEAR — the window has drained. Without the periodic tick calling this, a host that
    // recovered would latch "raised" forever, because nothing else re-evaluates.
    state.alertRaised = false;
    state.alertSinceIso = null;
    state.alertReason = null;
    alertChanged = true;
    safeLog(
      io,
      "info",
      { host: hostname(), window_ms: cfg.windowMs, marker: io.markerPath ?? getDropMarkerPath() },
      "otel-forward discard rate back under threshold — sustained-loss alert cleared (CTL-1818)",
    );
  }

  // An alert transition is ALWAYS written through immediately; routine counter updates are
  // throttled so a discard storm cannot turn into a rewrite storm.
  const due = nowMs - state.lastMarkerWriteMs >= MARKER_MIN_WRITE_INTERVAL_MS;
  if (alertChanged || due) writeMarker(io, verdict, nowMs);
  return verdict;
}

/**
 * recordDrop — the ONE accounting call. Invoked from `OtlpSender.emitDrop` BEFORE its
 * event-emission guards, so a discard is counted even when no `forward_dropped` event is
 * written at all. Never throws: it runs on the discard path, and a tap must never be able to
 * wedge the thing it measures.
 */
export function recordDrop(reason: DropReason | string, records: number, io: DropSurfaceIo = {}): void {
  try {
    const nowMs = io.now ? io.now() : Date.now();
    const n = safeCount(records);
    const prev = state.totals[reason] ?? { events: 0, records: 0 };
    state.totals[reason] = { events: prev.events + 1, records: prev.records + n };
    state.lastDrop = { ts: new Date(nowMs).toISOString(), reason, count: n };

    const size = bucketMs();
    const startMs = Math.floor(nowMs / size) * size;
    const bucket = state.buckets.get(startMs) ?? { records: 0, byReason: {} };
    bucket.records += n;
    bucket.byReason[reason] = (bucket.byReason[reason] ?? 0) + n;
    state.buckets.set(startMs, bucket);

    const verdict = evaluate(nowMs, io);

    // Sparse alarm on the pino log — the counter above is the measurement, this is the line
    // an operator (or a Loki rule over the .log stream) actually sees.
    const total = state.totals[reason].events;
    if (state.warnGate(`drop:${reason}`, total)) {
      safeLog(
        io,
        "warn",
        {
          host: hostname(),
          reason,
          drop_events_total: total,
          drop_records_total: state.totals[reason].records,
          window_records: verdict.windowRecords,
          window_ms: cfg.windowMs,
          marker: io.markerPath ?? getDropMarkerPath(),
        },
        "otel-forward DISCARDED events — never delivered, never dead-lettered; invisible to the DLQ-size and checkpoint-lag guardrails (CTL-1818)",
      );
    }
  } catch {
    /* never throw on the discard path */
  }
}

/**
 * evaluateDropSurface — the periodic tick (wired to the forwarder's existing 30 s lag timer).
 * Two jobs no drop-driven call can do: clear a latched alert on a host that has recovered and
 * gone quiet, and keep the marker's window figures honest while nothing is being discarded.
 */
export function evaluateDropSurface(io: DropSurfaceIo = {}): void {
  try {
    const nowMs = io.now ? io.now() : Date.now();
    // Nothing has ever been recorded → no marker to write; do not create an empty one.
    if (state.lastDrop === null) return;
    evaluate(nowMs, io);
  } catch {
    /* best-effort */
  }
}
