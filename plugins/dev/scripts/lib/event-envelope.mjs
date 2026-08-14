// event-envelope.mjs — THE envelope schema for ~/catalyst/events/YYYY-MM.jsonl.
//
// CTL-1819. Companion to event-name.mjs (CTL-1834): that module answers "what is
// this event CALLED", this one answers "is this a well-formed event at all".
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// `plugins/dev/templates/global-event.json` was cited by docs/adrs.md and
// docs/architecture.md as THE event contract for the life of the project. It
// required `{ts, orchestrator, event}` with a closed enum of names like
// `orchestrator-started`. MEASURED against the live log: it passes 0 of
// 1,194,150 events, no code has ever imported it, and both citations are prose.
// A mechanism that has never produced an output does not exist — so it is
// deleted in the same change that adds this file. Leaving a false contract next
// to a true one is the duplication this work exists to remove.
//
// ── THE SCHEMA IS MEASURED, NOT DESIGNED ────────────────────────────────────
// Every rule below was derived by counting the live corpus, not by deciding what
// events ought to look like. Full census of mini's 2026-08 log, 1,194,150 lines,
// 100% parsed (zero torn):
//
//   v2-only  `attributes`            1,167,253
//   v1-only  `event`                    25,355
//   dual     `event`+`attributes`          951   ← the CTL-1795 superset
//   v3-only  `name`                        532
//   ────────────────────────────────────────────
//   lines with none of the three                0
//
// Two invariants were confirmed the same way rather than assumed:
//   • `ts` is present and a string on 1,194,144 of 1,194,144 lines.
//   • All 951 dual lines AGREE between `.event` and `.attributes["event.name"]`
//     (consistent with CTL-1834's all-files census: 322/322 agreed there).
//
// ── TWO LAYERS, AND THE SPLIT IS THE WHOLE DESIGN ───────────────────────────
// The ticket's constraints pull in opposite directions: drift must redden CI,
// but a malformed event must never abort a daemon tick. One validator cannot do
// both, so there are two:
//
//   RUNTIME (validateEnvelope)  — STRUCTURAL only. Is it an object, does it
//     carry `ts`, does a name resolve, do dual keys agree. Counted, never
//     thrown. It deliberately does NOT police the top-level key vocabulary,
//     because v1/v3 envelopes carry arbitrary flat payload fields and a
//     runtime that rejected an unrecognised one would turn a new producer
//     field into a production incident.
//
//   CI (unknownTopLevelKeys)    — STRICT vocabulary. A producer that adds a
//     top-level key fails the guard test naming the key. This is where "drift
//     reddens CI" lives, and it is safe here precisely because it is not on the
//     read path.
//
// ── WHAT A SCHEMA CANNOT DO, STATED SO NOBODY RELIES ON IT ──────────────────
// A schema validates SHAPE, not TRUTH. CTL-1809 reproduced a torn line that
// parses as valid JSON, carries a correct declared length, and contains three
// spliced events. This module passes that line. Tearing is prevented on the
// WRITE side (canonical_atomic_append_line's single write(2)); it is detected on
// the read side by event-tail.mjs's `noteTornLine`, which counts lines that do
// not parse at all. These are three different mechanisms and none substitutes
// for another.
//
// ── WHY IT LIVES IN lib/ ────────────────────────────────────────────────────
// Same reason as event-name.mjs: `lib/` is the zero-npm-import zone. `catalyst
// doctor` resolves its runtime as `command -v bun || command -v node` and must
// import from here on bare Node with no node_modules. This file imports nothing.
// That is also why the vocabulary below is a hand-written frozen array rather
// than a Zod schema — Zod is not a dependency of this repo's source (it is
// transitive only), and adding one to this zone would break the bare-Node load.

/** The four envelope shapes observed on the log. */
export const ENVELOPE_SHAPES = Object.freeze(["v1", "v2", "v3", "dual"]);

// The complete top-level key vocabulary, MEASURED (`jq -rc 'keys[]' | sort -u`)
// over mini's 2026-08 log: 36 distinct keys, no truncation. Recorded in sorted
// order so a diff against a fresh census is a plain sorted-set comparison.
//
// This list is a SNAPSHOT OF REALITY, not a wish. When a producer legitimately
// adds a key, the guard test fails, and the fix is to add the key here in the
// same commit that adds the producer — which is the point: the addition becomes
// visible in review instead of appearing silently on the log.
export const KNOWN_TOP_LEVEL_KEYS = Object.freeze([
  "attempt",
  "attributes",
  "bg_job_id",
  "body",
  "branch",
  "canonical_bg_job_id",
  "category",
  "caused_by",
  "channel",
  "command",
  "detail",
  "dominant_phase",
  "error",
  "event",
  "id",
  "mergeStateStatus",
  "name",
  "number",
  "observedTs",
  "phase",
  "pid",
  "prevStateJsonMtime",
  "reason",
  "reclaimed",
  "repo",
  "resource",
  "scanned",
  "session_id",
  "severityNumber",
  "severityText",
  "spanId",
  "ticket",
  "traceId",
  "ts",
  "url",
  "worktree_path",
]);

const KNOWN_KEY_SET = new Set(KNOWN_TOP_LEVEL_KEYS);

