// escalation-publish.mjs — CTL-2159. THE publication chokepoint.
//
// ⛔ WHAT CHANGED, IN ONE SENTENCE: every escalation producer used to publish the
// same artifact — the Linear `needs-human` label — regardless of WHY the ticket
// stalled; now the CTL-2158 classifier decides, and only a genuine ASK gets a
// per-ticket human artifact.
//
// The measurement that forced this: of 86 items flagged as waiting on a human, 3
// genuinely were. 41 were the model provider being overloaded, escalated one
// ticket at a time — because the label is a single bit and a provider outage and
// a product decision both set it.
//
// ── THE PUBLICATION TABLE ────────────────────────────────────────────────────
//
//   class   Linear per-ticket artifact          local record        published?
//   ─────   ─────────────────────────────────   ─────────────────   ──────────
//   SYSTEM  NONE. The fleet alert (CTL-2156)    once-marker +       yes
//           already covers the condition; the   `stallClass` stamp
//           ticket retries with backoff.
//   ASK     ONE ask ticket carrying `blocks`    once-marker +       yes, iff the
//           to the work (CTL-2157).             stamp + askTicket   ask landed
//   MOOT    NONE. Nothing is left to do.        once-marker + stamp yes
//   HELD    NONE. ⛔ NOT silent: the unstuck     once-marker + stamp yes
//           sweep's escalate branch is left
//           deliberately un-gated so a person
//           still sees it (see below).
//
// ── ⛔ THE THREE THINGS THAT WILL BREAK IF YOU "SIMPLIFY" THIS ────────────────
//
// 1. THE RETURN VALUE IS A RETRY CONTRACT, NOT A COSMETIC BOOLEAN. Five call
//    sites read it to decide whether a retry loop STOPS:
//      • recovery.mjs:3149    → labelApplied gates the 10-min escalation
//        cooldown. A permanently-false return re-fires the write every tick up
//        to LABEL_CONFIRM_CAP — the CTL-638 storm, ~28 writes/min against a
//        shared 2500/hr Linear quota.
//      • monitor.mjs:1215     → the triage re-dispatch cap's STOP. False here
//        and triage re-dispatch becomes unbounded.
//      • stale-pr-rescue-timer.mjs:488 → `rescue.json.escalatedAt` latches ONLY
//        on a confirmed publish. Never true ⇒ re-escalates every tick forever.
//      • boot-resume.mjs:493  → INVERSE. The once-marker SUPPRESSES auto-resume
//        of a chronically-failing ticket. No marker ⇒ boot-resume silently
//        auto-retries it.
//      • delegate-first.mjs:70/113 → the publish and the delegate re-dispatch
//        are two arms of ONE branch; deleting either deletes the other.
//    So "publish" must stay TERMINAL-for-this-attempt and must keep writing the
//    same once-markers, even though it no longer touches a Linear label.
//
// 2. THE MARKER FILENAMES ARE LOAD-BEARING AND ARE DELIBERATELY UNCHANGED.
//    `workers/<T>/.linear-label-needs-human.{applied,skipped}` is read by
//    boot-resume.mjs:493 (auto-resume suppression), cleared by daemon.mjs:736
//    (comment-wake) and by label-guard's clearStalledLabel. Renaming them here
//    would silently change all three. The rename belongs to the consumer phase,
//    with those three readers moved in the same commit.
//
// 3. ⛔ `escalationPublished` IS STAMPED FOR **ASK ONLY**. That field silences the
//    unstuck sweep (stall-class.mjs::stallSweepDisposition). It means "a
//    per-ticket human artifact already exists; do not publish a second one" —
//    and for SYSTEM / MOOT / HELD no such artifact exists, so there is nothing
//    to duplicate. Stamping it for SYSTEM would be the tempting tidy version and
//    it is a silent regression: the terminal sweep escalates
//    `remediate-cycle-cap-exhausted` and `prior-artifact-retry-exhausted`
//    signals, which the sweep must KEEP repairing — stamping them silences the
//    repair while reading as a refactor. And HELD means "a person must look",
//    which is the opposite of "say nothing": the sweep's escalate branch is the
//    only thing that makes an unclassified stall visible at all.
//
// ── THE ANTI-MANUFACTURE RULE (audit finding (b)) ────────────────────────────
// The old path called `coerceExplanation(explanation ?? {}, { canExecute: false })`
// with canExecute HARDCODED false, so an unexplained worker death degraded to a
// fabricated DECISION card — "priority call the agent cannot make unilaterally".
// Deleting only the degrade branch would replace a manufactured DECISION with a
// manufactured AUTHORIZATION, which is still a per-ticket human artifact. The
// fix is here, at the call site: an explanation is written ONLY when the stall
// classifies ASK and the caller supplied a real one. Nothing is fabricated.
//
// ── WHY AN ASK CAN BE REFUSED ────────────────────────────────────────────────
// `ask.mjs create` needs a team, a title, a why, ≥2 options and a default. An
// escalation that cannot supply those cannot produce an ANSWERABLE ask — and a
// content-free ask is precisely the bin this epic deletes, wearing a nicer name
// (CTC-653 measured that every hand-filed ask on 2026-08-17 parsed to ZERO
// options and was structurally undecidable). So an ASK verdict with insufficient
// evidence is DOWNGRADED TO HELD rather than filed. Held is visible; an
// unanswerable ask is not.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log as defaultLog } from "./config.mjs";
import { coerceExplanation } from "./escalation-explanation.mjs";
import {
  classifyStall,
  stallClassSignalFields,
  STALL_CLASS,
  ESCALATION_PUBLISHED_FIELD,
} from "./stall-class.mjs";

