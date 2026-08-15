// event-envelope.mjs — THE envelope schema for ~/catalyst/events/YYYY-MM.jsonl.
//
// CTL-1819. Companion to event-name.mjs (CTL-1834): that module answers "what is
// this event CALLED", this one answers "is this a well-formed event at all".
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// `plugins/dev/templates/global-event.json` was cited by docs/adrs.md and
// docs/architecture.md as THE event contract for the life of the project. It
// required `{ts, orchestrator, event}` with a closed enum of names like
// `orchestrator-started`. MEASURED against the live log: it passed ZERO events,
// and both citations were prose.
//
// ON "NO CODE EVER IMPORTED IT" (Codex rounds 19 + 20). That is a claim about
// HISTORY, and a current-tree grep establishes only present absence. Round 19's
// instrument was still wrong twice over: its four suffix globs missed extensionless
// executables (`plugins/dev/scripts/catalyst-events` is real code), and it searched
// `--all`, so committing the correction CHANGED ITS OWN RESULT — the recorded
// command and the recorded number diverged the moment they were written down.
//
// Both fixed by scoping to the branch the claim is about and the tree it covers:
//
//   git log origin/main -S'global-event.json' -- plugins/dev/scripts   → 0
//   git log origin/main -S'getEventName'      -- plugins/dev/scripts   → 19  (control)
//
// `origin/main` excludes this PR's own commits, so the result is STABLE as this
// branch grows; the bare pathspec covers every file under the runtime including
// extensionless ones. The control shows the instrument does find real code
// references at the same scope. Demonstrated statement: no commit in main's
// history has ever touched that filename anywhere under `plugins/dev/scripts`.
//
// A mechanism that has never produced an output does not exist — so it is deleted
// in the same change that adds this file. Leaving a false contract next to a true
// one is the duplication this work exists to remove.
//
// ── THE SCHEMA IS MEASURED, NOT DESIGNED ────────────────────────────────────
// Every rule below was derived by counting the live corpus, not by deciding what
// events ought to look like.
//
// METHODOLOGY (Codex round 4). Every figure here comes from ONE FROZEN BYTE
// SNAPSHOT — `head -c $(stat -f %z "$LOG") "$LOG" > snapshot` — and every count
// reads only that snapshot. The first cut of this header did not: its counts were
// separate queries minutes apart against a file being appended to, so the four
// shape counts summed to 1,194,091 against a stated 1,194,150 total, leaving 59
// lines unexplained. That mattered because the numbers were used to support a
// NEGATIVE ("no line lacked a discriminator"), and AGENTS.md is explicit that a
// negative is only evidence if the instrument could have shown otherwise. Counts
// taken at different times against a growing file cannot.
//
// mini's 2026-08 log, snapshot 1,117,890,759 bytes:
//
//   total lines                              1,202,573
//   parsed (JSON.parse succeeds)             1,202,573   ← 100%, zero torn
//
//   v2-only  `attributes`                    1,175,708
//   v1-only  `event`                            25,355
//   dual     `event`+`attributes`                  978   ← the CTL-1795 superset
//   v3-only  `name`                               532
//   ────────────────────────────────────────────────────
//   sum                                      1,202,573   ← EQUALS total, exactly
//
// The shapes account for every line by arithmetic, so "no line lacks a
// discriminator" is a reconciliation rather than a separate query that could
// disagree with the others.
//
// POSITIVE CONTROLS (Codex rounds 5 + 18). Freezing the input prevents inter-query
// growth; it does NOT show that a predicate could have selected a defect. EVERY
// universal claim below was therefore re-run against a COPY of the snapshot with
// one known instance appended — and each control was run in ISOLATION, because a
// probe carrying two defects masks one behind the other (see the abort note):
//
//   dual-agreement          snapshot 978 AGREE / 0 DISAGREE
//                           probe    978 AGREE / 1 DISAGREE   ← selects it
//   unmodeled-combination   snapshot 0        probe 1         ← selects it
//   non-string `ts`         snapshot 0        probe 1         ← selects it
//   unparseable line        snapshot 0 torn   probe 1 torn    ← selects it
//
// ⚠️ METHODOLOGY CORRECTION from running the last one. The parse census must use a
// NON-ABORTING reader: `jq -c .` exits 5 at the first unparseable line, so every
// line after it goes uncounted. Measured — a probe with ONE bad line reported
// `torn=2`, because the abort also swallowed the valid line following it, and the
// bad-`ts` control run in the same probe found NOTHING because jq never reached it.
// `jq -R 'fromjson?'` is the correct instrument and gives torn=1 / torn=0.
//
// ⭐ That means the original `jq -c .` census was sound ONLY BECAUSE its answer was
// zero — an instrument that cannot count damage past the first instance cannot
// establish there is none. It is the same abort CTL-1809 records for
// `catalyst-events`' filter, hit here in the measurement rather than the pipeline.
// So the zeros are evidence now, and the method that produced them is stated.
//
// Two further invariants, same snapshot:
//   • `ts` is present and a string on 1,202,573 of 1,202,573 lines.
//   • All 978 dual lines AGREE between `.event` and `.attributes["event.name"]`
//     (consistent with CTL-1834's all-files census: 322/322 agreed there).
//   • ZERO lines carry `name` alongside `event` or `attributes` — see the
//     classifyEnvelope note on why that combination is nonetheless unmodeled.
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
//   CI (the corpus test)        — the same structural rules, run against committed
//     REAL producer output plus an opt-in live-log scan. There is deliberately no
//     top-level KEY check in either polarity; see "THERE IS NO TOP-LEVEL KEY
//     CONTRACT" below for the two that were tried and measured false.
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