// Test-only bypass. Set CATALYST_EVENT_SCHEMA_OFF=1 to make validation inert:
// validateEnvelope reports ok and noteMalformedEvent counts nothing. This exists
// so the guard test can run the SAME malformed fixture with validation on and
// off and assert the counter moves in one case and not the other — a positive
// control. Without it, a test that only asserts "no counter movement on good
// input" would still pass with the validator deleted entirely.
//
// Read per-call, not captured at module load, so a test can toggle it.
function bypassed() {
  try {
    return process.env.CATALYST_EVENT_SCHEMA_OFF === "1";
  } catch {
    return false; // no `process` (unlikely here, but this module must never throw)
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === "string" && v !== "";
}

/**
 * Which envelope shape is this? Mirrors event-name.mjs's key set exactly —
 * if these two ever disagree about which keys carry a name, an event can be
 * classified as one shape and named from another.
 *
 * Returns "v1" | "v2" | "v3" | "dual" | "unknown".
 */
export function classifyEnvelope(event) {
  if (!isPlainObject(event)) return "unknown";
  const hasV1 = nonEmptyString(event.event);
  const hasV2 = isPlainObject(event.attributes) && nonEmptyString(event.attributes["event.name"]);
  const hasV3 = nonEmptyString(event.name);
  if (hasV1 && hasV2) return "dual";
  if (hasV1) return "v1";
  if (hasV2) return "v2";
  if (hasV3) return "v3";
  return "unknown";
}

/**
 * Structural validation for the read path. Never throws, never rejects on an
 * unrecognised top-level key (see the two-layer note in the header).
 *
 * @returns {{ok: boolean, shape: string, errors: string[]}}
 */
export function validateEnvelope(event) {
  if (bypassed()) return { ok: true, shape: "bypassed", errors: [] };

  const errors = [];
  if (!isPlainObject(event)) {
    return { ok: false, shape: "unknown", errors: ["not a JSON object"] };
  }

  const shape = classifyEnvelope(event);
  if (shape === "unknown") {
    errors.push('no event name: none of `event`, `attributes["event.name"]`, `name` is a non-empty string');
  }

  // Measured universal: 1,194,144 of 1,194,144 lines carry ts as a string.
  if (!nonEmptyString(event.ts)) {
    errors.push("`ts` missing or not a non-empty string");
  }

  // Measured invariant: 951 of 951 dual lines agree. The dual writer
  // (canonical_dual_envelope_line) reads the name once and passes the same
  // string to both keys, so a disagreement means something else wrote the line.
  if (shape === "dual" && event.event !== event.attributes["event.name"]) {
    errors.push(
      `dual envelope disagrees: event=${JSON.stringify(event.event)} vs ` +
        `attributes["event.name"]=${JSON.stringify(event.attributes["event.name"])}`
    );
  }

  return { ok: errors.length === 0, shape, errors };
}

/**
 * Top-level keys not in the measured vocabulary. CI-only — see the header for
 * why this is deliberately not consulted on the read path.
 */
export function unknownTopLevelKeys(event) {
  if (!isPlainObject(event)) return [];
  return Object.keys(event).filter((k) => !KNOWN_KEY_SET.has(k));
}

// ── Malformed-event counter ─────────────────────────────────────────────────
// Deliberately the same shape as event-tail.mjs's `noteTornLine`: count every
// occurrence, log sparsely, straight to stderr (which lands in the caller's
// launchd-captured `.log`, Alloy-shipped to Loki INDEPENDENTLY of the event log
// whose damage it reports). A separate counter and key budget from the torn-line
// one on purpose — they are two different detectors, and the CTL-1817 rule is
// that one flood must not exhaust another detector's budget.
let malformedTotal = 0;
const malformedByShape = new Map();
const malformedWarned = new Set();

/** Process-total malformed events seen at the read boundary. */
export function malformedEventCount() {
  return malformedTotal;
}

/** Per-shape breakdown — the AC's "naming the shape". */
export function malformedCountsByShape() {
  return Object.fromEntries(malformedByShape);
}

/** Test seam — resets the counters and the sparse-warn key set. */
export function resetMalformedEventCount() {
  malformedTotal = 0;
  malformedByShape.clear();
  malformedWarned.clear();
}

/**
 * Record one malformed event. Counted, never thrown — a reader that aborts on a
 * bad line is strictly worse than one that skips it, because the bad line is
 * already behind the byte cursor and will never be revisited.
 */
export function noteMalformedEvent(result) {
  if (bypassed()) return;
  const shape = result?.shape ?? "unknown";
  const errors = Array.isArray(result?.errors) ? result.errors : [];
  malformedTotal += 1;
  malformedByShape.set(shape, (malformedByShape.get(shape) ?? 0) + 1);

  const key = `${shape}:${errors[0] ?? ""}`.slice(0, 60);
  let warn = false;
  if (!malformedWarned.has(key) && malformedWarned.size < 20) {
    malformedWarned.add(key);
    warn = true;
  } else if (malformedTotal >= 10 && Math.log10(malformedTotal) % 1 === 0) {
    warn = true;
  }
  if (!warn) return;
  try {
    process.stderr.write(
      `[catalyst] WARNING: MALFORMED event envelope — counted and skipped ` +
        `(malformed_events_total=${malformedTotal}, shape=${shape}): ${errors.join("; ")}\n`
    );
  } catch {
    /* a reporting hook must never break the tail */
  }
}

/**
 * Convenience for read paths: validate, count on failure, return the verdict.
 * One call so a reader cannot validate and forget to count.
 */
export function checkEnvelope(event) {
  const result = validateEnvelope(event);
  if (!result.ok) noteMalformedEvent(result);
  return result;
}
