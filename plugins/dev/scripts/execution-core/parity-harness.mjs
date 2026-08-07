#!/usr/bin/env bun
// parity-harness.mjs — CTL-1534 (ADR-0008 leg 3, phase 3).
//
// Compares the SHADOW event log (~/catalyst/events-shadow/YYYY-MM.jsonl, produced by the
// catalyst-cloud `/events/stream` consumer) against the LIVE event log
// (~/catalyst/events/YYYY-MM.jsonl, produced by the smee webhook path), joined on
// `attributes["webhook.delivery.id"]` (CTL-1532 — the ONLY join key; the cloud feed's
// `deliveryId` carries the same provider-issued value).
//
// ────────────────────────────────────────────────────────────────────────────────────────
// THE POINT OF THIS FILE IS TO NOT REPORT A CONFIDENT GREEN.
//
// Every rule below is a defect that actually shipped in catalyst-cloud's equivalent harness
// (11 defects across 3 review rounds, every one producing a confident green). They are
// correctness requirements, not style:
//
//  1. THREE-WAY EXIT.  0 = evaluated-healthy · 1 = evaluated-problem · 2 = COULD NOT EVALUATE.
//     Collapsing 2 into 0 was the worst defect. "I could not check" NEVER renders as healthy.
//  2. COVERAGE != INTEGRITY.  Asserted separately, and coverage is only asserted when the
//     input can actually support it (see --seq-ledger-complete). A short read is internally
//     contiguous and carries no control record; contiguity cannot see it at any rigour.
//  3. A CONTROL RECORD INVALIDATES THE RUN -> exit 2. The prefix before it is contiguous, so a
//     naive contiguity check passes a server-declared incomplete scan.
//  4. WIRE ORDER ONLY, NEVER SORT. Sorting turns 1,3,2 into a clean pass.
//  5. NON-ZERO MATCHED PAIRS PER SOURCE. A zero-match join is indistinguishable from perfect
//     parity if you only count mismatches.
//  6. NEVER NORMALISE THE EVIDENCE. No coercion (`--from banana` is rejected, never NaN'd),
//     no defaulting, no sorting of adjacency evidence. Bad input -> exit 2.
//  7. --since / persisted cursor from day one (here: --expect-first-seq / --expect-head-seq,
//     never a hardcoded 0).
//  8. NEGATIVE CONTROLS RUN CREDENTIAL-FREE AND OFFLINE (--self-test), and are OBSERVED to go
//     red on seeded failures (plus a positive control, so a stuck-red harness cannot pass).
//  9. PER-TYPE COUNTS, NEVER PRESENCE. "at least one workflow_job seen" is satisfied by one
//     lucky event while a filter drops 99%.
// 10. AN OMITTED ROW IS INDISTINGUISHABLE FROM NOBODY LOOKING. Expected-zero rows are printed
//     as expected-zero. Checks that did not run are printed in the headline verdict.
// ────────────────────────────────────────────────────────────────────────────────────────
//
// This file reads two on-disk logs. It never opens a network connection and never reads a
// credential. Feed-side health (contiguity/coverage of the HTTP replay itself) is owned by
// catalyst-cloud's `feed-health.mjs`; consume its exit code, do not re-derive it here.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

// ── exit contract ───────────────────────────────────────────────────────────────────────
export const EXIT_HEALTHY = 0; // evaluated, healthy
export const EXIT_PROBLEM = 1; // evaluated, problem found
export const EXIT_CANNOT_EVALUATE = 2; // did NOT evaluate — never report as healthy

// ── declared comparison policy (printed every run; never silent) ─────────────────────────

// Attributes whose PRESENCE legitimately differs between the two producers because they are
// enriched from LOCAL state (the monitor's PR-number cache, its Linear teams map, its
// orchestrator resolver) that the shadow consumer may not have. A presence-only difference is
// INFO; a difference where BOTH sides carry a value but the values disagree is always a FAIL.
// `--strict-attrs` promotes presence-only differences to FAIL.
export const ATTR_LOCAL_ENRICHMENT = new Set([
  "catalyst.orchestrator.id",
  "vcs.pr.number", // check_suite/status PR attribution comes from the local prCache
  "vcs.repository.name", // linear.* gets this from the monitor's teamsMap (CTL-362)
]);

// Envelope-level fields deliberately NOT compared, with the reason. Printed as policy.
export const ENVELOPE_UNCOMPARED = [
  ["ts / observedTs", "cloud is ~12s ahead of smee by design; timestamps are not parity"],
  ["id", "per-emission UUIDv4, unique per producer by construction"],
  ["traceId / spanId", "derived per producer"],
  ["resource.*", "service.name/version/host identify the PRODUCER, not the event"],
  ["body.payload", "compared indirectly via attributes; payload diffs are mapper-identical by construction (same webhook-events.ts) and noisy to diff"],
];

// Type census. `event.name` PREFIX -> expectation. Counts, never presence (rule 9).
//   both       — smee and the cloud should both deliver it; live > shadow is a DEFICIT (fail)
//   cloud-only — the cloud carries it, smee never did; shadow > live is EXPECTED (info)
//   known-gap  — a *tracked* cloud-side subscription gap; live > shadow is expected-and-filed
export const DEFAULT_TYPE_CENSUS = [
  { prefix: "github.pr.", expectation: "both" },
  { prefix: "github.pr_review.", expectation: "both" },
  { prefix: "github.pr_review_thread.", expectation: "both" },
  { prefix: "github.issue_comment.", expectation: "both" },
  { prefix: "github.status.", expectation: "both" },
  { prefix: "github.deployment.", expectation: "both" },
  { prefix: "github.deployment_status.", expectation: "both" },
  { prefix: "github.release.", expectation: "both" },
  // measured on the live feed (444 events, first hour): these were previously DISCARDED by the
  // smee path (or, for push, never even enqueued) — a cloud superset, not an error.
  { prefix: "github.check_suite.", expectation: "cloud-only" },
  { prefix: "github.workflow_run.", expectation: "cloud-only" },
  { prefix: "github.push.", expectation: "cloud-only" },
  { prefix: "github.pr_review_comment.", expectation: "cloud-only" },
  { prefix: "linear.issue.", expectation: "both" },
  { prefix: "linear.comment.", expectation: "both" },
  { prefix: "linear.cycle.", expectation: "both" },
  { prefix: "linear.issue_label.", expectation: "both" },
  { prefix: "linear.agent_session.", expectation: "both" },
  { prefix: "linear.mention.", expectation: "both" },
  // CTC-297: a real, filed cloud subscription gap — smee received a Reaction the cloud did not.
  // Reported loudly every run; does not fail unless --strict-known-gaps.
  { prefix: "linear.reaction.", expectation: "known-gap", ticket: "CTC-297" },
];

// Provider event types the cloud feed carries that `webhook-events.ts` has NO mapper for.
// They therefore produce NO envelope on EITHER side and are structurally invisible to this
// harness. Printed as expected-zero rows so the absence is a stated result, not an omission.
export const UNMAPPABLE_PROVIDER_TYPES = [
  { type: "workflow_job", source: "github", note: "no case in parseWebhookEvent -> ignored" },
  { type: "check_run", source: "github", note: "no case in parseWebhookEvent -> ignored" },
  { type: "Attachment", source: "linear", note: "no case in parseLinearWebhookEvent -> ignored (CTC-295)" },
];

// ── shadow-log MARKERS ──────────────────────────────────────────────────────────────────
// The shadow consumer writes explicit marker records for the two things it cannot map into an
// envelope. They are NOT webhook envelopes, so without this the harness would count them as
// unrelated noise and skip them — while a `gap` marker means the consumer itself declared the
// window incomplete, and an `elided` marker is the ONLY thing that makes a >96KB payloadOmitted
// delivery attributable rather than a mystery live-only row.
//
//   gap    — the consumer declared a hole in its own coverage  -> the run is NOT evaluable
//   elided — payloadOmitted (>96KB): unmappable by construction -> an ATTRIBUTED live-only row
//
// Names are matched by prefix (--marker-prefix) so a consumer rename surfaces as an UNKNOWN
// marker (exit 2), never as silence.
export const DEFAULT_MARKER_PREFIX = "catalyst.cloud_feed.";
/**
 * The cloud edge cap (96KB), enforced before the queue. An `elided` marker claims a
 * delivery was over it; this harness verifies that claim before letting the marker
 * excuse a missing delivery. Must match cloud-event-consumer.mjs PAYLOAD_CAP_BYTES.
 */
export const PAYLOAD_CAP_BYTES = 96 * 1024;
export const MARKER_KINDS = {
  "catalyst.cloud_feed.gap": "gap",
  "catalyst.cloud_feed.unmappable_payload": "elided",
};

// What this harness structurally CANNOT see. Printed on every run — a blind spot that is not
// stated is indistinguishable from a blind spot nobody looked for.
export const BLIND_SPOTS = [
  "Provider types with no mapper in webhook-events.ts (workflow_job, check_run, Linear Attachment) produce no envelope on EITHER side. Gate B's superset claim for those types needs cloud-side per-type counts (catalyst-cloud feed-health.mjs --json), not this harness.",
  "Pre-append cloud loss classes (catalyst.mirror.ingest.enqueue_failed / dead_lettered) never receive a seq and never reach any log — cloud-side metrics own them.",
  "A delivery neither provider path ever received is invisible to both sides. This harness detects DISAGREEMENT; it cannot detect 'both paths equally and quietly wrong'.",
  "HTTP-level short reads the consumer handled internally without writing a marker to the shadow log. Feed coverage is feed-health.mjs's job (defect 6: integrity never implies coverage).",
  "payloadOmitted (>96KB elided) deliveries are unmappable by construction. This harness attributes them ONLY via the consumer's elision markers (--marker-prefix); a consumer that writes no marker leaves them as unexplained live-only rows.",
];

// ── strict input parsing (rule 6: reject, never repair) ─────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** Strict ISO-8601 timestamp -> epoch ms. No coercion, no Date() fallback parsing. */
export function parseIsoStrict(value) {
  if (typeof value !== "string" || !ISO_RE.test(value)) {
    return { ok: false, reason: `not a strict ISO-8601 timestamp: ${JSON.stringify(value)}` };
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return { ok: false, reason: `unparseable timestamp: ${value}` };
  return { ok: true, ms };
}

/**
 * Strict non-negative integer. `Number("banana")` -> NaN and `Number("")` -> 0 are exactly the
 * coercions that let a harness silently report on a range nobody asked for.
 */
export function parseIntStrict(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    return { ok: false, reason: `not a non-negative integer: ${JSON.stringify(value)}` };
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return { ok: false, reason: `integer out of safe range: ${value}` };
  return { ok: true, value: n };
}

const FLAGS_WITH_VALUE = new Set([
  "--live", "--shadow", "--live-dir", "--shadow-dir", "--from", "--to",
  "--edge-margin", "--sources", "--repos", "--seq-attr", "--ignore-attr", "--marker-prefix",
  "--expect-first-seq", "--expect-head-seq", "--max-list",
]);
const BOOL_FLAGS = new Set([
  "--json", "--self-test", "--help", "-h",
  "--no-seq-checks", "--seq-ledger-complete", "--require-coverage",
  "--allow-version-span", "--allow-partial-overlap",
  "--strict-shadow-only", "--strict-known-gaps", "--strict-attrs",
  "--tolerate-torn-tail",
]);

/** Parse argv. An unknown flag is an error — never silently ignored. */
export function parseArgs(argv) {
  const o = {
    live: [], shadow: [],
    liveDir: null, shadowDir: null,
    fromIso: null, toIso: null, fromMs: null, toMs: null,
    edgeMarginMs: 120_000,
    sources: ["github", "linear"],
    repos: null,
    seqAttr: "catalyst.cloud.event.seq",
    ignoreAttrs: [],
    markerPrefix: DEFAULT_MARKER_PREFIX,
    seqChecks: true,
    seqLedgerComplete: false,
    expectFirstSeq: null, expectHeadSeq: null, requireCoverage: false,
    allowVersionSpan: false, allowPartialOverlap: false,
    strictShadowOnly: false, strictKnownGaps: false, strictAttrs: false,
    tolerateTornTail: false,
    maxList: 25,
    json: false, selfTest: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.has(a)) {
      if (a === "--json") o.json = true;
      else if (a === "--self-test") o.selfTest = true;
      else if (a === "--help" || a === "-h") o.help = true;
      else if (a === "--no-seq-checks") o.seqChecks = false;
      else if (a === "--seq-ledger-complete") o.seqLedgerComplete = true;
      else if (a === "--require-coverage") o.requireCoverage = true;
      else if (a === "--allow-version-span") o.allowVersionSpan = true;
      else if (a === "--allow-partial-overlap") o.allowPartialOverlap = true;
      else if (a === "--strict-shadow-only") o.strictShadowOnly = true;
      else if (a === "--strict-known-gaps") o.strictKnownGaps = true;
      else if (a === "--strict-attrs") o.strictAttrs = true;
      else if (a === "--tolerate-torn-tail") o.tolerateTornTail = true;
      continue;
    }
    if (!FLAGS_WITH_VALUE.has(a)) {
      return { ok: false, reason: `unknown argument: ${a} (run --help)` };
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) return { ok: false, reason: `${a} requires a value` };
    i++;
    switch (a) {
      case "--live": o.live.push(v); break;
      case "--shadow": o.shadow.push(v); break;
      case "--live-dir": o.liveDir = v; break;
      case "--shadow-dir": o.shadowDir = v; break;
      case "--from": {
        const p = parseIsoStrict(v);
        if (!p.ok) return { ok: false, reason: `--from ${p.reason}` };
        o.fromIso = v; o.fromMs = p.ms; break;
      }
      case "--to": {
        const p = parseIsoStrict(v);
        if (!p.ok) return { ok: false, reason: `--to ${p.reason}` };
        o.toIso = v; o.toMs = p.ms; break;
      }
      case "--edge-margin": {
        const p = parseIntStrict(v);
        if (!p.ok) return { ok: false, reason: `--edge-margin ${p.reason}` };
        o.edgeMarginMs = p.value * 1000; break;
      }
      case "--sources": {
        const parts = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        if (parts.length === 0) return { ok: false, reason: "--sources is empty" };
        for (const s of parts) {
          if (s !== "github" && s !== "linear") {
            return { ok: false, reason: `--sources: unknown source ${JSON.stringify(s)} (github|linear)` };
          }
        }
        o.sources = parts; break;
      }
      case "--repos": {
        const parts = v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
        if (parts.length === 0) return { ok: false, reason: "--repos is empty" };
        o.repos = parts; break;
      }
      case "--seq-attr": {
        // An empty key would make seqOf() read attributes[""] on every envelope and
        // report "no seqs" — a silently disabled subsystem, not a configuration.
        if (v.trim().length === 0) return { ok: false, reason: "--seq-attr is empty" };
        o.seqAttr = v; break;
      }
      case "--ignore-attr": o.ignoreAttrs.push(v); break;
      case "--marker-prefix": {
        // An empty prefix makes marker detection a total no-op: the consumer's own
        // coverage declarations fall through to the "unrelated noise" counter and a
        // window the consumer declared INCOMPLETE reports healthy.
        if (v.trim().length === 0) return { ok: false, reason: "--marker-prefix is empty — that would disable marker detection entirely" };
        o.markerPrefix = v; break;
      }
      case "--expect-first-seq": {
        const p = parseIntStrict(v);
        if (!p.ok) return { ok: false, reason: `--expect-first-seq ${p.reason}` };
        o.expectFirstSeq = p.value; break;
      }
      case "--expect-head-seq": {
        const p = parseIntStrict(v);
        if (!p.ok) return { ok: false, reason: `--expect-head-seq ${p.reason}` };
        o.expectHeadSeq = p.value; break;
      }
      case "--max-list": {
        const p = parseIntStrict(v);
        if (!p.ok) return { ok: false, reason: `--max-list ${p.reason}` };
        o.maxList = p.value; break;
      }
    }
  }
  if (o.fromMs !== null && o.toMs !== null && o.fromMs > o.toMs) {
    return { ok: false, reason: `--from (${o.fromIso}) is after --to (${o.toIso})` };
  }
  return { ok: true, opts: o };
}

