// diagnostician.mjs — CTL-937: bounded stall-diagnostician wake wiring.
//
// This module is the wire between the belief store (CTL-933/934) and the
// diagnostician action. Each tick the daemon calls processDiagnosticianWakes(),
// which reads wake_diagnostician beliefs from beliefs.db for the CURRENT tick,
// applies the cooldown guard (by reading intent rows directly — no CTL-936
// reconciler dependency; we read the belief store DB directly per the spec),
// runs evidence capture for fresh wakes, records a wake-diagnostician intent,
// and — when R12 escalate_human also fired AND the prior intent is ineffective
// — SUPPLIES THE CAPTURED EVIDENCE for the escalation (returned in `escalated`).
//
// CTL-962: the diagnostician applies NO label. needs-human is owned by a single
// executor, beliefs/escalate.mjs, which reads the same R12 escalate_human
// beliefs and pages exactly once. The diagnostician only supplies the evidence
// envelope; escalate.mjs (called right after this in runTick) does the paging.
//
// ── Design choice: deterministic evidence-collector (v1), not a full agent ──
//
// CTL-828 specifies a single-shot LLM agent as the eventual diagnostician, but
// CTL-937 is the WAKE WIRING + EVIDENCE ENVELOPE + SECOND-LINE ORDERING — the
// core gap Appendix 2 identified is that the evidence exists on disk but is
// never captured. A deterministic evidence-collector v1:
//
//   1. Captures `claude logs <shortId>` output (the screen buffer that revealed
//      the "Unknown command" banner — the 2026-06-09 root cause in one command)
//   2. Reads the full job state.json (tempo/detail/needs — fields the daemon
//      never read even though they contained the diagnosis)
//   3. Packages this as a structured evidence envelope and records it on the
//      wake intent
//
// This is exactly the gap Appendix 2 identifies as the "minimal turn-zero gate"
// and is the precondition for the LLM pass (CTL-828) — the agent needs the
// evidence before it can interpret it. The v1 ships dark (CATALYST_DIAGNOSTICIAN
// default OFF), is structured to be upgraded (replace captureEvidence with an
// LLM call), and the intent/cooldown machinery is identical in both versions.
//
// Rationale for deterministic first cut (not spawning a full LLM agent here):
//   - Wake storms are blocked by the intent/cooldown; an LLM spawn per stuck
//     worker per tick is expensive and the rule guard is not yet proven.
//   - The evidence envelope is the observable outcome the operator needs NOW;
//     the LLM pass is post-evidence commentary that CTL-828 scopes separately.
//   - The interface (captureLogs injectable fake) makes the upgrade non-breaking.
//
// ── Gating ──────────────────────────────────────────────────────────────────
// CATALYST_DIAGNOSTICIAN=1 required. Default: OFF. Ships dark, enabled
// deliberately by the operator or test infrastructure.
//
// ── Cooldown ────────────────────────────────────────────────────────────────
// Cooldown = cfg.diag_cooldown_ms (default 10min, seeded by rules.mjs). The
// guard is enforced HERE by reading the intent table directly. R10 already
// enforces it at the belief level (wake_diagnostician is never derived when
// a recent intent exists), but we double-check at execution time in case the
// belief evaluation and this code ever run with a clock skew. Recording the
// intent is what makes R10's cooldown self-enforce across ticks.
//
// ── Second-line escalation (CTL-962: evidence only, no label) ─────────────────
// When BOTH:
//   (a) R12 escalate_human belief exists for the current tick, AND
//   (b) the wake-diagnostician intent for the subject is ineffective
//       (attempts >= max_attempts AND outcome IS NULL)
// the diagnostician CAPTURES fresh evidence and returns it in the result's
// `escalated` array. It does NOT apply needs-human — beliefs/escalate.mjs is the
// single label owner and pages off the same R12 beliefs. This ordering still
// means the machine always gets at least one pass before the human is paged, and
// the escalation carries the evidence the machine captured.

import { execSync } from "node:child_process";

// ── test reset hook (no-op: the boot-level de-dup set was removed in CTL-937 fix
// after review found it was declared but never .add()ed or .has()-checked)
export function __resetDiagnosticianForTests() {
  /* no-op — retained for test import compatibility */
}