// The marker label. Unchanged on purpose — see note 2 in the header.
export const ESCALATION_MARKER_LABEL = "needs-human";

/**
 * escalationIsHumanFacing — PURE. Did publishing this class put a per-ticket
 * HUMAN-FACING record on the board, or not?
 *
 * ⛔ WHY CALLERS MUST ASK. `publishEscalation` returns TRUE for every class,
 * because its boolean is a RETRY contract ("a disposition was published on this
 * call — stop retrying"), not a statement about human attention. Five call sites
 * used to read that same boolean as "a needs-human label landed" and emit a
 * `worker.transition { toDisposition:"needs-human" }` on the strength of it.
 * Left unchanged, every provider-overload stall would write a durable per-ticket
 * needs-human record — the exact artifact this epic deletes, moved one layer
 * down where the label sweep cannot see it.
 *
 * SYSTEM → false: the CTL-2156 fleet alert names the condition and the ticket
 *   retries by itself; a per-ticket human record is the fan-out we are removing.
 * MOOT   → false: nothing is left for anyone to do.
 * ASK    → true: an ask ticket exists and a person owns it.
 * HELD   → true: "a person must look" is the whole point of HELD; silencing it
 *   here would ship the plan's named worst outcome (no label, no ask, no alert).
 *
 * ⛔ THE FAIL DIRECTION IS THE CALLER'S CHOICE, AND THE TWO CALLERS DIFFER ON
 * PURPOSE. This predicate is fail-CLOSED on an unknown class (undefined → false),
 * which is right for the scheduler's `worker.transition` emits: a missing
 * telemetry record costs little and a false needs-human record is the artifact we
 * are deleting. The unstuck sweep's authored Linear comment inverts it — it
 * suppresses only on an EXPLICIT system/moot verdict — because that comment is
 * the last thing making an unclassified stall visible at all, and going quiet on
 * an absence of evidence would be the silent regression, not a tidy default.
 */
export function escalationIsHumanFacing(klass) {
  return klass === STALL_CLASS.ASK || klass === STALL_CLASS.HELD;
}

// Kill switch for the ask transport. `off` makes an ASK verdict behave exactly
// like HELD (recorded, visible, zero Linear writes) instead of filing. Infra as
// code: this is a config knob, never a code edit.
export function askTransportMode(env = process.env) {
  const raw = String((env ?? process.env).CATALYST_ESCALATION_ASK ?? "on")
    .trim()
    .toLowerCase();
  return raw === "off" || raw === "0" || raw === "false" ? "off" : "on";
}

/**
 * askFieldsFromExplanation — PURE. Derive `ask.mjs create` arguments from an
 * escalation explanation, or return null when the evidence cannot make an
 * ANSWERABLE ask.
 *
 * The floor is deliberately the same one `ask.mjs` documents: a why, at least
 * two labelled options, and a default if nobody answers. Below that floor we
 * return null and the caller downgrades to HELD.
 */