// ── record classification ───────────────────────────────────────────────────────────────

/**
 * A cloud-feed CONTROL RECORD: a line carrying `error` and NO `seq`
 * (e.g. {"error":"cursor_underflow","resync":true}). Structural discrimination is the
 * contract — provider JSON always nests under `payload`, so a provider body with its own
 * `error` key surfaces at `payload.error` and cannot collide.
 */
export function isControlRecord(obj) {
  return (
    typeof obj === "object" && obj !== null && !Array.isArray(obj) &&
    Object.hasOwn(obj, "error") && !Object.hasOwn(obj, "seq")
  );
}

/** v2 envelope -> "github" | "linear" | null (the prefix of attributes["event.name"]). */
export function envelopeSource(obj) {
  const attrs = obj?.attributes;
  if (typeof attrs !== "object" || attrs === null) return null;
  const name = attrs["event.name"];
  if (typeof name !== "string") return null;
  const dot = name.indexOf(".");
  if (dot <= 0) return null;
  const prefix = name.slice(0, dot);
  return prefix === "github" || prefix === "linear" ? prefix : null;
}

export function deliveryIdOf(obj) {
  const v = obj?.attributes?.["webhook.delivery.id"];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function eventNameOf(obj) {
  const v = obj?.attributes?.["event.name"];
  return typeof v === "string" ? v : "(missing event.name)";
}

export function repoOf(obj) {
  const v = obj?.attributes?.["vcs.repository.name"];
  return typeof v === "string" && v.length > 0 ? v : "(none)";
}

/**
 * Read the cloud seq the consumer stamped on a shadow envelope. Strict: integer NUMBERS only.
 *
 * A STRING seq used to be coerced through parseIntStrict. That is rule 6 ("never normalise
 * the evidence") violated by the tool that enforces it: cloud-event-consumer's mapCloudEvent
 * rejects anything but a safe-integer number before stamping, so a string here means the
 * producer or the transport changed shape underneath us. Repairing it hides that; it is
 * invalid evidence, and SEQ_ATTR_INVALID exists to say so.
 */
export function seqOf(obj, seqAttr) {
  const attrs = obj?.attributes;
  if (typeof attrs !== "object" || attrs === null || !Object.hasOwn(attrs, seqAttr)) return { ok: null }; // absent
  const v = attrs[seqAttr];
  if (typeof v === "number") return Number.isSafeInteger(v) ? { ok: true, seq: v } : { ok: false, raw: v };
  return { ok: false, raw: v };
}

// ── JSONL ingestion ─────────────────────────────────────────────────────────────────────

/**
 * Fold one JSONL line into a side's accumulator. Kept pure and line-at-a-time so the file
 * reader can STREAM (the live log is ~330MB; a whole-file readFileSync is the documented
 * cause of multi-second event-loop stalls elsewhere in this repo).
 */
export function ingestLine(acc, rawLine, lineNo, file, opts) {
  acc.lines++;
  const line = rawLine.trim();
  if (line.length === 0) { acc.blank++; return; }
  // Tracked so the --tolerate-torn-tail waiver means "the last line WITH CONTENT" identically
  // for the streaming file reader (no trailing empty element) and for ingestText (which yields
  // one). Comparing against the raw line count would silently change what the waiver covers.
  acc.lastContentLineNo = lineNo;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch (err) {
    acc.malformed.push({ file, lineNo, reason: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (isControlRecord(obj)) {
    acc.control.push({ file, lineNo, record: obj });
    return;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    acc.malformed.push({ file, lineNo, reason: "line is not a JSON object" });
    return;
  }
  // Marker records first: they are consumer DECLARATIONS about coverage, not events, and are
  // not source-prefixed — so classifying by source would file them under "unrelated noise".
  // The BUILT-IN prefix is a floor that no flag can lower: re-pointing (or
  // emptying) --marker-prefix must never make a consumer coverage declaration
  // invisible. --marker-prefix only ever ADDS a second prefix to watch.
  const rawName = obj?.attributes?.["event.name"];
  if (
    typeof rawName === "string" &&
    (rawName.startsWith(DEFAULT_MARKER_PREFIX) ||
      (opts.markerPrefix.length > 0 && rawName.startsWith(opts.markerPrefix)))
  ) {
    const mTs = parseIsoStrict(obj.ts);
    acc.markers.push({
      file, lineNo, name: rawName, kind: MARKER_KINDS[rawName] ?? "unknown",
      deliveryId: deliveryIdOf(obj), ts: mTs.ok ? mTs.ms : null,
      // A marker whose ts cannot be parsed is treated as IN window: a declaration we cannot
      // place must not be silently excluded from the window it might belong to.
      inWindow: !mTs.ok || ((opts.fromMs === null || mTs.ms >= opts.fromMs) && (opts.toMs === null || mTs.ms <= opts.toMs)),
      raw: obj,
    });
    return;
  }

  const source = envelopeSource(obj);
  if (source === null) { acc.nonWebhook++; return; }
  acc.webhookTotal++;

  const fileOrderIndex = acc.all.length;
  const tsParsed = parseIsoStrict(obj.ts);
  if (!tsParsed.ok) {
    acc.badTs.push({ file, lineNo, reason: tsParsed.reason });
    // Still recorded in file order so seq adjacency is not silently re-stitched around it.
    acc.all.push({ file, lineNo, fileOrderIndex, obj, source, ts: null, inWindow: false });
    return;
  }
  const entry = { file, lineNo, fileOrderIndex, obj, source, ts: tsParsed.ms, inWindow: false };

  const afterFrom = opts.fromMs === null || tsParsed.ms >= opts.fromMs;
  const beforeTo = opts.toMs === null || tsParsed.ms <= opts.toMs;
  entry.inWindow = afterFrom && beforeTo;
  acc.all.push(entry);
  if (!entry.inWindow) { acc.outOfWindow++; return; }

  // --repos scopes GitHub only: linear envelopes carry vcs.repository.name only when the
  // monitor's teamsMap resolved it, so filtering them on repo would silently drop events.
  if (opts.repos !== null && source === "github" && !opts.repos.includes(repoOf(obj))) {
    acc.repoFiltered++;
    return;
  }
  if (!opts.sources.includes(source)) { acc.sourceFiltered++; return; }

  const version = obj?.resource?.["service.version"];
  if (typeof version === "string") acc.versions.add(version);
  const host = obj?.resource?.["host.name"];
  if (typeof host === "string") acc.hosts.add(host);

  const id = deliveryIdOf(obj);
  if (id === null) {
    acc.missingDeliveryId.push({ file, lineNo, eventName: eventNameOf(obj), ts: obj.ts });
    return;
  }
  entry.deliveryId = id;
  acc.selected.push(entry);
}

export function newSideAcc(label) {
  return {
    label, files: [],
    lines: 0, blank: 0, nonWebhook: 0, webhookTotal: 0, lastContentLineNo: 0,
    outOfWindow: 0, repoFiltered: 0, sourceFiltered: 0,
    malformed: [], control: [], badTs: [], missingDeliveryId: [], markers: [],
    versions: new Set(), hosts: new Set(),
    all: [], selected: [],
  };
}

/** Ingest an in-memory JSONL string. Used by the unit tests and the offline self-test. */
export function ingestText(label, text, opts, file = "<memory>") {
  const acc = newSideAcc(label);
  acc.files.push(file);
  const lines = text.split("\n");
  // A trailing newline yields a final empty element — that is a blank line, not a torn line.
  for (let i = 0; i < lines.length; i++) ingestLine(acc, lines[i], i + 1, file, opts);
  return acc;
}

/** Stream a JSONL file into an accumulator (bounded memory over the compared subset). */
export async function ingestFile(acc, file, opts) {
  acc.files.push(file);
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) ingestLine(acc, line, ++lineNo, file, opts);
}

/** Month files (YYYY-MM.jsonl) covering the window; current month when unbounded. */
export function monthFilesFor(dir, fromMs, toMs) {
  const start = new Date(fromMs ?? Date.now());
  const end = new Date(toMs ?? Date.now());
  const out = [];
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  const endY = end.getUTCFullYear();
  const endM = end.getUTCMonth();
  // Guard against an absurd window silently generating thousands of paths.
  for (let guard = 0; guard < 240; guard++) {
    out.push(join(dir, `${y}-${String(m + 1).padStart(2, "0")}.jsonl`));
    if (y === endY && m === endM) break;
    if (y > endY || (y === endY && m > endM)) break;
    m++;
    if (m > 11) { m = 0; y++; }
  }
  return out;
}

// ── join + comparison primitives (pure; unit-tested) ────────────────────────────────────

/** Index selected entries by delivery id, in FILE ORDER. Duplicates are recorded, not merged. */
export function indexByDelivery(selected) {
  const byId = new Map();
  const duplicates = [];
  for (const e of selected) {
    const prior = byId.get(e.deliveryId);
    if (prior === undefined) byId.set(e.deliveryId, e);
    else duplicates.push({ deliveryId: e.deliveryId, firstLine: prior.lineNo, dupLine: e.lineNo, eventName: eventNameOf(e.obj) });
  }
  return { byId, duplicates };
}

/** Join two id-indexes. No sorting anywhere. */
export function joinDeliveries(liveById, shadowById) {
  const matched = [];
  const liveOnly = [];
  for (const [id, live] of liveById) {
    const shadow = shadowById.get(id);
    if (shadow === undefined) liveOnly.push(live);
    else matched.push({ id, live, shadow });
  }
  const shadowOnly = [];
  for (const [id, shadow] of shadowById) if (!liveById.has(id)) shadowOnly.push(shadow);
  return { matched, liveOnly, shadowOnly };
}

export function countBySource(entries, keyFn = (e) => e.source) {
  const out = { github: 0, linear: 0 };
  for (const e of entries) {
    const k = keyFn(e);
    if (k === "github" || k === "linear") out[k]++;
  }
  return out;
}

/** Per-type counts keyed on attributes["event.name"] — counts, never presence. */
export function perTypeCounts(entries) {
  const m = new Map();
  for (const e of entries) {
    const n = eventNameOf(e.obj);
    m.set(n, (m.get(n) ?? 0) + 1);
  }
  return m;
}

export function censusExpectationFor(eventName, census = DEFAULT_TYPE_CENSUS) {
  for (const row of census) {
    if (eventName.startsWith(row.prefix)) return row;
  }
  return { prefix: null, expectation: "uncensused" };
}

/**
 * Gate B input. Every type seen on EITHER side, plus explicit expected-zero rows for every
 * censused prefix that produced nothing and for every unmappable provider type.
 * Verdicts: deficit (live > shadow, censused "both"/"cloud-only"/"uncensused") is a FAIL
 * candidate; known-gap deficits are reported against their ticket; shadow > live is the
 * expected cloud superset.
 */
export function compareTypeCounts(liveCounts, shadowCounts, census = DEFAULT_TYPE_CENSUS, attributedByType = new Map()) {
  const rows = [];
  const seen = new Set([...liveCounts.keys(), ...shadowCounts.keys()]);
  for (const type of seen) {
    const live = liveCounts.get(type) ?? 0;
    const shadow = shadowCounts.get(type) ?? 0;
    // RAW counts stay in the row (they are the Gate B evidence and are never rewritten). The
    // deficit VERDICT discounts deliveries the consumer explicitly attributed to an elision
    // marker — otherwise an already-accounted-for >96KB payload reads as an unexplained loss.
    const attributed = attributedByType.get(type) ?? 0;
    const effectiveLive = live - attributed;
    const c = censusExpectationFor(type, census);
    let verdict;
    if (effectiveLive > shadow) verdict = c.expectation === "known-gap" ? "known-gap-deficit" : "shadow-deficit";
    else if (shadow > live) {
      // The shadow>live direction is classified against the CENSUS, never against
      // presence. Only a `cloud-only` row is the expected superset; for a row the
      // census says BOTH sides carry, shadow>live is a LIVE-side loss — and
      // live===0 is a TOTAL live-side loss, which is exactly the shape a
      // presence-based split ("live has no key for this type, so it must be
      // superset") mislabels as expected.
      verdict =
        c.expectation === "cloud-only"
          ? "cloud-superset"
          : live === 0
            ? "live-total-loss"
            : "live-deficit";
    } else verdict = live === 0 ? "expected-zero" : attributed > 0 ? "equal-after-attribution" : "equal";
    rows.push({ type, live, shadow, attributedElided: attributed, expectation: c.expectation, ticket: c.ticket ?? null, verdict });
  }
  // Censused prefixes that produced NOTHING on either side: printed as expected-zero rows.
  // An omitted row is indistinguishable from nobody looking.
  for (const row of census) {
    const anySeen = [...seen].some((t) => t.startsWith(row.prefix));
    if (!anySeen) {
      rows.push({
        type: `${row.prefix}*`, live: 0, shadow: 0, attributedElided: 0,
        expectation: row.expectation, ticket: row.ticket ?? null, verdict: "expected-zero",
      });
    }
  }
  for (const u of UNMAPPABLE_PROVIDER_TYPES) {
    rows.push({
      type: `${u.type} (provider type, ${u.source})`, live: 0, shadow: 0, attributedElided: 0,
      expectation: "unmappable", ticket: null, verdict: "expected-zero-structural", note: u.note,
    });
  }
  // Alphabetical row order is PRESENTATION of counts. Adjacency evidence (seq) is never sorted.
  rows.sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return rows;
}

const STABLE_ENVELOPE_FIELDS = ["severityText"];

/**
 * Envelope equivalence for one matched pair. Returns a list of typed differences.
 *
 * `ignoreAttrs` holds TRANSPORT annotations the shadow consumer stamps that the smee path
 * structurally cannot have (the cloud seq, and anything the operator declares via
 * --ignore-attr). Everything else is compared strictly: an unexpected consumer-added
 * attribute SHOULD surface as a difference rather than be quietly tolerated.
 */
export function compareEnvelope(live, shadow, { strictAttrs = false, ignoreAttrs = new Set() } = {}) {
  const diffs = [];
  for (const f of STABLE_ENVELOPE_FIELDS) {
    if (live?.[f] !== shadow?.[f]) {
      diffs.push({ field: f, live: live?.[f] ?? null, shadow: shadow?.[f] ?? null, class: "core" });
    }
  }
  const la = live?.attributes ?? {};
  const sa = shadow?.attributes ?? {};
  const keys = new Set([...Object.keys(la), ...Object.keys(sa)]);
  for (const k of keys) {
    if (ignoreAttrs.has(k)) continue;
    const lv = Object.hasOwn(la, k) ? la[k] : undefined;
    const sv = Object.hasOwn(sa, k) ? sa[k] : undefined;
    if (JSON.stringify(lv) === JSON.stringify(sv)) continue;
    const presenceOnly = lv === undefined || sv === undefined;
    const enrichment = ATTR_LOCAL_ENRICHMENT.has(k) && presenceOnly && !strictAttrs;
    diffs.push({
      field: `attributes.${k}`,
      live: lv === undefined ? null : lv,
      shadow: sv === undefined ? null : sv,
      class: enrichment ? "local-enrichment-presence" : "core",
    });
  }
  return diffs;
}

/**
 * Wire-order adjacency over a seq stream. NEVER sorts (rule 4).
 * `descents` = ordering violations; `gaps` = missing seqs. Two independent properties.
 * NOTE: `ts` inversions are EXPECTED (seq is commit order, ts is receipt order) and are
 * deliberately not checked here.
 */
export function checkSeqAdjacency(seqEntries) {
  const descents = [];
  const gaps = [];
  for (let i = 1; i < seqEntries.length; i++) {
    const prev = seqEntries[i - 1];
    const cur = seqEntries[i];
    if (cur.seq <= prev.seq) {
      descents.push({ prev: prev.seq, cur: cur.seq, prevLine: prev.lineNo, curLine: cur.lineNo });
      continue; // a descent already invalidates the adjacency; do not also call it a gap
    }
    if (cur.seq !== prev.seq + 1) {
      gaps.push({ after: prev.seq, before: cur.seq, missing: cur.seq - prev.seq - 1, curLine: cur.lineNo });
    }
  }
  return { descents, gaps };
}

/**
 * The file-order span of shadow envelopes that brackets the window.
 *
 * Seq adjacency MUST NOT be computed over the ts-filtered subset: seq is assigned in COMMIT
 * order while ts is receipt order, so ts filtering can exclude an interior seq and manufacture
 * a gap that does not exist. We take the contiguous file-order slice between the first and
 * last in-window envelopes instead.
 */
export function windowSpanSlice(all) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < all.length; i++) {
    if (!all[i].inWindow) continue;
    if (first === -1) first = i;
    last = i;
  }
  if (first === -1) return [];
  return all.slice(first, last + 1);
}

// ── the evaluation ──────────────────────────────────────────────────────────────────────

function check(id, status, title, detail, evidence) {
  return { id, status, title, detail, ...(evidence === undefined ? {} : { evidence }) };
}

function fmtEntry(e) {
  return {
    deliveryId: e.deliveryId ?? null,
    eventName: eventNameOf(e.obj),
    repo: repoOf(e.obj),
    ts: e.obj?.ts ?? null,
    source: e.source,
    file: e.file,
    line: e.lineNo,
  };
}

function capList(arr, cap) {
  return arr.length <= cap ? { items: arr, truncated: false, total: arr.length }
    : { items: arr.slice(0, cap), truncated: true, total: arr.length };
}

/**
 * Evaluate parity from two ingested sides. Pure: no IO, no clock dependence beyond the
 * generatedAt stamp the caller supplies.
 *
 * Returns a report whose `verdict` is one of "healthy" | "problem" | "cannot_evaluate".
 * Blockers (things that make the run non-evaluable) short-circuit EVERY assertion to
 * status "not_run" — a check that did not run is never reported as a pass.
 */
export function evaluate({ live, shadow, opts, generatedAt = new Date().toISOString() }) {
  const blockers = [];
  const waivers = [];
  const notAsserted = [];
  const checks = [];

  // ── evaluability gates ────────────────────────────────────────────────────────────────
  for (const side of [live, shadow]) {
    // A malformed line means the evidence is not trustworthy. A single torn FINAL line is the
    // classic concurrent-append artifact and can be waived explicitly, nothing else.
    const torn = side.malformed.filter((m) => opts.tolerateTornTail && m.lineNo === side.lastContentLineNo);
    const fatal = side.malformed.filter((m) => !torn.includes(m));
    if (torn.length > 0) {
      waivers.push(`${side.label}: ${torn.length} torn final line(s) waived by --tolerate-torn-tail`);
    }
    if (fatal.length > 0) {
      blockers.push({
        id: "MALFORMED_INPUT",
        detail: `${side.label}: ${fatal.length} unparseable line(s)`,
        evidence: capList(fatal, opts.maxList),
      });
    }
    if (side.control.length > 0) {
      blockers.push({
        id: "CONTROL_RECORD",
        detail: `${side.label}: ${side.control.length} control record(s) — the feed declared this scan INCOMPLETE. The prefix before a control record is internally contiguous, so contiguity would have passed a server-declared short read.`,
        evidence: capList(side.control, opts.maxList),
      });
    }
    if (side.badTs.length > 0) {
      blockers.push({
        id: "UNPARSEABLE_TS",
        detail: `${side.label}: ${side.badTs.length} envelope(s) with an unparseable ts — cannot be placed in the window`,
        evidence: capList(side.badTs, opts.maxList),
      });
    }
    if (side.missingDeliveryId.length > 0) {
      blockers.push({
        id: "MISSING_JOIN_KEY",
        detail: `${side.label}: ${side.missingDeliveryId.length} in-window webhook envelope(s) carry no attributes["webhook.delivery.id"]. The join would silently under-match. Most likely the window predates the CTL-1532 deploy — move --from after it.`,
        evidence: capList(side.missingDeliveryId, opts.maxList),
      });
    }
    // NOTE: input existence is checked by the CLI before ingestion (INPUT_MISSING). `evaluate`
    // is deliberately pure — no filesystem access — so the self-test and unit tests exercise
    // exactly the code path a real run takes.
    if (side.versions.size > 1) {
      const msg = `${side.label}: window spans ${side.versions.size} producer versions (${[...side.versions].join(", ")}) — a window that crosses a deploy/config change produces a confidently wrong number in whichever direction the change went`;
      if (opts.allowVersionSpan) waivers.push(`${msg} [waived by --allow-version-span]`);
      else blockers.push({ id: "DEPLOY_BOUNDARY", detail: msg, evidence: [...side.versions] });
    }
    if (side.hosts.size > 1) {
      blockers.push({
        id: "MIXED_HOSTS",
        detail: `${side.label}: envelopes from ${side.hosts.size} hosts (${[...side.hosts].join(", ")}) — parity is per-host; a mixed log compares two different producers`,
        evidence: [...side.hosts],
      });
    }
  }

  const liveSel = live.selected;
  const shadowSel = shadow.selected;

  // Shadow-log markers: the consumer's own declarations about its coverage.
  const markers = [...live.markers, ...shadow.markers].filter((m) => m.inWindow);
  const gapMarkers = markers.filter((m) => m.kind === "gap");
  const unknownMarkers = markers.filter((m) => m.kind === "unknown");
  const elidedMarkers = markers.filter((m) => m.kind === "elided");
  if (gapMarkers.length > 0) {
    blockers.push({
      id: "FEED_GAP_DECLARED",
      detail: `${gapMarkers.length} feed-gap marker(s) in the window — the CONSUMER declared its own coverage incomplete. Same class as a control record: the surviving records are internally consistent, so every assertion below would have passed on a window that is known to be missing data.`,
      evidence: capList(gapMarkers.map((m) => ({ name: m.name, ts: m.raw?.ts ?? null, line: m.lineNo, file: m.file })), opts.maxList),
    });
  }
  // An elision marker is a self-declaration by the component under test that
  // SUPPRESSES a MISSING_FROM_SHADOW row and DISCOUNTS a per-type deficit. It may only
  // do that if it corroborates itself against the documented elision shape: an
  // attributable delivery id, reason "payloadOmitted", and a payload actually over the
  // 96KB edge cap. Anything else (a consumer bug reusing the elision path, a cloud
  // regression stamping payloadOmitted on records it failed to store) would convert
  // arbitrary data loss into a green run, so it is NOT EVALUABLE.
  const corroboratedElisions = elidedMarkers.filter(
    (m) =>
      m.deliveryId !== null &&
      m.raw?.reason === "payloadOmitted" &&
      typeof m.raw?.payloadBytes === "number" &&
      Number.isFinite(m.raw.payloadBytes) &&
      m.raw.payloadBytes >= PAYLOAD_CAP_BYTES,
  );
  const uncorroboratedElisions = elidedMarkers.filter((m) => !corroboratedElisions.includes(m));
  if (uncorroboratedElisions.length > 0) {
    blockers.push({
      id: "UNCORROBORATED_ELISION",
      detail: `${uncorroboratedElisions.length} elision marker(s) do not corroborate themselves (required: a webhook.delivery.id, reason "payloadOmitted", and a numeric payloadBytes >= ${PAYLOAD_CAP_BYTES} — the documented cloud edge cap). An elision marker suppresses a loss row and discounts a type deficit, so an unverified one lets the component under test excuse its own data loss.`,
      evidence: capList(uncorroboratedElisions.map((m) => ({ deliveryId: m.deliveryId, reason: m.raw?.reason ?? null, payloadBytes: m.raw?.payloadBytes ?? null, line: m.lineNo, file: m.file })), opts.maxList),
    });
  }
  if (unknownMarkers.length > 0) {
    blockers.push({
      id: "UNKNOWN_SHADOW_MARKER",
      detail: `${unknownMarkers.length} marker(s) matching --marker-prefix that this harness does not recognise (${[...new Set(unknownMarkers.map((m) => m.name))].join(", ")}). A marker is a declaration the consumer made about its coverage; an unrecognised one must not be read as silence. Teach the harness (MARKER_KINDS) or re-point --marker-prefix.`,
      evidence: capList(unknownMarkers.map((m) => ({ name: m.name, line: m.lineNo, file: m.file })), opts.maxList),
    });
  }

  // Overlap gate: a window in which one side simply was not writing yet (or had stopped) is
  // not a parity measurement — every non-overlapping delivery would read as a loss.
  let overlapNote = null;
  if (liveSel.length > 0 && shadowSel.length > 0) {
    // MUST be min/max over ts, never first/last in file order: the shadow log is appended in
    // cloud COMMIT order (seq), which is deliberately not receivedAt order, so its ts column
    // is non-monotone by design. Reading position 0 as "earliest" is how a correct-looking
    // gate produces a wrong answer on real data.
    const { min: firstLive, max: lastLive } = tsBounds(liveSel);
    const { min: firstShadow, max: lastShadow } = tsBounds(shadowSel);
    const startSkew = Math.abs(firstShadow - firstLive);
    const endSkew = Math.abs(lastShadow - lastLive);
    if (startSkew > opts.edgeMarginMs || endSkew > opts.edgeMarginMs) {
      const suggestFrom = new Date(Math.max(firstLive, firstShadow)).toISOString();
      const suggestTo = new Date(Math.min(lastLive, lastShadow)).toISOString();
      const msg = `sides do not cover the same interval (start skew ${Math.round(startSkew / 1000)}s, end skew ${Math.round(endSkew / 1000)}s). Either the window is wrong or one side had an outage — both look identical from here. Overlap is --from ${suggestFrom} --to ${suggestTo}`;
      if (opts.allowPartialOverlap) { overlapNote = msg; waivers.push(`${msg} [waived by --allow-partial-overlap]`); }
      else blockers.push({ id: "WINDOW_OVERLAP", detail: msg, evidence: { firstLive: new Date(firstLive).toISOString(), lastLive: new Date(lastLive).toISOString(), firstShadow: new Date(firstShadow).toISOString(), lastShadow: new Date(lastShadow).toISOString() } });
    }
  }

  // Seq availability gate. This runs UNCONDITIONALLY — it is a PRODUCER CONTRACT
  // check, not an operator preference. The consumer stamps `catalyst.cloud.event.seq`
  // on every envelope; if a whole window carries none, the producer and this harness
  // no longer agree on a field name and the ordering/coverage subsystem is reading
  // an attribute nobody writes. --no-seq-checks waives the ASSERTIONS (a deliberate
  // "I am not measuring ordering today"); it can never waive "the evidence this tool
  // reads does not exist", because that renders three checks structurally
  // unreachable while the run still prints green.
  const shadowSpan = windowSpanSlice(shadow.all);
  const seqEntries = [];
  let seqAbsent = 0;
  const seqInvalid = [];
  for (const e of shadowSpan) {
    const s = seqOf(e.obj, opts.seqAttr);
    if (s.ok === null) { seqAbsent++; continue; }
    if (s.ok === false) { seqInvalid.push({ line: e.lineNo, raw: s.raw }); continue; }
    seqEntries.push({ seq: s.seq, lineNo: e.lineNo });
  }
  if (shadowSpan.length > 0 && seqEntries.length === 0) {
    const hint = [...new Set(shadowSpan.flatMap((e) => Object.keys(e.obj?.attributes ?? {})).filter((k) => /(^|\.)seq$/.test(k)))];
    blockers.push({
      id: "SEQ_ATTR_ABSENT",
      detail: `shadow envelopes carry no ${JSON.stringify(opts.seqAttr)} attribute, so feed ordering cannot be evaluated.${hint.length ? ` Candidate keys present: ${hint.join(", ")} (pass --seq-attr).` : ""} This is a PRODUCER CONTRACT break (cloud-event-consumer.mjs stamps SEQ_ATTR on every envelope) and --no-seq-checks does NOT waive it: waiving would turn SEQ_WIRE_ORDER/SEQ_CONTIGUITY/SEQ_COVERAGE into three questions that can never be asked, under a green verdict. Fix the producer or re-point --seq-attr.`,
      evidence: { seqAttr: opts.seqAttr, envelopesInSpan: shadowSpan.length, candidates: hint, waivableByNoSeqChecks: false },
    });
  } else if (seqAbsent > 0 && seqEntries.length > 0) {
    blockers.push({
      id: "SEQ_ATTR_PARTIAL",
      detail: `shadow: ${seqAbsent} of ${shadowSpan.length} envelopes in the window span carry no ${opts.seqAttr} — a partially-stamped log cannot be ordered`,
      evidence: { absent: seqAbsent, present: seqEntries.length },
    });
  }
  if (seqInvalid.length > 0) {
    blockers.push({ id: "SEQ_ATTR_INVALID", detail: `shadow: ${seqInvalid.length} non-integer ${opts.seqAttr} value(s)`, evidence: capList(seqInvalid, opts.maxList) });
  }
  if (!opts.seqChecks) {
    waivers.push("seq integrity checks WAIVED by --no-seq-checks (feed ordering NOT evaluated here)");
    notAsserted.push({ id: "SEQ_WIRE_ORDER", reason: "--no-seq-checks" });
    notAsserted.push({ id: "SEQ_CONTIGUITY", reason: "--no-seq-checks" });
    notAsserted.push({ id: "SEQ_COVERAGE", reason: "--no-seq-checks" });
  }

  // --require-coverage means "exit 2 unless coverage was actually ASSERTED". It used
  // to guard only ONE of the three ways coverage ends up unasserted, so the operator
  // could supply the cursor and the head, describe a short read, and still be told
  // HEALTHY because the answer had quietly been demoted to `notAsserted` (which does
  // not touch the verdict).
  if (opts.requireCoverage) {
    const missing = [];
    if (opts.expectFirstSeq === null) missing.push("--expect-first-seq");
    if (opts.expectHeadSeq === null) missing.push("--expect-head-seq");
    if (!opts.seqLedgerComplete) missing.push("--seq-ledger-complete (SEQ_COVERAGE is gated behind it)");
    if (!opts.seqChecks) missing.push("seq checks are waived by --no-seq-checks");
    if (missing.length > 0) {
      blockers.push({
        id: "COVERAGE_REQUIRED",
        detail: `--require-coverage was passed but coverage cannot be asserted: missing ${missing.join(", ")}. A demoted-to-not-asserted coverage question is NOT a coverage pass.`,
        evidence: { missing },
      });
    }
  }

  // Window gates. The edge margin exists to forgive one-sided deliveries near a
  // boundary — but a margin anchored to the DATA BEING JUDGED, or one wider than
  // half the window, silently excludes every candidate from BOTH loss detectors,
  // which then pass having examined nothing.
  if (opts.edgeMarginMs > 0 && (opts.fromMs === null || opts.toMs === null)) {
    blockers.push({
      id: "UNBOUNDED_WINDOW",
      detail: `--edge-margin is ${opts.edgeMarginMs / 1000}s but the window is unbounded (${opts.fromMs === null ? "--from" : "--to"} missing). Deriving the boundary from the data under test makes the earliest and latest deliveries permanently un-checkable, and for any burst shorter than 2× the margin it excludes EVERY delivery from MISSING_FROM_SHADOW and SHADOW_ONLY. Pass --from/--to, or --edge-margin 0.`,
      evidence: { from: opts.fromIso, to: opts.toIso, edgeMarginSeconds: opts.edgeMarginMs / 1000 },
    });
  }
  if (opts.edgeMarginMs > 0 && opts.fromMs !== null && opts.toMs !== null && 2 * opts.edgeMarginMs >= opts.toMs - opts.fromMs) {
    blockers.push({
      id: "EDGE_MARGIN_SWALLOWS_WINDOW",
      detail: `the edge margin (2 × ${opts.edgeMarginMs / 1000}s) covers the whole window (${Math.round((opts.toMs - opts.fromMs) / 1000)}s), so every delivery would be edge-excluded and both loss detectors would pass having examined ZERO deliveries. Widen the window or lower --edge-margin.`,
      evidence: { windowSeconds: (opts.toMs - opts.fromMs) / 1000, edgeMarginSeconds: opts.edgeMarginMs / 1000 },
    });
  }

  // Rule 10: a source scoped out by --sources is an UNANSWERED question, not an
  // absent one. Without this the report simply has no row for it.
  for (const s of ["github", "linear"]) {
    if (!opts.sources.includes(s)) {
      notAsserted.push({ id: `MATCHED_NONZERO_${s}`, reason: `excluded by --sources ${opts.sources.join(",")} — the ${s} half of the cutover was NOT measured by this run` });
    }
  }

  const scanned = {
    live: sideStats(live),
    shadow: sideStats(shadow),
  };
  const markerSummary = markers.map((m) => ({ name: m.name, kind: m.kind, deliveryId: m.deliveryId, ts: m.raw?.ts ?? null, file: m.file, line: m.lineNo }));

  if (blockers.length > 0) {
    // Every assertion is reported as not_run. This is the single most important branch in the
    // file: a run that could not evaluate never emits a pass, and never exits 0.
    for (const id of [
      ...opts.sources.map((s) => `MATCHED_NONZERO_${s}`),
      "ELIDED_PAYLOADS", "MISSING_FROM_SHADOW", "KNOWN_GAP_LOSSES", "SHADOW_ONLY", "DUPLICATE_DELIVERY_SHADOW",
      "TYPE_COUNTS", "LIVE_DEFICIT_TYPES", "ENVELOPE_EQUIVALENCE", "SEQ_WIRE_ORDER",
    ]) {
      checks.push(check(id, "not_run", id, "not evaluated — the run is not evaluable (see blockers)"));
    }
    return finalize({ generatedAt, opts, scanned, checks, blockers, waivers, notAsserted, typeRows: [], join: null, overlapNote, markers: markerSummary });
  }

  // ── assertions ────────────────────────────────────────────────────────────────────────
  const liveIdx = indexByDelivery(liveSel);
  const shadowIdx = indexByDelivery(shadowSel);
  const { matched, liveOnly, shadowOnly } = joinDeliveries(liveIdx.byId, shadowIdx.byId);

  // Rule 5: NON-ZERO matched pairs PER SOURCE. A zero-match join is indistinguishable from
  // perfect parity if you only count mismatches.
  const matchedBySource = countBySource(matched.map((m) => m.live));
  for (const s of opts.sources) {
    const n = matchedBySource[s] ?? 0;
    checks.push(
      n > 0
        ? check(`MATCHED_NONZERO_${s}`, "pass", `matched pairs (${s})`, `${n} matched pair(s)`)
        : check(`MATCHED_NONZERO_${s}`, "fail", `matched pairs (${s})`,
            `ZERO matched pairs for ${s}. This is NOT parity — the join matched nothing. Check the consumer is running, the window covers real traffic, and both sides stamp webhook.delivery.id. For a quiet source, inject a synthetic event rather than reading zero as agreement.`,
            { live: countBySource(liveSel)[s] ?? 0, shadow: countBySource(shadowSel)[s] ?? 0 })
    );
  }

  // Edge classification: deliveries within the edge margin of a window boundary can legitimately
  // land on one side only (the cloud runs ~12s ahead of smee). Counted and printed, never dropped.
  //
  // The bounds come ONLY from --from/--to. Deriving them from the data under test made the
  // margin a function of the very evidence being judged (and the two gates above guarantee a
  // non-zero margin has an explicit, wide-enough window). Unbounded + margin 0 => nothing is edge.
  const effFrom = opts.fromMs ?? -Infinity;
  const effTo = opts.toMs ?? Infinity;
  const isEdge = (e) =>
    opts.edgeMarginMs > 0 && (e.ts - effFrom < opts.edgeMarginMs || effTo - e.ts < opts.edgeMarginMs);

  const liveOnlyEdge = liveOnly.filter(isEdge);
  const liveOnlyInterior = liveOnly.filter((e) => !isEdge(e));
  // A live-only delivery the consumer EXPLICITLY marked as elided (>96KB payloadOmitted) is an
  // attributed gap, not a mystery — but only the CORROBORATED markers may attribute (see the
  // UNCORROBORATED_ELISION gate above, which blocks the run outright).
  const elidedIds = new Set(
    corroboratedElisions.map((m) => m.deliveryId).filter((id) => id !== null),
  );
  const elidedLoss = liveOnlyInterior.filter((e) => elidedIds.has(e.deliveryId));
  const knownGapDeficit = liveOnlyInterior.filter((e) => !elidedIds.has(e.deliveryId) && censusExpectationFor(eventNameOf(e.obj)).expectation === "known-gap");
  const unexplainedLoss = liveOnlyInterior.filter((e) => !elidedLoss.includes(e) && !knownGapDeficit.includes(e));

  // Always emitted, including at zero: the >96KB elision path has NEVER executed in production
  // (0 of 1766 events at last count), so its first firing is something to LOOK AT — and an
  // omitted row is indistinguishable from nobody looking.
  checks.push(
    elidedMarkers.length === 0
      ? check("ELIDED_PAYLOADS", "pass", "payloadOmitted (>96KB) elision markers", "0 elision markers in window (this path has never fired in production — a first firing is expected-zero until it is not)")
      // `warn` is NON-GREEN (see finalize): an elided delivery genuinely never reached
      // the shadow log and the consumer itself grades it EXIT_PROBLEM. The two halves of
      // this deliverable must not give opposite verdicts on the same event.
      : check("ELIDED_PAYLOADS", "warn", "payloadOmitted (>96KB) elision markers",
          `${elidedMarkers.length} elided delivery/deliveries — unmappable by construction, so each needs a SCOPED RECONCILE. ${elidedLoss.length} of them explain a live-only row here.`,
          capList(elidedMarkers.map((m) => ({ deliveryId: m.deliveryId, source: m.raw?.source ?? null, eventType: m.raw?.eventType ?? null, payloadBytes: m.raw?.payloadBytes ?? null, identity: m.raw?.identity ?? null, line: m.lineNo })), opts.maxList))
  );

  // A detector that examined ZERO candidates because every one of them was edge-excluded
  // did not run. Reporting that as `pass` is the "omitted row is indistinguishable from
  // nobody looking" defect with a green tick on top.
  const allLiveOnlyEdgeExcluded = liveOnly.length > 0 && liveOnlyInterior.length === 0;
  checks.push(
    allLiveOnlyEdgeExcluded
      ? check("MISSING_FROM_SHADOW", "not_run", "deliveries present in live, absent from shadow",
          `NOT RUN — all ${liveOnly.length} live-only delivery/deliveries were edge-excluded by --edge-margin ${opts.edgeMarginMs / 1000}s, so this detector examined ZERO candidates. A waived candidate is not evidence of parity: re-run with --edge-margin 0, or move --from/--to so they are interior.`,
          { edgeExcluded: capList(liveOnly.map(fmtEntry), opts.maxList) })
      : unexplainedLoss.length === 0
      ? check("MISSING_FROM_SHADOW", "pass", "deliveries present in live, absent from shadow",
          `0 interior unexplained (edge-excluded ${liveOnlyEdge.length}, known-gap ${knownGapDeficit.length}, elided ${elidedLoss.length})`)
      : check("MISSING_FROM_SHADOW", "fail", "deliveries present in live, absent from shadow",
          `${unexplainedLoss.length} interior live delivery/deliveries never reached the shadow log`,
          { deliveries: capList(unexplainedLoss.map(fmtEntry), opts.maxList), byRepo: tally(unexplainedLoss, (e) => repoOf(e.obj)), byType: tally(unexplainedLoss, (e) => eventNameOf(e.obj)) })
  );
  // The not_run row above is ALL-OR-NOTHING: it only fires when EVERY candidate was
  // edge-excluded. A PARTIAL exclusion — 9 waived, 1 examined — printed a bare `pass`,
  // which is indistinguishable from having examined all 10 (rule 10). The excluded ones
  // are an unanswered question and are enumerated as one, exactly like a `--sources`
  // exclusion; `--edge-margin 0` is what answers them.
  if (!allLiveOnlyEdgeExcluded && liveOnlyEdge.length > 0) {
    notAsserted.push({
      id: "MISSING_FROM_SHADOW_EDGE_EXCLUDED",
      reason: `${liveOnlyEdge.length} of ${liveOnly.length} live-only delivery/deliveries sat within --edge-margin ${opts.edgeMarginMs / 1000}s of a window boundary and were NOT examined. The detector answered only for the ${liveOnlyInterior.length} interior candidate(s) — a partial exclusion is not a full answer. Re-run with --edge-margin 0, or move --from/--to so they are interior.`,
    });
  }

  // Emitted at zero too: a filed gap that stopped appearing is a result worth seeing, and an
  // omitted row is indistinguishable from nobody looking.
  checks.push(
    knownGapDeficit.length === 0
      ? check("KNOWN_GAP_LOSSES", "pass", "live-only deliveries attributable to a FILED cloud-side gap",
          `0 in window (censused known gaps: ${DEFAULT_TYPE_CENSUS.filter((c) => c.expectation === "known-gap").map((c) => `${c.prefix}* [${c.ticket}]`).join(", ") || "none"})`)
      // `info` by default, NOT `warn`. Every delivery counted here matched a census row
      // that already names an open ticket, so `warn` (non-green, exit 1) made the harness
      // permanently red for as long as that ticket stays open — which manufactures exactly
      // the pressure to stop reading the verdict that this tool exists to resist. The
      // distinction the exit code must preserve is NEW/uninvestigated vs KNOWN/filed: a
      // loss that is NOT censused is already counted as unexplained by MISSING_FROM_SHADOW
      // and FAILS there. This row keeps the tracked ones visible, with their ticket, every
      // run; --strict-known-gaps escalates it to a hard fail for the phase-5 close-out.
      : check("KNOWN_GAP_LOSSES", opts.strictKnownGaps ? "fail" : "info",
          "live-only deliveries attributable to a FILED cloud-side gap",
          `${knownGapDeficit.length} delivery/deliveries match a known-gap census row (e.g. linear.reaction.* / CTC-297) — TRACKED and still monitored, not new. Uncensused losses are NOT counted here; they fail MISSING_FROM_SHADOW. Pass --strict-known-gaps to make a filed gap block (required before phase 5).`,
          { deliveries: capList(knownGapDeficit.map(fmtEntry), opts.maxList), byType: tally(knownGapDeficit, (e) => eventNameOf(e.obj)), tickets: [...new Set(knownGapDeficit.map((e) => censusExpectationFor(eventNameOf(e.obj)).ticket ?? "(untagged)"))] })
  );

  // Shadow-only is the EXPECTED direction (the cloud is a superset: more types, more repos).
  // Split it so a superset claim is never used to hide a smee-side drop of a type smee carries
  // — and split it by the CENSUS, never by presence. A presence-based split
  // (`liveTypeCounts.has(name)`) fails exactly when the live-side drop is TOTAL: with zero live
  // rows of that type there is no key, so every shadow-only delivery of a type the census says
  // BOTH sides carry was auto-labelled "expected cloud superset".
  const liveTypeCounts = perTypeCounts(liveSel);
  const shadowOnlyEdge = shadowOnly.filter(isEdge);
  const shadowOnlyInterior = shadowOnly.filter((e) => !isEdge(e));
  const isSupersetType = (e) => censusExpectationFor(eventNameOf(e.obj)).expectation === "cloud-only";
  const shadowOnlySuperset = shadowOnlyInterior.filter(isSupersetType);
  const shadowOnlyOverlapping = shadowOnlyInterior.filter((e) => !isSupersetType(e));
  const allShadowOnlyEdgeExcluded = shadowOnly.length > 0 && shadowOnlyInterior.length === 0;
  checks.push(
    allShadowOnlyEdgeExcluded
      ? check("SHADOW_ONLY", "not_run", "deliveries present in shadow, absent from live",
          `NOT RUN — all ${shadowOnly.length} shadow-only delivery/deliveries were edge-excluded by --edge-margin ${opts.edgeMarginMs / 1000}s, so this detector examined ZERO candidates. Re-run with --edge-margin 0, or move --from/--to so they are interior.`,
          { edgeExcluded: capList(shadowOnly.map(fmtEntry), opts.maxList) })
      : shadowOnlyOverlapping.length === 0
      ? check("SHADOW_ONLY", "pass", "deliveries present in shadow, absent from live",
          `${shadowOnlySuperset.length} expected-superset (census: cloud-only), 0 non-superset (edge-excluded ${shadowOnlyEdge.length})`,
          { supersetByType: tally(shadowOnlySuperset, (e) => eventNameOf(e.obj)) })
      : check("SHADOW_ONLY", opts.strictShadowOnly ? "fail" : "warn",
          "deliveries present in shadow, absent from live",
          `${shadowOnlyOverlapping.length} shadow-only delivery/deliveries of a type the LIVE side also carries — that is a smee-side drop (the 14h32m GitHub tunnel outage had exactly this shape), not the cloud superset. ${shadowOnlySuperset.length} further shadow-only deliveries are expected superset.`,
          { overlapping: capList(shadowOnlyOverlapping.map(fmtEntry), opts.maxList), byType: tally(shadowOnlyOverlapping, (e) => eventNameOf(e.obj)), supersetByType: tally(shadowOnlySuperset, (e) => eventNameOf(e.obj)) })
  );
  if (!allShadowOnlyEdgeExcluded && shadowOnlyEdge.length > 0) {
    notAsserted.push({
      id: "SHADOW_ONLY_EDGE_EXCLUDED",
      reason: `${shadowOnlyEdge.length} of ${shadowOnly.length} shadow-only delivery/deliveries sat within --edge-margin ${opts.edgeMarginMs / 1000}s of a window boundary and were NOT examined. The detector answered only for the ${shadowOnlyInterior.length} interior candidate(s). Re-run with --edge-margin 0, or move --from/--to so they are interior.`,
    });
  }

  // Invariant 6: the consumer dedups on delivery_id. A duplicate on the shadow side is a
  // dedup failure. A duplicate on the live side is a provider redelivery — reported, not failed.
  checks.push(
    shadowIdx.duplicates.length === 0
      ? check("DUPLICATE_DELIVERY_SHADOW", "pass", "shadow dedup on delivery id", "0 duplicates")
      : check("DUPLICATE_DELIVERY_SHADOW", "fail", "shadow dedup on delivery id",
          `${shadowIdx.duplicates.length} delivery id(s) appear more than once in the shadow log — the consumer's dedup (invariant 6) is not holding`,
          capList(shadowIdx.duplicates, opts.maxList))
  );
  if (liveIdx.duplicates.length > 0) {
    // `info`, not `warn`: a provider redelivery is genuinely benign and this is the one
    // observation that must not move the verdict (every `warn` below is a real loss).
    checks.push(check("DUPLICATE_DELIVERY_LIVE", "info", "live-side duplicate delivery ids",
      `${liveIdx.duplicates.length} duplicate(s) in the live log (provider redelivery or a monitor restart clearing the in-process dedup set). The FIRST occurrence was used for the join.`,
      capList(liveIdx.duplicates, opts.maxList)));
  }

  // Rule 9: per-type COUNTS on both sides — the Gate B superset input.
  const shadowTypeCounts = perTypeCounts(shadowSel);
  const elidedByType = new Map(Object.entries(tally(elidedLoss, (e) => eventNameOf(e.obj))));
  const typeRows = compareTypeCounts(liveTypeCounts, shadowTypeCounts, DEFAULT_TYPE_CENSUS, elidedByType);
  const deficits = typeRows.filter((r) => r.verdict === "shadow-deficit");
  checks.push(
    deficits.length === 0
      ? check("TYPE_COUNTS", "pass", "per-type counts (Gate B input)",
          `no shadow deficit across ${typeRows.length} censused/observed type row(s)`)
      : check("TYPE_COUNTS", "fail", "per-type counts (Gate B input)",
          `${deficits.length} type(s) where the live count exceeds the shadow count`, deficits)
  );

  // The OTHER direction, classified against the census rather than by presence. A censused
  // `both` type the LIVE side lost 100% of used to read as "cloud-superset" and pass — the
  // exact shape of the 14h32m smee GitHub outage.
  const liveTotalLoss = typeRows.filter((r) => r.verdict === "live-total-loss");
  const liveDeficits = typeRows.filter((r) => r.verdict === "live-deficit");
  checks.push(
    liveTotalLoss.length === 0 && liveDeficits.length === 0
      ? check("LIVE_DEFICIT_TYPES", "pass", "per-type counts, live side (smee-drop detector)",
          "no censused type where the shadow count exceeds the live count")
      : liveTotalLoss.length > 0
        ? check("LIVE_DEFICIT_TYPES", "fail", "per-type counts, live side (smee-drop detector)",
            `${liveTotalLoss.length} censused type(s) the LIVE side carries ZERO of while the shadow side carries some — a total live-side loss, not the cloud superset`,
            [...liveTotalLoss, ...liveDeficits])
        : check("LIVE_DEFICIT_TYPES", opts.strictShadowOnly ? "fail" : "warn", "per-type counts, live side (smee-drop detector)",
            `${liveDeficits.length} censused type(s) where the shadow count exceeds the live count`,
            liveDeficits)
  );

  // Envelope equivalence on matched pairs.
  const pairDiffs = [];
  let enrichmentOnlyPairs = 0;
  // Declared exclusions: the configured seq attribute is a TRANSPORT annotation the smee side
  // structurally cannot carry, plus anything the operator declared via --ignore-attr. Both are
  // printed in the report's `policy` block — an undeclared exclusion is a hidden pass.
  const ignoreAttrs = new Set([opts.seqAttr, ...opts.ignoreAttrs]);
  for (const m of matched) {
    const diffs = compareEnvelope(m.live.obj, m.shadow.obj, { strictAttrs: opts.strictAttrs, ignoreAttrs });
    if (diffs.length === 0) continue;
    const core = diffs.filter((d) => d.class === "core");
    if (core.length === 0) { enrichmentOnlyPairs++; continue; }
    pairDiffs.push({ deliveryId: m.id, source: m.live.source, liveEvent: eventNameOf(m.live.obj), shadowEvent: eventNameOf(m.shadow.obj), diffs: core, liveLine: m.live.lineNo, shadowLine: m.shadow.lineNo });
  }
  checks.push(
    pairDiffs.length === 0
      ? check("ENVELOPE_EQUIVALENCE", "pass", "envelope equivalence on matched pairs",
          `${matched.length} pair(s) equivalent (${enrichmentOnlyPairs} differ only in locally-enriched attributes: ${[...ATTR_LOCAL_ENRICHMENT].join(", ")})`)
      : check("ENVELOPE_EQUIVALENCE", "fail", "envelope equivalence on matched pairs",
          `${pairDiffs.length} of ${matched.length} matched pair(s) disagree on event.name or a key attribute`,
          capList(pairDiffs, opts.maxList))
  );

  // Feed ordering (integrity) — separate from coverage, always.
  if (opts.seqChecks && seqEntries.length === 0) {
    // ZERO seq evidence (an empty window span). "no descent across 0 seqs" and "no gaps
    // across 0 seqs" are three green rows asserting nothing — and --json is advertised as
    // machine-readable, so a dashboard tile keyed on checks[].status reads them as answers.
    for (const id of ["SEQ_WIRE_ORDER", "SEQ_CONTIGUITY", "SEQ_COVERAGE"]) {
      notAsserted.push({ id, reason: "no seq evidence in the window span — zero shadow envelopes to order. A zero-evidence check is not a pass." });
    }
  } else if (opts.seqChecks) {
    const { descents, gaps } = checkSeqAdjacency(seqEntries);
    checks.push(
      descents.length === 0
        ? check("SEQ_WIRE_ORDER", "pass", "shadow seq strictly ascending in WIRE ORDER",
            `${seqEntries.length} seq(s), unsorted, no descent (ts inversions are expected and not checked — seq is commit order)`)
        : check("SEQ_WIRE_ORDER", "fail", "shadow seq strictly ascending in WIRE ORDER",
            `${descents.length} ordering violation(s) in file order`, capList(descents, opts.maxList))
    );
    if (opts.seqLedgerComplete) {
      checks.push(
        gaps.length === 0
          ? check("SEQ_CONTIGUITY", "pass", "shadow seq contiguity (ledger-complete mode)", `no gaps across ${seqEntries.length} seq(s)`)
          : check("SEQ_CONTIGUITY", "fail", "shadow seq contiguity (ledger-complete mode)",
              `${gaps.length} gap(s) — ${gaps.reduce((a, g) => a + g.missing, 0)} missing seq(s)`, capList(gaps, opts.maxList))
      );
    } else {
      notAsserted.push({
        id: "SEQ_CONTIGUITY",
        reason: "the shadow log only contains MAPPED events; the consumer drops provider types webhook-events.ts has no mapper for (workflow_job, check_run, Attachment), so seq gaps are expected and a contiguity assertion here would be meaningless. Pass --seq-ledger-complete only if the consumer records EVERY feed seq.",
      });
    }
    // COVERAGE != INTEGRITY (defect 6). Only assertable against a complete seq ledger; a
    // "weak" coverage check (first >= since+1, last <= head) passes for a short read, which is
    // precisely the false green this rule exists to prevent — so it is not offered.
    if (opts.expectFirstSeq !== null || opts.expectHeadSeq !== null) {
      if (!opts.seqLedgerComplete) {
        notAsserted.push({ id: "SEQ_COVERAGE", reason: "--expect-first-seq/--expect-head-seq supplied without --seq-ledger-complete. A mapped log legitimately omits seqs, so first==since+1 / last==head cannot be asserted; the weak form would pass for a short read." });
      } else {
        const first = seqEntries.length > 0 ? seqEntries[0].seq : null;
        const last = seqEntries.length > 0 ? seqEntries[seqEntries.length - 1].seq : null;
        const problems = [];
        if (opts.expectFirstSeq !== null) {
          if (first === null && opts.expectFirstSeq <= (opts.expectHeadSeq ?? Infinity)) problems.push(`empty replay but first seq was expected at ${opts.expectFirstSeq}`);
          else if (first !== null && first !== opts.expectFirstSeq) problems.push(`first seq ${first} != expected ${opts.expectFirstSeq} (replay starts after the cursor — internally contiguous, invisible to a gap check)`);
        }
        // `last === null` is the EMPTY replay. Guarding the head comparison on it meant
        // "empty while the head is ahead" — one of the three short-read shapes this check
        // exists for — silently printed `pass  first=null last=null`.
        if (opts.expectHeadSeq !== null && last === null) {
          problems.push(`empty replay while the head was expected at ${opts.expectHeadSeq} — zero seqs is not coverage`);
        } else if (opts.expectHeadSeq !== null && last !== opts.expectHeadSeq) {
          problems.push(`last seq ${last} != head ${opts.expectHeadSeq} (SHORT READ — internally contiguous, no control record, invisible to a gap check)`);
        }
        checks.push(
          problems.length === 0
            ? check("SEQ_COVERAGE", "pass", "coverage: the replay spans what was asked for", `first=${first} last=${last}`)
            : check("SEQ_COVERAGE", "fail", "coverage: the replay spans what was asked for", problems.join("; "), { first, last, expectFirstSeq: opts.expectFirstSeq, expectHeadSeq: opts.expectHeadSeq })
        );
      }
    } else {
      notAsserted.push({ id: "SEQ_COVERAGE", reason: "no --expect-first-seq/--expect-head-seq supplied. Integrity does NOT imply coverage: a replay that starts after the cursor or stops before the head is internally contiguous with no control record. Feed coverage is owned by catalyst-cloud feed-health.mjs — consume its exit code." });
    }
  }

  const join = {
    matched: matched.length,
    matchedBySource,
    liveOnly: { total: liveOnly.length, interior: liveOnlyInterior.length, edge: liveOnlyEdge.length, knownGap: knownGapDeficit.length, elided: elidedLoss.length, unexplained: unexplainedLoss.length, deliveries: capList(liveOnly.map(fmtEntry), opts.maxList) },
    shadowOnly: { total: shadowOnly.length, interior: shadowOnlyInterior.length, edge: shadowOnlyEdge.length, superset: shadowOnlySuperset.length, overlapping: shadowOnlyOverlapping.length, deliveries: capList(shadowOnly.map(fmtEntry), opts.maxList) },
    envelopeDiffs: capList(pairDiffs, opts.maxList),
    enrichmentOnlyPairs,
  };

  return finalize({ generatedAt, opts, scanned, checks, blockers, waivers, notAsserted, typeRows, join, overlapNote, markers: markerSummary });
}

/** min/max ts over entries. Never assumes file order == time order (see the overlap gate). */
export function tsBounds(entries) {
  let min = Infinity;
  let max = -Infinity;
  for (const e of entries) {
    if (e.ts === null) continue;
    if (e.ts < min) min = e.ts;
    if (e.ts > max) max = e.ts;
  }
  return { min, max };
}

function tally(entries, keyFn) {
  const m = {};
  for (const e of entries) {
    const k = keyFn(e);
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
}

function sideStats(side) {
  return {
    files: side.files,
    lines: side.lines, blank: side.blank, nonWebhook: side.nonWebhook,
    webhookEnvelopes: side.webhookTotal, outOfWindow: side.outOfWindow,
    repoFiltered: side.repoFiltered, sourceFiltered: side.sourceFiltered,
    compared: side.selected.length,
    bySource: countBySource(side.selected),
    malformed: side.malformed.length, control: side.control.length,
    badTs: side.badTs.length, missingDeliveryId: side.missingDeliveryId.length,
    markers: { total: side.markers.length, inWindow: side.markers.filter((m) => m.inWindow).length, byKind: side.markers.filter((m) => m.inWindow).reduce((a, m) => { a[m.kind] = (a[m.kind] ?? 0) + 1; return a; }, {}) },
    producerVersions: [...side.versions], hosts: [...side.hosts],
  };
}

function finalize({ generatedAt, opts, scanned, checks, blockers, waivers, notAsserted, typeRows, join, overlapNote, markers = [] }) {
  const counts = {
    pass: checks.filter((c) => c.status === "pass").length,
    fail: checks.filter((c) => c.status === "fail").length,
    warn: checks.filter((c) => c.status === "warn").length,
    info: checks.filter((c) => c.status === "info").length,
    notRun: checks.filter((c) => c.status === "not_run").length,
    notAsserted: notAsserted.length,
  };
  // Precedence: cannot_evaluate > problem > healthy. Nothing red is ever green.
  //
  //  · blockers OR a not_run check => cannot_evaluate. A check that did not run is an
  //    unanswered question, and an unanswered question is exit 2, never exit 0.
  //  · fail OR warn => problem. `warn` used to be invisible to the exit code, so a
  //    detected, described, printed loss (a 95% smee-side drop; every >96KB payload
  //    dropped; a filed cloud gap) still exited 0 — the exact "evaluated-problem
  //    rendered as evaluated-healthy" collapse this contract forbids. `info` is the
  //    only non-verdict status and is reserved for genuinely benign observations.
  const verdict =
    blockers.length > 0 || counts.notRun > 0
      ? "cannot_evaluate"
      : counts.fail > 0 || counts.warn > 0
        ? "problem"
        : "healthy";
  const exitCode = verdict === "cannot_evaluate" ? EXIT_CANNOT_EVALUATE : verdict === "problem" ? EXIT_PROBLEM : EXIT_HEALTHY;
  return {
    harness: "parity-harness", schemaVersion: 1, ticket: "CTL-1534", generatedAt,
    window: { from: opts.fromIso, to: opts.toIso, edgeMarginSeconds: opts.edgeMarginMs / 1000, sources: opts.sources, repos: opts.repos },
    policy: {
      joinKey: 'attributes["webhook.delivery.id"]',
      uncomparedEnvelopeFields: ENVELOPE_UNCOMPARED.map(([f, why]) => ({ field: f, why })),
      localEnrichmentAttrs: [...ATTR_LOCAL_ENRICHMENT],
      seqAttr: opts.seqAttr, seqChecks: opts.seqChecks, seqLedgerComplete: opts.seqLedgerComplete,
      ignoredAttrs: [opts.seqAttr, ...opts.ignoreAttrs],
      markerPrefix: opts.markerPrefix, knownMarkers: MARKER_KINDS,
    },
    scanned, verdict, exitCode, counts, checks, blockers, waivers, notAsserted, markers,
    typeTable: typeRows, join, overlapNote, blindSpots: BLIND_SPOTS,
  };
}

// ── human output ────────────────────────────────────────────────────────────────────────

const ICON = { pass: "✅", fail: "❌", warn: "⚠️ ", info: "ℹ️ ", not_run: "🚫", waived: "➖" };

function renderHuman(r, opts) {
  const L = [];
  L.push(`CTL-1534 parity harness — shadow(cloud feed) vs live(smee), joined on ${r.policy.joinKey}`);
  L.push(`WINDOW   ${r.window.from ?? "(unbounded)"} → ${r.window.to ?? "(unbounded)"}   edge margin ${r.window.edgeMarginSeconds}s   sources ${r.window.sources.join(",")}${r.window.repos ? `   repos ${r.window.repos.join(",")}` : ""}`);
  for (const [label, s] of [["LIVE  ", r.scanned.live], ["SHADOW", r.scanned.shadow]]) {
    L.push(`${label}   ${s.files.join(" ")}`);
    L.push(`         ${s.lines} lines · ${s.webhookEnvelopes} webhook envelopes · ${s.compared} compared (github ${s.bySource.github} / linear ${s.bySource.linear}) · ${s.outOfWindow} out-of-window · versions [${s.producerVersions.join(",")}] hosts [${s.hosts.join(",")}]`);
  }
  L.push("");
  if (r.blockers.length > 0) {
    L.push(`NOT EVALUABLE — ${r.blockers.length} blocker(s). Nothing below was asserted.`);
    for (const b of r.blockers) L.push(`  ❌ ${b.id}  ${b.detail}`);
    L.push("");
  }
  L.push("ASSERTIONS");
  for (const c of r.checks) {
    L.push(`  ${ICON[c.status] ?? c.status} ${c.id.padEnd(28)} ${c.detail}`);
    if (c.status === "fail" || c.status === "warn") {
      const ev = c.evidence;
      const items = Array.isArray(ev?.items) ? ev.items : Array.isArray(ev?.deliveries?.items) ? ev.deliveries.items : Array.isArray(ev) ? ev : null;
      if (items) {
        for (const it of items.slice(0, opts.maxList)) L.push(`       · ${JSON.stringify(it)}`);
        const total = ev?.total ?? ev?.deliveries?.total ?? items.length;
        if (total > items.length) L.push(`       · … ${total - items.length} more (see --json)`);
      }
    }
  }
  L.push("");
  if (r.typeTable.length > 0) {
    L.push("PER-TYPE COUNTS (Gate B input — counts, never presence; expected-zero rows are printed)");
    L.push(`  ${"type".padEnd(46)}${"live".padStart(7)}${"shadow".padStart(8)}  ${"expectation".padEnd(13)} verdict`);
    for (const row of r.typeTable) {
      const t = row.ticket ? ` [${row.ticket}]` : "";
      const a = row.attributedElided > 0 ? ` (−${row.attributedElided} elided)` : "";
      L.push(`  ${row.type.padEnd(46)}${String(row.live).padStart(7)}${String(row.shadow).padStart(8)}  ${row.expectation.padEnd(13)} ${row.verdict}${a}${t}`);
    }
    L.push("");
  }
  if (r.waivers.length > 0) {
    L.push(`WAIVERS (${r.waivers.length}) — explicitly waived by a flag, NOT checked`);
    for (const w of r.waivers) L.push(`  ➖ ${w}`);
    L.push("");
  }
  if (r.notAsserted.length > 0) {
    L.push(`NOT ASSERTED (${r.notAsserted.length}) — these questions were NOT answered by this run`);
    for (const n of r.notAsserted) L.push(`  ◻︎ ${n.id}: ${n.reason}`);
    L.push("");
  }
  L.push(`NOT COVERED HERE (${r.blindSpots.length}) — structural blind spots of a log-vs-log diff`);
  for (const b of r.blindSpots) L.push(`  · ${b}`);
  L.push("");
  const v = r.verdict === "healthy" ? "HEALTHY" : r.verdict === "problem" ? "PROBLEM" : "CANNOT EVALUATE";
  L.push(`VERDICT  ${v}   pass ${r.counts.pass} · fail ${r.counts.fail} · warn ${r.counts.warn} (non-green) · info ${r.counts.info ?? 0} · not-run ${r.counts.notRun} · not-asserted ${r.counts.notAsserted}   exit ${r.exitCode}`);
  if (r.verdict === "cannot_evaluate" && r.blockers.length === 0 && r.counts.notRun > 0) {
    L.push("         (no blocker, but a check DID NOT RUN — an unanswered question is exit 2, never a pass)");
  }
  if (r.verdict === "cannot_evaluate" && r.counts.fail > 0) {
    L.push("         (assertions also FAILED, and the run is not evaluable — treat as red either way)");
  }
  return L.join("\n");
}

const HELP = `parity-harness.mjs — CTL-1534 · shadow(cloud) vs live(smee) event-log parity

  bun parity-harness.mjs [--from ISO --to ISO] [options]
  bun parity-harness.mjs --self-test          # offline, credential-free negative control

EXIT  0 = evaluated-healthy · 1 = evaluated-problem · 2 = COULD NOT EVALUATE (never "healthy")
      A "warn" row is a DETECTED LOSS and exits 1. A "not_run" row is an unanswered
      question and exits 2. Only "info" rows leave the verdict untouched.

INPUT
  --live PATH            live log file (repeatable).   default: <live-dir>/YYYY-MM.jsonl
  --shadow PATH          shadow log file (repeatable). default: <shadow-dir>/YYYY-MM.jsonl
  --live-dir DIR         default ~/catalyst/events
  --shadow-dir DIR       default ~/catalyst/events-shadow
  --from ISO --to ISO    window, inclusive. STRICT ISO-8601 only; bad input exits 2, never
                         coerced. Keep the window strictly INSIDE one config/deploy regime.
  --edge-margin SECONDS  boundary settling margin (default 120) — the cloud runs ~12s ahead of
                         smee, so near-boundary one-sided deliveries are counted, not failed.
                         A non-zero margin REQUIRES --from/--to (the boundary is never derived
                         from the data under test) and the window must exceed 2× the margin,
                         else the margin would swallow every candidate: exit 2, not a pass.
  --sources CSV          github,linear (default both)
  --repos CSV            restrict GitHub events to these repos (linear is never repo-filtered)
  --marker-prefix P      shadow-log marker event.name prefix (default catalyst.cloud_feed.).
                         A "gap" marker makes the run non-evaluable; an "elided" marker
                         ATTRIBUTES a live-only delivery; an UNRECOGNISED marker exits 2.

FEED ORDERING
  --seq-attr KEY         shadow attribute holding the cloud event_log.seq
                         (default catalyst.cloud.event.seq)
  --ignore-attr KEY      exclude an attribute from envelope equivalence (repeatable). The
                         --seq-attr key is always excluded; both are printed in the policy block.
  --no-seq-checks        WAIVE the ordering ASSERTIONS explicitly (recorded loudly). It does
                         NOT waive SEQ_ATTR_ABSENT: a shadow log with no seq attribute at all
                         is a producer-contract break and stays exit 2.
  --seq-ledger-complete  assert the shadow log records EVERY feed seq (enables contiguity +
                         coverage). Do not pass unless that is true.
  --expect-first-seq N   coverage: first seq must equal N (= since+1)
  --expect-head-seq N    coverage: last seq must equal N (= head)
  --require-coverage     exit 2 unless coverage was actually ASSERTED — i.e. unless BOTH
                         expectations are supplied AND --seq-ledger-complete is set AND the
                         seq checks are not waived. A demoted-to-not-asserted coverage
                         question is not a coverage pass.

STRICTNESS
  --strict-shadow-only   overlapping-type shadow-only deliveries FAIL (default: warn)
  --strict-known-gaps    filed cloud-side gaps (CTC-297) FAIL. Default is "info": a gap
                         that is already censused AND ticketed is tracked, printed every
                         run with its ticket, and does NOT move the verdict — a row that
                         is permanently red for the life of a ticket trains people to
                         ignore it. An UNCENSUSED loss is never counted here; it fails
                         MISSING_FROM_SHADOW. Pass this before the phase-5 close-out.
  --strict-attrs         locally-enriched attribute presence diffs FAIL
  --allow-version-span   waive the deploy-boundary gate (a window crossing a deploy lies)
  --allow-partial-overlap  waive the "sides cover different intervals" gate
  --tolerate-torn-tail   allow ONE unparseable FINAL line per file (concurrent-append artifact)

OUTPUT
  --json                 machine-readable report on stdout; exit code is the red/green key
  --max-list N           console/JSON evidence cap (default 25; truncation is declared)
`;

// ── offline negative control ────────────────────────────────────────────────────────────

function baseOpts(over = {}) {
  const { opts } = parseArgs([]);
  return { ...opts, ...over };
}

function env({ name, id, ts, seq = null, attrs = {}, version = "12.37.0", host = "mini", severity = "INFO" }) {
  const attributes = { "event.name": name, "event.entity": name.split(".")[1], "event.action": name.split(".")[2] ?? "", "event.channel": "webhook", ...attrs };
  if (id !== null) attributes["webhook.delivery.id"] = id;
  if (seq !== null) attributes["catalyst.cloud.event.seq"] = seq;
  return JSON.stringify({
    ts, id: `uuid-${id ?? "none"}-${seq ?? 0}`, observedTs: ts, severityText: severity, severityNumber: 9,
    traceId: null, spanId: null,
    resource: { "service.name": name.startsWith("github") ? "catalyst.github" : "catalyst.linear", "service.namespace": "catalyst", "service.version": version, "host.name": host, "host.id": "abc" },
    attributes, body: { message: `${name}`, payload: {} },
  });
}

/**
 * Seeded fixtures. Both sides are the same envelopes (the shadow consumer reuses
 * webhook-events.ts unmodified), differing only in what each scenario perturbs.
 */
function fixtures() {
  const T = (n) => `2026-07-26T22:${String(10 + n).padStart(2, "0")}:00.000Z`;
  const g = (i, id, seq, over = {}) => env({ name: "github.pr.opened", id, ts: T(i), seq, attrs: { "vcs.repository.name": "coalesce-labs/catalyst", "vcs.pr.number": 2751 }, ...over });
  const l = (i, id, seq, over = {}) => env({ name: "linear.comment.created", id, ts: T(i), seq, attrs: { "linear.issue.identifier": "CTL-1534" }, ...over });
  const liveLines = [g(1, "gh-1"), g(2, "gh-2"), l(3, "li-1"), l(4, "li-2"), g(5, "gh-3")];
  const shadowLines = [g(1, "gh-1", 101), g(2, "gh-2", 102), l(3, "li-1", 103), l(4, "li-2", 104), g(5, "gh-3", 105)];
  return { g, l, T, live: liveLines.join("\n"), shadow: shadowLines.join("\n") };
}

/**
 * Every case runs at the SHIPPED DEFAULTS unless it deliberately overrides them — in
 * particular at the default 120s --edge-margin. Hard-setting edgeMarginMs:0 in every
 * control meant the negative controls only went red because they disabled the margin
 * the CLI actually uses: the shipped configuration was exercised nowhere. The fixture
 * window (60 min, deliveries at 22:11..22:15) is comfortably wider than 2× the margin
 * and all fixtures are interior, so the default is a real, exercised setting here.
 */
function runCase(name, { liveText, shadowText, opts, expect }) {
  const o = baseOpts({ fromMs: Date.parse("2026-07-26T22:00:00.000Z"), fromIso: "2026-07-26T22:00:00.000Z", toMs: Date.parse("2026-07-26T23:00:00.000Z"), toIso: "2026-07-26T23:00:00.000Z", ...opts });
  const live = ingestText("live", liveText, o, "<fixture:live>");
  const shadow = ingestText("shadow", shadowText, o, "<fixture:shadow>");
  const report = evaluate({ live, shadow, opts: o, generatedAt: "1970-01-01T00:00:00.000Z" });
  // `fired` includes not_run rows when nothing blocked, so "the detector refused to
  // answer" is an observable outcome and not just an absent pass.
  const failedIds = new Set([
    ...report.checks.filter((c) => c.status === "fail" || c.status === "warn").map((c) => c.id),
    ...report.blockers.map((b) => b.id),
    ...(report.blockers.length === 0 ? report.checks.filter((c) => c.status === "not_run").map((c) => `${c.id}:not_run`) : []),
  ]);
  const okExit = report.exitCode === expect.exitCode;
  const okDetector = expect.detector === null ? true : failedIds.has(expect.detector);
  return { name, ok: okExit && okDetector, exitCode: report.exitCode, expectedExit: expect.exitCode, detector: expect.detector, fired: [...failedIds], report };
}

/**
 * Credential-free, offline, network-free negative control. Seeds synthetic fixtures and
 * asserts the detectors GO RED — plus a POSITIVE control, so a harness stuck at red cannot
 * pass its own negative control.
 */
export function selfTest() {
  const f = fixtures();
  const cases = [];

  // 0. POSITIVE CONTROL — clean fixtures must be GREEN. Without this, "everything is red"
  //    would pass every negative case below.
  cases.push(runCase("positive control (clean parity)", { liveText: f.live, shadowText: f.shadow, expect: { exitCode: EXIT_HEALTHY, detector: null } }));

  // 1. A DROPPED DELIVERY — one INTERIOR live delivery never reaches the shadow log. Dropped
  //    from the middle on purpose: a dropped first/last delivery moves the window boundary and
  //    would trip the (separate) overlap gate instead of the loss detector.
  cases.push(runCase("dropped delivery (live-only, interior)", {
    liveText: f.live,
    shadowText: [f.g(1, "gh-1", 101), f.g(2, "gh-2", 102), f.l(4, "li-2", 104), f.g(5, "gh-3", 105)].join("\n"),
    expect: { exitCode: EXIT_PROBLEM, detector: "MISSING_FROM_SHADOW" },
  }));

  // 2. ZERO-MATCH JOIN — disjoint delivery ids. Mismatch counting alone cannot tell this from
  //    perfect parity; it MUST be loud.
  cases.push(runCase("zero-match join (disjoint delivery ids)", {
    liveText: f.live,
    shadowText: [f.g(1, "x-1", 101), f.g(2, "x-2", 102), f.l(3, "x-3", 103), f.l(4, "x-4", 104), f.g(5, "x-5", 105)].join("\n"),
    expect: { exitCode: EXIT_PROBLEM, detector: "MATCHED_NONZERO_github" },
  }));

  // 3. OUT-OF-ORDER SEQUENCE — 101,103,102 in wire order. Sorting would hide it.
  cases.push(runCase("out-of-order seq (wire order, unsorted)", {
    liveText: f.live,
    shadowText: [f.g(1, "gh-1", 101), f.g(2, "gh-2", 103), f.l(3, "li-1", 102), f.l(4, "li-2", 104), f.g(5, "gh-3", 105)].join("\n"),
    expect: { exitCode: EXIT_PROBLEM, detector: "SEQ_WIRE_ORDER" },
  }));

  // 4. SEQ GAP under an asserted complete ledger.
  cases.push(runCase("seq gap (ledger-complete mode)", {
    liveText: f.live,
    shadowText: [f.g(1, "gh-1", 101), f.g(2, "gh-2", 102), f.l(3, "li-1", 104), f.l(4, "li-2", 105), f.g(5, "gh-3", 106)].join("\n"),
    opts: { seqLedgerComplete: true },
    expect: { exitCode: EXIT_PROBLEM, detector: "SEQ_CONTIGUITY" },
  }));

  // 5. SHORT READ — internally contiguous, ends before head, NO control record. Invisible to
  //    any contiguity check (defect 6: coverage != integrity).
  cases.push(runCase("short read (contiguous, ends before head)", {
    liveText: f.live, shadowText: f.shadow,
    opts: { seqLedgerComplete: true, expectFirstSeq: 101, expectHeadSeq: 200 },
    expect: { exitCode: EXIT_PROBLEM, detector: "SEQ_COVERAGE" },
  }));

  // 6. CONTROL RECORD — the feed declared the scan incomplete. The prefix is contiguous, so a
  //    naive contiguity check would pass a server-declared short read. Must be exit 2.
  cases.push(runCase("control record invalidates the run", {
    liveText: f.live,
    shadowText: `${f.shadow}\n${JSON.stringify({ error: "cursor_underflow", resync: true })}`,
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "CONTROL_RECORD" },
  }));

  // 6b. FEED-GAP MARKER — the consumer declared its OWN coverage incomplete. Everything else
  //     in the window is internally consistent, so every assertion would otherwise pass.
  cases.push(runCase("consumer feed-gap marker invalidates the run", {
    liveText: f.live,
    shadowText: `${f.shadow}\n${JSON.stringify({ ts: f.T(3), attributes: { "event.name": "catalyst.cloud_feed.gap" }, marker: "feed-gap" })}`,
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "FEED_GAP_DECLARED" },
  }));

  // 6c. UNRECOGNISED MARKER — a consumer rename must surface, never read as silence.
  cases.push(runCase("unrecognised shadow marker", {
    liveText: f.live,
    shadowText: `${f.shadow}\n${JSON.stringify({ ts: f.T(3), attributes: { "event.name": "catalyst.cloud_feed.something_new" } })}`,
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "UNKNOWN_SHADOW_MARKER" },
  }));

  // 7. ENVELOPE MISMATCH on a matched pair (same delivery id, different mapped event.name).
  cases.push(runCase("envelope mismatch on a matched pair", {
    liveText: f.live,
    shadowText: [f.g(1, "gh-1", 101), env({ name: "github.pr.closed", id: "gh-2", ts: f.T(2), seq: 102, attrs: { "vcs.repository.name": "coalesce-labs/catalyst", "vcs.pr.number": 2751 } }), f.l(3, "li-1", 103), f.l(4, "li-2", 104), f.g(5, "gh-3", 105)].join("\n"),
    expect: { exitCode: EXIT_PROBLEM, detector: "ENVELOPE_EQUIVALENCE" },
  }));

  // 8. MALFORMED LINE — evidence not trustworthy, exit 2 (never repaired).
  cases.push(runCase("malformed line", {
    liveText: f.live, shadowText: `${f.shadow}\n{"attributes": broken`,
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "MALFORMED_INPUT" },
  }));

  // 9. DEPLOY BOUNDARY — two producer versions inside the window. A window that crosses a
  //    config change reports a confidently wrong number in whichever direction it went.
  cases.push(runCase("window crosses a deploy boundary", {
    liveText: f.live,
    shadowText: [f.g(1, "gh-1", 101), f.g(2, "gh-2", 102, { version: "12.38.0" }), f.l(3, "li-1", 103), f.l(4, "li-2", 104), f.g(5, "gh-3", 105)].join("\n"),
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "DEPLOY_BOUNDARY" },
  }));

  // 10. MISSING JOIN KEY (pre-CTL-1532 envelopes) — the join would silently under-match.
  cases.push(runCase("missing webhook.delivery.id (pre-CTL-1532)", {
    liveText: [f.g(1, "gh-1"), env({ name: "github.pr.opened", id: null, ts: f.T(2) }), f.l(3, "li-1"), f.l(4, "li-2"), f.g(5, "gh-3")].join("\n"),
    shadowText: f.shadow,
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "MISSING_JOIN_KEY" },
  }));

  // 11. SEQ ATTRIBUTE ABSENT — ordering cannot be evaluated; must not silently skip.
  cases.push(runCase("shadow carries no seq attribute", {
    liveText: f.live,
    shadowText: [f.g(1, "gh-1"), f.g(2, "gh-2"), f.l(3, "li-1"), f.l(4, "li-2"), f.g(5, "gh-3")].join("\n"),
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "SEQ_ATTR_ABSENT" },
  }));

  // 12. SHADOW-SIDE DUPLICATE — the consumer's dedup (invariant 6) is not holding.
  cases.push(runCase("shadow duplicate delivery id", {
    liveText: f.live,
    shadowText: [f.g(1, "gh-1", 101), f.g(2, "gh-2", 102), f.g(2, "gh-2", 103), f.l(3, "li-1", 104), f.l(4, "li-2", 105), f.g(5, "gh-3", 106)].join("\n"),
    expect: { exitCode: EXIT_PROBLEM, detector: "DUPLICATE_DELIVERY_SHADOW" },
  }));

  // 13. PER-TYPE DEFICIT — a type the live side carries more of than the shadow side.
  cases.push(runCase("per-type shadow deficit", {
    liveText: [f.g(1, "gh-1"), f.g(2, "gh-2"), f.g(5, "gh-3"), f.l(3, "li-1"), f.l(4, "li-2")].join("\n"),
    shadowText: [f.g(1, "gh-1", 101), f.g(2, "gh-2", 102), f.l(3, "li-1", 103), f.l(4, "li-2", 104), env({ name: "github.check_suite.completed", id: "gh-3", ts: f.T(5), seq: 105, attrs: { "vcs.repository.name": "coalesce-labs/catalyst" } })].join("\n"),
    expect: { exitCode: EXIT_PROBLEM, detector: "TYPE_COUNTS" },
  }));

  // 15. EDGE MARGIN CANNOT SWALLOW THE WINDOW. At the shipped 120s default, a 3-minute
  //     window makes EVERY delivery "edge" — both loss detectors would examine zero
  //     candidates and pass. Must be exit 2 before any assertion runs.
  cases.push(runCase("edge margin covers the whole window", {
    liveText: f.live, shadowText: f.shadow,
    opts: { fromMs: Date.parse("2026-07-26T22:10:00.000Z"), fromIso: "2026-07-26T22:10:00.000Z", toMs: Date.parse("2026-07-26T22:13:00.000Z"), toIso: "2026-07-26T22:13:00.000Z" },
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "EDGE_MARGIN_SWALLOWS_WINDOW" },
  }));

  // 15b. UNBOUNDED WINDOW + a non-zero margin: the boundary would be derived from the data
  //      under test, which permanently waives the earliest and latest deliveries.
  cases.push(runCase("unbounded window with the default edge margin", {
    liveText: f.live, shadowText: f.shadow,
    opts: { fromMs: null, fromIso: null, toMs: null, toIso: null },
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "UNBOUNDED_WINDOW" },
  }));

  // 15c. EVERY loss candidate edge-excluded => the detector examined nothing. It must
  //      report not_run (exit 2), never `pass`. Window 22:00–23:00, margin 120s: the only
  //      one-sided delivery sits at 22:59:30, inside the trailing margin.
  //      (a matched pair at 22:59:00 keeps the window-overlap gate quiet, so the ONLY thing
  //      this case exercises is the edge exclusion itself)
  const lateMatched = (seq) => env({ name: "github.pr.opened", id: "gh-late", ts: "2026-07-26T22:59:00.000Z", seq, attrs: { "vcs.repository.name": "coalesce-labs/catalyst" } });
  cases.push(runCase("all loss candidates edge-excluded is not_run, never pass", {
    liveText: [f.live, lateMatched(null),
      env({ name: "github.pr.opened", id: "gh-edge", ts: "2026-07-26T22:59:30.000Z", attrs: { "vcs.repository.name": "coalesce-labs/catalyst" } })].join("\n"),
    shadowText: [f.shadow, lateMatched(106)].join("\n"),
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "MISSING_FROM_SHADOW:not_run" },
  }));

  // 16. SEQ ATTRIBUTE ABSENT IS NOT WAIVABLE. --no-seq-checks waives the assertions, not the
  //     producer contract: waiving an attribute nobody writes makes three checks structurally
  //     unreachable under a green verdict. This was THE false green.
  cases.push(runCase("--no-seq-checks cannot waive a shadow log with NO seq attribute", {
    liveText: f.live,
    shadowText: [f.g(1, "gh-1"), f.g(2, "gh-2"), f.l(3, "li-1"), f.l(4, "li-2"), f.g(5, "gh-3")].join("\n"),
    opts: { seqChecks: false },
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "SEQ_ATTR_ABSENT" },
  }));

  // 17. --require-coverage with expectations but WITHOUT --seq-ledger-complete: coverage is
  //     demoted to not-asserted, which used to have zero effect on the verdict.
  cases.push(runCase("--require-coverage without a complete ledger cannot answer coverage", {
    liveText: f.live, shadowText: f.shadow,
    opts: { requireCoverage: true, expectFirstSeq: 101, expectHeadSeq: 200 },
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "COVERAGE_REQUIRED" },
  }));
  cases.push(runCase("--require-coverage with the seq checks waived cannot answer coverage", {
    liveText: f.live, shadowText: f.shadow,
    opts: { requireCoverage: true, expectFirstSeq: 101, expectHeadSeq: 200, seqLedgerComplete: true, seqChecks: false },
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "COVERAGE_REQUIRED" },
  }));

  // 18. TOTAL LIVE-SIDE LOSS of a censused `both` type. Presence-based classification called
  //     this the "expected cloud superset" and passed — the 14h32m smee outage shape.
  cases.push(runCase("total live-side loss of a censused `both` type", {
    liveText: f.live,
    shadowText: [f.shadow,
      env({ name: "github.deployment_status.success", id: "dep-1", ts: f.T(2), seq: 106, attrs: { "vcs.repository.name": "coalesce-labs/catalyst" } }),
      env({ name: "github.deployment_status.success", id: "dep-2", ts: f.T(3), seq: 107, attrs: { "vcs.repository.name": "coalesce-labs/catalyst" } })].join("\n"),
    expect: { exitCode: EXIT_PROBLEM, detector: "LIVE_DEFICIT_TYPES" },
  }));

  // 19. OVERLAPPING-TYPE SHADOW-ONLY is a smee-side drop. `warn` used to be invisible to the
  //     exit code, so the run printed the finding and exited 0.
  cases.push(runCase("overlapping-type shadow-only deliveries are non-green", {
    liveText: f.live,
    shadowText: [f.shadow, f.g(2, "gh-extra", 106)].join("\n"),
    expect: { exitCode: EXIT_PROBLEM, detector: "SHADOW_ONLY" },
  }));

  // 20. AN ELIDED DELIVERY never reached the shadow log — the consumer itself grades it a
  //     problem. The harness must not disagree with its own producer by exiting 0.
  cases.push(runCase("a corroborated elision is a non-green attributed loss", {
    liveText: f.live,
    shadowText: [f.g(1, "gh-1", 101), f.g(2, "gh-2", 102), f.l(3, "li-1", 103), f.l(4, "li-2", 104),
      JSON.stringify({ ts: f.T(5), attributes: { "event.name": "catalyst.cloud_feed.unmappable_payload", "webhook.delivery.id": "gh-3" }, reason: "payloadOmitted", payloadBytes: 120000, source: "github", eventType: "pull_request" })].join("\n"),
    expect: { exitCode: EXIT_PROBLEM, detector: "ELIDED_PAYLOADS" },
  }));

  // 21. AN UNCORROBORATED elision marker must not be allowed to excuse a loss: it suppresses
  //     a MISSING_FROM_SHADOW row AND discounts a type deficit, on the say-so of the
  //     component under test.
  cases.push(runCase("an uncorroborated elision marker cannot excuse a loss", {
    liveText: f.live,
    shadowText: [f.g(1, "gh-1", 101), f.g(2, "gh-2", 102), f.l(3, "li-1", 103), f.l(4, "li-2", 104),
      JSON.stringify({ ts: f.T(5), attributes: { "event.name": "catalyst.cloud_feed.unmappable_payload", "webhook.delivery.id": "gh-3" }, reason: "payloadOmitted", payloadBytes: 12 })].join("\n"),
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "UNCORROBORATED_ELISION" },
  }));

  // 22. A STRING seq is INVALID EVIDENCE, not something to coerce (rule 6, applied to the
  //     harness's own reader). The consumer stamps a number; a string means the producer
  //     changed shape, and parseIntStrict-ing it hid that.
  cases.push(runCase("a string seq value is rejected, never coerced", {
    liveText: f.live,
    shadowText: [f.g(1, "gh-1", 101), f.g(2, "gh-2", "102"), f.l(3, "li-1", 103), f.l(4, "li-2", 104), f.g(5, "gh-3", 105)].join("\n"),
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "SEQ_ATTR_INVALID" },
  }));

  // 23. A PARTIAL edge exclusion is not a full answer. The not_run row only fires when
  //     EVERY candidate is edge-excluded, so 1-of-2 waived printed a bare `pass`.
  // (the matched `gh-anchor` pair at 22:59 keeps the window-overlap gate quiet; the two
  //  live-only rows are the actual subject — one interior, one inside the trailing margin)
  const edgeAnchor = (seq) => env({ name: "github.pr.opened", id: "gh-anchor", ts: "2026-07-26T22:59:00.000Z", seq, attrs: { "vcs.repository.name": "coalesce-labs/catalyst" } });
  const partialEdge = runCase("a PARTIAL edge exclusion is enumerated, not folded into the pass", {
    liveText: [f.live, edgeAnchor(null),
      env({ name: "github.pr.opened", id: "gh-interior", ts: f.T(20), attrs: { "vcs.repository.name": "coalesce-labs/catalyst" } }),
      env({ name: "github.pr.opened", id: "gh-edge", ts: "2026-07-26T22:59:30.000Z", attrs: { "vcs.repository.name": "coalesce-labs/catalyst" } })].join("\n"),
    shadowText: [f.shadow, edgeAnchor(106)].join("\n"),
    expect: { exitCode: EXIT_PROBLEM, detector: "MISSING_FROM_SHADOW" },
  });
  partialEdge.ok =
    partialEdge.ok &&
    partialEdge.report.notAsserted.some((n) => n.id === "MISSING_FROM_SHADOW_EDGE_EXCLUDED");
  cases.push(partialEdge);

  // 24. A FILED, censused gap is `info` — tracked and printed with its ticket, but it does
  //     NOT hold the verdict red for the life of the ticket (which trains people to stop
  //     reading it). --strict-known-gaps is the escalation, and it must still bite.
  const knownGapShadow = [f.g(1, "gh-1", 101), f.g(2, "gh-2", 102), f.l(3, "li-1", 103), f.l(4, "li-2", 104), f.g(5, "gh-3", 105)].join("\n");
  const knownGapLive = [f.live, env({ name: "linear.reaction.created", id: "rx-1", ts: f.T(3), attrs: {} })].join("\n");
  cases.push(runCase("a filed, censused gap is tracked info — not a permanently red verdict", {
    liveText: knownGapLive, shadowText: knownGapShadow,
    expect: { exitCode: EXIT_HEALTHY, detector: null },
  }));
  cases.push(runCase("--strict-known-gaps still escalates a filed gap to a hard fail", {
    liveText: knownGapLive, shadowText: knownGapShadow,
    opts: { strictKnownGaps: true },
    expect: { exitCode: EXIT_PROBLEM, detector: "KNOWN_GAP_LOSSES" },
  }));

  // 14. BAD INPUT — never coerced. `--from banana` must be rejected, not NaN'd into "scan
  //     everything and report healthy about a range nobody asked for".
  const badArgs = parseArgs(["--from", "banana"]);
  cases.push({ name: "bad --from is rejected, never coerced", ok: badArgs.ok === false, exitCode: badArgs.ok ? "accepted" : EXIT_CANNOT_EVALUATE, expectedExit: EXIT_CANNOT_EVALUATE, detector: "ARG_PARSE", fired: badArgs.ok ? [] : ["ARG_PARSE"] });
  const badSince = parseArgs(["--expect-head-seq", "banana"]);
  cases.push({ name: "bad --expect-head-seq is rejected, never coerced", ok: badSince.ok === false, exitCode: badSince.ok ? "accepted" : EXIT_CANNOT_EVALUATE, expectedExit: EXIT_CANNOT_EVALUATE, detector: "ARG_PARSE", fired: badSince.ok ? [] : ["ARG_PARSE"] });
  const badFlag = parseArgs(["--frmo", "x"]);
  cases.push({ name: "unknown flag is rejected", ok: badFlag.ok === false, exitCode: badFlag.ok ? "accepted" : EXIT_CANNOT_EVALUATE, expectedExit: EXIT_CANNOT_EVALUATE, detector: "ARG_PARSE", fired: badFlag.ok ? [] : ["ARG_PARSE"] });
  // An EMPTY value for a detector-bearing flag is the same defect through a wrapper's
  // unset variable: `--marker-prefix ""` turns marker detection into a total no-op.
  const emptyMarker = parseArgs(["--marker-prefix", ""]);
  cases.push({ name: "empty --marker-prefix is rejected (it would disable marker detection)", ok: emptyMarker.ok === false, exitCode: emptyMarker.ok ? "accepted" : EXIT_CANNOT_EVALUATE, expectedExit: EXIT_CANNOT_EVALUATE, detector: "ARG_PARSE", fired: emptyMarker.ok ? [] : ["ARG_PARSE"] });
  const emptySeqAttr = parseArgs(["--seq-attr", ""]);
  cases.push({ name: "empty --seq-attr is rejected (it would read an attribute nobody writes)", ok: emptySeqAttr.ok === false, exitCode: emptySeqAttr.ok ? "accepted" : EXIT_CANNOT_EVALUATE, expectedExit: EXIT_CANNOT_EVALUATE, detector: "ARG_PARSE", fired: emptySeqAttr.ok ? [] : ["ARG_PARSE"] });
  // A re-pointed prefix can ADD a watch, never hide the built-in one.
  const repointed = runCase("a re-pointed --marker-prefix still sees the built-in consumer markers", {
    liveText: f.live,
    shadowText: `${f.shadow}\n${JSON.stringify({ ts: f.T(3), attributes: { "event.name": "catalyst.cloud_feed.gap" }, marker: "feed-gap" })}`,
    opts: { markerPrefix: "some.other.prefix." },
    expect: { exitCode: EXIT_CANNOT_EVALUATE, detector: "FEED_GAP_DECLARED" },
  });
  cases.push(repointed);

  const negatives = cases.filter((c) => c.detector !== null);
  const fired = negatives.filter((c) => c.ok).length;
  const positive = cases.find((c) => c.detector === null);
  return { cases, negatives: negatives.length, fired, positiveOk: positive?.ok === true, allOk: cases.every((c) => c.ok) };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    // Rule 6: reject bad input, never repair it. Bad input is COULD-NOT-EVALUATE, not a pass.
    process.stderr.write(`parity-harness: ${parsed.reason}\n`);
    return EXIT_CANNOT_EVALUATE;
  }
  const opts = parsed.opts;
  if (opts.help) { process.stdout.write(HELP); return EXIT_HEALTHY; }

  if (opts.selfTest) {
    const r = selfTest();
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ mode: "self-test", negatives: r.negatives, fired: r.fired, positiveOk: r.positiveOk, allOk: r.allOk, cases: r.cases.map((c) => ({ name: c.name, ok: c.ok, expectedExit: c.expectedExit, exitCode: c.exitCode, detector: c.detector, fired: c.fired })) }, null, 2)}\n`);
    } else {
      process.stdout.write("parity-harness --self-test (offline, credential-free, no network)\n\n");
      for (const c of r.cases) {
        const tag = c.detector === null ? "positive" : "negative";
        process.stdout.write(`  ${c.ok ? "✅" : "❌"} [${tag}] ${c.name}  → exit ${c.exitCode} (expected ${c.expectedExit})${c.detector ? ` detector ${c.detector}${c.ok ? " FIRED" : " DID NOT FIRE"}` : ""}\n`);
      }
      process.stdout.write(`\n  detectors fired: ${r.fired}/${r.negatives}   positive control: ${r.positiveOk ? "GREEN" : "NOT GREEN"}\n`);
      process.stdout.write(`  ${r.allOk ? "SELF-TEST PASS — the detectors go red on seeded failures and green on clean input." : "SELF-TEST FAIL — a detector did not behave as specified. Do NOT trust a green parity run."}\n`);
    }
    return r.allOk ? EXIT_HEALTHY : EXIT_PROBLEM;
  }

  const liveDir = opts.liveDir ?? join(homedir(), "catalyst", "events");
  const shadowDir = opts.shadowDir ?? join(homedir(), "catalyst", "events-shadow");
  const liveFiles = opts.live.length > 0 ? opts.live : monthFilesFor(liveDir, opts.fromMs, opts.toMs);
  const shadowFiles = opts.shadow.length > 0 ? opts.shadow : monthFilesFor(shadowDir, opts.fromMs, opts.toMs);

  const missing = [...liveFiles, ...shadowFiles].filter((f) => !existsSync(f) || !statSync(f).isFile());
  if (missing.length > 0) {
    // A missing input is COULD-NOT-EVALUATE. Notably: an absent shadow log means the consumer
    // never ran — that is not "no differences found".
    const report = {
      harness: "parity-harness", schemaVersion: 1, ticket: "CTL-1534", generatedAt: new Date().toISOString(),
      verdict: "cannot_evaluate", exitCode: EXIT_CANNOT_EVALUATE,
      blockers: [{ id: "INPUT_MISSING", detail: `input log(s) not found: ${missing.join(", ")}`, evidence: missing }],
      checks: [], counts: { pass: 0, fail: 0, warn: 0, notRun: 0, notAsserted: 0 },
      notAsserted: [], waivers: [], blindSpots: BLIND_SPOTS, typeTable: [], join: null,
      scanned: { live: { files: liveFiles }, shadow: { files: shadowFiles } },
      window: { from: opts.fromIso, to: opts.toIso },
    };
    process.stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : `parity-harness: CANNOT EVALUATE — input log(s) not found:\n  ${missing.join("\n  ")}\n\nA missing shadow log means the consumer never wrote — that is not "no differences found".\nexit ${EXIT_CANNOT_EVALUATE}\n`);
    return EXIT_CANNOT_EVALUATE;
  }

  const live = newSideAcc("live");
  const shadow = newSideAcc("shadow");
  try {
    for (const f of liveFiles) await ingestFile(live, f, opts);
    for (const f of shadowFiles) await ingestFile(shadow, f, opts);
  } catch (err) {
    process.stderr.write(`parity-harness: CANNOT EVALUATE — read failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT_CANNOT_EVALUATE;
  }

  const report = evaluate({ live, shadow, opts });
  process.stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderHuman(report, opts)}\n`);
  return report.exitCode;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => { process.exit(code); })
    .catch((err) => {
      // An unexpected throw is COULD-NOT-EVALUATE, never healthy.
      process.stderr.write(`parity-harness: CANNOT EVALUATE — unhandled error: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(EXIT_CANNOT_EVALUATE);
    });
}