// ── captureEvidence — deterministic evidence-collector (v1) ──────────────
//
// Captures the evidence surface for a stuck worker:
//   1. claude logs <shortId> — the rendered screen buffer
//   2. Full job state (tempo/detail/needs) from the injected readJobState
//
// Both sources are injectable for tests (no real process spawning in tests).
// The 'Unknown command' banner in logsOutput is the 2026-06-09 root cause.
function captureEvidence(subject, bgJobId, { captureLogs, readJobState } = {}) {
  const shortId = bgJobId; // subject's short ID (already resolved by the caller)

  // claude logs output — the screen buffer that reveals WHY the session is idle
  let logsOutput = null;
  try {
    logsOutput = captureLogs ? captureLogs(shortId) : defaultCaptureLogs(shortId);
  } catch (err) {
    logsOutput = `capture-failed: ${err?.message ?? err}`;
  }

  // Full job state (beyond what statJob reads)
  let jobState = null;
  try {
    jobState = readJobState ? readJobState(shortId) : null;
  } catch (err) {
    jobState = { error: String(err?.message ?? err) };
  }

  return {
    subject,
    shortId,
    logsOutput,
    jobState,
    capturedAt: Date.now(),
  };
}

// defaultCaptureLogs — real implementation for production (not used in tests).
// Runs `claude logs <shortId>` and returns stdout. If the CLI is absent or
// returns non-zero we capture the error text (still useful for diagnosis).
function defaultCaptureLogs(shortId) {
  try {
    return execSync(`claude logs ${shortId}`, {
      timeout: 10_000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    return `claude-logs-failed: ${err?.stderr ?? err?.message ?? err}`;
  }
}

// ── cooldownCheck — reads intent table to see if we're within the cooldown
// This is the execution-time guard (R10 is the belief-time guard; both fire).
function isWithinCooldown(db, subject, nowMs) {
  const row = db
    .query(
      `SELECT i.intent_id FROM intent i
       JOIN tick t ON t.tick_id = i.tick_id, cfg c
       WHERE c.key = 'diag_cooldown_ms'
         AND i.kind = 'wake-diagnostician'
         AND i.subject = ?
         AND ? - t.now_ms <= c.value_int`,
    )
    .get(subject, nowMs);
  return row != null;
}

// ── recordWakeIntent — inserts a wake-diagnostician intent row.
// This is what R10's "not recent_intent" check reads across ticks.
// Evidence is NOT stored here: the intent table has no evidence column.
// CTL-828 (LLM diagnostician) should add evidence_json to the schema.
function recordWakeIntent(db, tickId, subject, beliefId) {
  db.run(
    `INSERT INTO intent (tick_id, kind, subject, belief_id, postcondition, attempts, outcome)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      tickId,
      "wake-diagnostician",
      subject,
      beliefId ?? null,
      "diagnostician_ran", // postcondition the reconciler can verify
      1,
      null, // outcome is null until the diagnostician verifies resolution
    ],
  );
}

// ── isActionIneffective — checks whether the wake-diagnostician intent for
// the subject has exhausted its attempts (R11 condition, checked here at the
// action layer so the applyNeedsHuman decision is synchronous).
function isActionIneffective(db, subject) {
  const row = db
    .query(
      `SELECT i.intent_id, i.attempts FROM intent i, cfg c
       WHERE c.key = 'max_attempts'
         AND i.kind = 'wake-diagnostician'
         AND i.subject = ?
         AND i.attempts >= c.value_int
         AND i.outcome IS NULL`,
    )
    .get(subject);
  return row != null;
}

// ── processDiagnosticianWakes — the per-tick entry point ─────────────────
//
// Called once per scheduler tick, AFTER evaluateBeliefs() has run for tickId.
// Reads wake_diagnostician beliefs for the current tick, applies cooldown and
// gating guards, runs evidence capture, records intents, and escalates to
// needs-human when R12 also fired and the prior action is ineffective.
//
// Parameters:
//   db        — the beliefs.db Database (bun:sqlite), already open
//   tickId    — the current tick's tick_id (inserted by the collector)
//   opts      — {
//     env              : Record<string,string>    (process.env in production)
//     captureLogs      : (shortId) => string      (injectable for tests)
//     readJobState     : (bgJobId) => object      (injectable for tests)
//   }
//   (CTL-962: applyNeedsHuman removed — escalate.mjs is the single label owner.)
//
// Returns: { skipped, ran, cooled, escalated } (never throws — failures logged).
//   ran[]       — fresh wakes the diagnostician processed this tick (evidence)
//   escalated[] — subjects whose R12 escalation fired; carries the captured
//                 evidence so the operator-facing path (escalate.mjs) and any
//                 audit can read what the machine saw. NO label is applied here.
export function processDiagnosticianWakes(db, tickId, opts = {}) {
  const env = opts.env ?? process.env;

  // ── gate: CATALYST_DIAGNOSTICIAN=1 required ────────────────────────────
  if ((env.CATALYST_DIAGNOSTICIAN ?? "0") !== "1") {
    return { skipped: "disabled" };
  }

  const ran = [];
  const cooled = [];
  const escalated = []; // CTL-962: subjects whose R12 fired, with captured evidence
  const errors = [];

  try {
    // Read the current tick's now_ms for cooldown arithmetic
    const tickRow = db.query("SELECT now_ms FROM tick WHERE tick_id = ?").get(tickId);
    if (!tickRow) return { skipped: "no-tick" };
    const nowMs = tickRow.now_ms;

    // Read wake_diagnostician beliefs for this tick
    const wakeBeliefs = db
      .query(
        "SELECT * FROM belief WHERE tick_id = ? AND name = 'wake_diagnostician'",
      )
      .all(tickId);

    // Read escalate_human beliefs for this tick (R12 — second-line guard)
    const humanBeliefs = new Set(
      db
        .query(
          "SELECT subject FROM belief WHERE tick_id = ? AND name = 'escalate_human'",
        )
        .all(tickId)
        .map((r) => r.subject),
    );

    for (const wb of wakeBeliefs) {
      const subject = wb.subject;
      const reason = (() => {
        try {
          return JSON.parse(wb.value ?? "{}").reason ?? "unknown";
        } catch {
          return "unknown";
        }
      })();

      try {
        // ── escalate_human check (R12): if the belief fired AND the prior
        // action is ineffective, CAPTURE EVIDENCE for the escalation (the second
        // line) and continue. CTL-962: the diagnostician applies NO label — it
        // only supplies evidence; beliefs/escalate.mjs (called right after this
        // in runTick) is the single owner of the needs-human label and pages off
        // the same R12 beliefs exactly once.
        if (humanBeliefs.has(subject) && isActionIneffective(db, subject)) {
          // Capture evidence for the escalation (re-captures fresh state)
          const bgJobId = extractShortId(db, tickId, subject);
          const evidence = captureEvidence(subject, bgJobId, opts);
          evidence.reason = reason;
          escalated.push({ subject, reason, evidence });
          // Do not run the diagnostician again for this subject this tick
          // (it already ran; this is the second line firing — evidence only).
          continue;
        }

        // ── cooldown check: skip if within diag_cooldown_ms ───────────────
        if (isWithinCooldown(db, subject, nowMs)) {
          cooled.push(subject);
          continue;
        }

        // ── evidence capture ───────────────────────────────────────────────
        const bgJobId = extractShortId(db, tickId, subject);
        const evidence = captureEvidence(subject, bgJobId, opts);
        evidence.reason = reason;

        // ── record wake intent (the cooldown key for R10 and isWithinCooldown)
        recordWakeIntent(db, tickId, subject, wb.belief_id);

        ran.push({
          subject,
          reason,
          evidence,
          beliefId: wb.belief_id,
        });
      } catch (subjectErr) {
        errors.push({ subject, err: String(subjectErr?.message ?? subjectErr) });
      }
    }
  } catch (err) {
    errors.push({ phase: "outer", err: String(err?.message ?? err) });
  }

  return { ran, cooled, escalated, errors: errors.length ? errors : undefined };
}

// ── extractShortId — resolve the bg_job_id / short_id for a subject ──────
// subject is "TICKET/phase". We join obs_signal → obs_agent to get the
// short_id that 'claude logs <shortId>' accepts.
function extractShortId(db, tickId, subject) {
  const [ticket, phase] = subject.split("/");
  if (!ticket || !phase) return subject;

  // Try obs_signal first (bg_job_id is already the short_id in the schema)
  const sigRow = db
    .query(
      "SELECT bg_job_id FROM obs_signal WHERE tick_id = ? AND ticket = ? AND phase = ?",
    )
    .get(tickId, ticket, phase);
  return sigRow?.bg_job_id ?? subject;
}