export function askFieldsFromExplanation(explanation, { ticket, site = null } = {}) {
  const e = explanation && typeof explanation === "object" ? explanation : null;
  if (e == null) return null;
  const team = typeof ticket === "string" ? ticket.split("-")[0] : null;
  if (!team) return null;

  const why = pickString(e.why_asking) ?? pickString(e.why_you) ?? pickString(e.problem);
  const title = pickString(e.call_to_action) ?? pickString(e.problem);
  if (!why || !title) return null;

  const options = Array.isArray(e.options)
    ? e.options
        .filter(
          (o) =>
            o && typeof o.label === "string" && o.label.trim() !== "" &&
            typeof o.tradeoff === "string" && o.tradeoff.trim() !== ""
        )
        .map((o) => `${o.label.trim()} — ${o.tradeoff.trim()}`)
    : [];
  if (options.length < 2) return null;

  const defaultIfSilent =
    pickString(e.recommendation) ?? pickString(e.authorize_label) ?? null;
  if (!defaultIfSilent) return null;

  return {
    team,
    title: clamp(title, 240),
    why: clamp(why, 2000),
    options,
    defaultIfSilent: clamp(defaultIfSilent, 500),
    blocks: [ticket],
    site,
  };
}

function pickString(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function clamp(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const ASK_CLI = fileURLToPath(new URL("../ask.mjs", import.meta.url));

/**
 * defaultFileAsk — shell out to the real `ask.mjs create` verb.
 *
 * ⛔ It is the REAL verb and not a re-implementation on purpose: `ask.mjs`
 * renders the body AND reads it back out of Linear to prove the decision
 * trigger can parse the options and that every `blocks` relation actually
 * landed (exit 2 when it did not). Re-deriving any of that here would be a
 * second copy to keep in step with the cloud-side parser.
 *
 * Returns { ok, terminal, reason } — `terminal` means "this can never land, do
 * not retry" and writes the permanent .skipped marker.
 */
export function defaultFileAsk(fields, { spawn = spawnSync, env = process.env } = {}) {
  const args = [
    ASK_CLI,
    "create",
    "--team", fields.team,
    "--title", fields.title,
    "--why", fields.why,
    "--default", fields.defaultIfSilent,
  ];
  for (const o of fields.options) args.push("--option", o);
  for (const b of fields.blocks) args.push("--blocks", b);
  let r;
  try {
    r = spawn(process.execPath, args, { encoding: "utf8", env });
  } catch (err) {
    return { ok: false, terminal: false, reason: `ask-spawn-threw:${err?.message ?? "unknown"}` };
  }
  const code = r?.status ?? 1;
  if (code === 0) return { ok: true, terminal: false, reason: "filed" };
  // exit 2 = the ask was created but a `blocks` relation could not be proven, or
  // the body stored unparseable. Both are OPERATOR problems, not transient ones:
  // retrying files a second ask. Terminal.
  if (code === 2) return { ok: false, terminal: true, reason: "ask-unverified" };
  return { ok: false, terminal: false, reason: `ask-exit-${code}` };
}


/**
 * explanationForStall — the anti-manufacture gate for the two scheduler stall
 * writers (audit finding (b)).
 *
 * Both used to end in `coerceExplanation(fields, { ticket, phase })` with NO
 * `canExecute`, which lands in the degrade branch's `else` and fabricates a
 * DECISION: "decide whether to retry, hand off, or cancel", two canned options,
 * "priority call the agent cannot make unilaterally". Deleting only that branch
 * is not the fix — the call sites would then fall into the AUTHORIZATION branch
 * and fabricate "approve continuation or cancel?" instead, which is still a
 * per-ticket human artifact for what is usually a provider outage.
 *
 * So the gate is the CLASS, not the template: a manufactured explanation is
 * produced ONLY when the stall independently classifies ASK. Everything else
 * gets `null` — no card, no question, nothing for a human to answer. A REAL
 * explanation the caller assembled is never touched by this function; callers
 * pass theirs through with `extra.explanation ?? explanationForStall(...)`.
 */
export function explanationForStall({
  fields = {},
  ticket = null,
  phase = null,
  reason = null,
  signal = null,
  classify = classifyStall,
} = {}) {
  const verdict = classify({ reason, signal, explanation: null, site: "stall-writer" });
  if (verdict.klass !== STALL_CLASS.ASK) return null;
  return coerceExplanation(fields, { ticket, phase });
}

/**
 * publishEscalation — classify the stall, publish the ONE artifact its class
 * calls for (or none), and record the outcome once per (ticket, daemon
 * lifetime).
 *
 * Returns TRUE when a disposition was published on THIS call. See header note 1
 * — five retry loops key on this.
 */
export function publishEscalation(
  orchDir,
  ticket,
  {
    env = process.env,
    site = "unknown",
    reason = null,
    signal = null,
    explanation = undefined,
    log: logArg = null,
    markerBase,
    classify = classifyStall,
    fileAsk = defaultFileAsk,
    emitEscalation = null,
    writeSignal = null,
    onOutcome = null,
    treatAlreadyPublishedAsLanded = false,
  } = {}
) {
  const base = markerBase;
  const alreadyPublished = existsSync(`${base}.applied`);
  if (alreadyPublished || existsSync(`${base}.skipped`)) {
    // Marker-guarded no-op — byte-identical to labelOnce's early return, EXCEPT
    // that it now reports the class already recorded for this ticket.
    //
    // ⛔ WHY THE CLASS MATTERS ON A NO-OP. Callers gate a per-ticket human artifact
    // on it (the unstuck sweep's authored Linear comment, the scheduler's
    // worker.transition). A later sweep over a still-stuck SYSTEM ticket reaches
    // this early return, and reporting `stallClass: null` there would read as "no
    // evidence" → fail-open → post the comment anyway. The verdict is on disk from
    // the first publish; handing it back is the difference between "SYSTEM stalls
    // write zero per-ticket artifacts" and "…zero, except on the second sweep".
    if (typeof onOutcome === "function") {
      onOutcome({
        deferred: false,
        applied: false,
        ran: false,
        reason: null,
        alreadyApplied: alreadyPublished,
        stallClass: signal?.stallClass ?? null,
      });
    }
    return treatAlreadyPublishedAsLanded && alreadyPublished;
  }

  const verdict = classify({
    reason: reason ?? signal?.stalledReason ?? signal?.failureReason ?? null,
    signal,
    explanation: explanation ?? null,
    site,
  });

  let klass = verdict.klass;
  let askTicket = null;
  let outcomeReason = verdict.rule;
  let terminal = false;

  if (klass === STALL_CLASS.ASK) {
    const fields =
      askTransportMode(env) === "off"
        ? null
        : askFieldsFromExplanation(explanation, { ticket, site });
    if (fields == null) {
      // ⛔ Downgrade, do not fabricate. See the header's "why an ask can be
      // refused". The ticket stays visible via HELD.
      klass = STALL_CLASS.HELD;
      outcomeReason =
        askTransportMode(env) === "off" ? "ask-transport-off" : "ask-evidence-insufficient";
    } else {
      const r = fileAsk(fields, { env });
      if (r?.ok === true) {
        askTicket = r.ticket ?? null;
        outcomeReason = "ask-filed";
      } else {
        terminal = r?.terminal === true;
        outcomeReason = r?.reason ?? "ask-failed";
        recordOutcome({
          onOutcome,
          applied: false,
          ran: true,
          reason: outcomeReason,
          alreadyApplied: false,
        });
        if (terminal) writeMarker(`${base}.skipped`, logArg, ticket);
        warn(logArg, { ticket, site, reason: outcomeReason },
          "escalation-publish: ask could not be filed — not published this call");
        return false;
      }
    }
  }

  // Record locally. This is the once-marker every retry loop keys on.
  writeMarker(`${base}.applied`, logArg, ticket);

  const fields = {
    ...stallClassSignalFields({ ...verdict, klass }),
    ...(klass === STALL_CLASS.ASK ? { [ESCALATION_PUBLISHED_FIELD]: true } : {}),
    ...(askTicket ? { askTicket } : {}),
  };
  if (typeof writeSignal === "function") {
    try {
      writeSignal({ ticket, klass, verdict, fields, explanation, site });
    } catch (err) {
      warn(logArg, { ticket, err: err?.message },
        "escalation-publish: signal write failed — continuing");
    }
  }

  if (typeof emitEscalation === "function") {
    try {
      emitEscalation(ticket, {
        site,
        reason: reason ?? explanation?.problem ?? null,
        stallClass: klass,
        stallRule: outcomeReason,
      });
    } catch {
      /* fail-open: observability must never block the escalation path */
    }
  }

  recordOutcome({ onOutcome, applied: true, ran: true, reason: outcomeReason, alreadyApplied: false, klass });
  return true;
}

function recordOutcome({ onOutcome, applied, ran, reason, alreadyApplied, klass = null }) {
  if (typeof onOutcome !== "function") return;
  onOutcome({ deferred: false, applied, ran, reason, alreadyApplied, stallClass: klass });
}

function writeMarker(path, logArg, ticket) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
  } catch (err) {
    warn(logArg, { ticket, path, err: err?.message },
      "escalation-publish: marker write failed — continuing");
  }
}

function warn(logArg, obj, msg) {
  try {
    const fn = typeof logArg?.warn === "function" ? logArg.warn.bind(logArg) : defaultLog.warn.bind(defaultLog);
    fn(obj, msg);
  } catch {
    /* logging must never block the escalation path */
  }
}