// Render a producer-controlled value for a message, BOUNDED (Codex round 20).
// Event names are producer-controlled and unbounded: a disagreeing dual envelope
// with two 1 MB names produced a 2,000,065-byte error string, written to stderr
// from the broker's and monitor's live-tail callbacks BEFORE routing. The
// sparse-warn gate limits how OFTEN a warning is emitted, never how BIG one is, so
// a single malformed record could stall both readers and flood the launchd/Alloy
// log surface the warning rides on. Same discipline as the peer torn detector,
// which has always bounded its output (`line.slice(0, 60)`).
const RENDER_MAX = 120;
function renderBounded(v) {
  let text;
  try {
    text = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  } catch {
    text = "<unrenderable>";
  }
  if (typeof text !== "string") text = String(text);
  return text.length <= RENDER_MAX
    ? text
    : `${text.slice(0, RENDER_MAX)}…<truncated, ${text.length} chars>`;
}

/**
 * Which envelope shape is this? Mirrors event-name.mjs's key set exactly —
 * if these two ever disagree about which keys carry a name, an event can be
 * classified as one shape and named from another.
 *
 * Returns "v1" | "v2" | "v3" | "dual" | "unknown".
 *
 * ⚠️ UNMODELED COMBINATION, known and deliberately left open (Codex round 4, P2,
 * deferred to CTL-1857). `name` alongside `event` or `attributes` collapses to
 * v1/v2 here, and validateEnvelope only cross-checks the v1+v2 pair — so
 * `{ts, event:"a", name:"b"}` validates clean and the vocabulary guard stays
 * green because both keys are already known. MEASURED on the frozen snapshot:
 * ZERO of 1,202,573 lines carry that combination, so there is no live instance;
 * it would arise during an envelope migration, which is exactly when a silent
 * pass is least affordable. Fix is to compare every discriminator present, not
 * only the modeled pair.
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

  // Measured universal (frozen snapshot): ts is a string on 1,202,573 of
  // 1,202,573 lines. Same snapshot as the header — no second census.
  if (!nonEmptyString(event.ts)) {
    errors.push("`ts` missing or not a non-empty string");
  }

  // Measured invariant (frozen snapshot): 978 of 978 dual lines agree, and the
  // predicate was positive-controlled (below). The dual writer
  // (canonical_dual_envelope_line) reads the name once and passes the same
  // string to both keys, so a disagreement means something else wrote the line.
  if (shape === "dual" && event.event !== event.attributes["event.name"]) {
    errors.push(
      `dual envelope disagrees: event=${renderBounded(event.event)} vs ` +
        `attributes["event.name"]=${renderBounded(event.attributes["event.name"])}`
    );
  }

  return { ok: errors.length === 0, shape, errors };
}

/**
 * Top-level keys not in the measured vocabulary. CI-only — see the header for
 * why this is deliberately not consulted on the read path.
 */
// ── THERE IS NO TOP-LEVEL KEY CONTRACT, IN EITHER DIRECTION (Codex 8 + 10) ──
//
// Two CI layers were tried here and both were falsified by measurement. Recording
// the negative result, because the next person will otherwise try the same thing.
//
// 1. An ALLOWLIST ("no unexpected keys"). Wrong because the key space is OPEN by
//    construction: otel-forward's `normalizeFlatEvent` iterates every key, promotes
//    those in its ATTR_MAP, and drops EVERYTHING ELSE into `body.payload`. Review
//    found two instances before the premise did — `orchestrator`/`worker` (jq-less
//    v1 fallback) and `quiet_ms`/`orch_id` (reap-intent) — each legitimate output
//    reported as drift. Even pure v2 carries producer-added keys (`channel`).
//
// 2. A COMPLETENESS check ("every canonical field present on v2"). Also wrong:
//    canonical fields are ADDITIVE, so absence is not a defect. MEASURED on the
//    frozen snapshot's 1,175,708 v2-only lines — `ts` 1,175,708 but `id` only
//    1,175,408, and `caused_by` (CTL-1135, explicitly "additive; null when
//    absent") is missing from real corpus lines.
//
// ⭐ So the key layer is GONE rather than narrowed a third time. What survives is
// what was measured and holds on 100% of lines, and it is already enforced by
// validateEnvelope above: `ts` is a non-empty string, a name resolves through one
// of the three keys, and a dual envelope's two names agree. Drift that can actually
// redden CI is SHAPE drift — a new envelope shape or a name that stops resolving —
// which this module's classification plus event-name-read-guard.test.mjs (CTL-1834)
// already cover. A key-level contract was never supportable; asserting one produced
// false positives on legitimate producer output for two review rounds.

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
    // Bounded a SECOND time at the write: renderBounded caps each value, this caps
    // the assembled line, so a future error string built without renderBounded
    // still cannot emit an unbounded warning.
    const detail = errors.join("; ");
    const bounded =
      detail.length <= 400 ? detail : `${detail.slice(0, 400)}…<truncated, ${detail.length} chars>`;
    process.stderr.write(
      `[catalyst] WARNING: MALFORMED event envelope — counted and skipped ` +
        `(malformed_events_total=${malformedTotal}, shape=${shape}): ${bounded}\n`
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
