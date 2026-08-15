// delegate-first.mjs — CTL-1609 Gap 1: delegate-first escalation routing seam.
//
// Introduces routeStuckTicketToDelegate, a thin gate that—when
// CATALYST_DELEGATE_FIRST=enforce—enqueues a stuck ticket to the delegate
// runner instead of immediately labelling needs-human.  With the flag off or
// unset the call is byte-identical to the direct Phase-1 chokepoint, so all
// six sites can be rewired without changing live behaviour.
//
// Ordered fallback: (auto-fix [deferred]) → delegate → human.
import { enqueueDelegateIntent } from "./delegate-queue.mjs";
import { createConfiguredBlockedGhostProbe } from "./blocked-ghost.mjs";
import { labelNeedsHumanUnlessBeliefOwner } from "./label-guard.mjs";
import { readDelegateRunnerConfig, readDelegateFirstConfig } from "./config.mjs";

// readDelegateFirstMode — env → Layer-2 → "off". Delegates to the config-ladder
// reader in config.mjs (CTL-1774 Gap B fix). The (env = process.env) injection
// contract is preserved: all existing callers that pass an explicit env bag still work.
export function readDelegateFirstMode(env = process.env) {
  return readDelegateFirstConfig(env).mode;
}

// ── routeStuckTicketToDelegate ────────────────────────────────────────────────
//
// Single seam replacing direct labelNeedsHumanUnlessBeliefOwner calls at the
// six escalation sites (not `attempts-exhausted`, which is post-delegate by
// definition).
//
// Params:
//   orchDir       — the orchestrator working directory
//   ticket        — ticket identifier
//   opts:
//     site          — caller identifier ("terminal-sweep", "dispatch-failures", …)
//     kind          — intent kind (default "board-health")
//     reason        — short string reason for the escalation
//     boardContext  — structured context object for the delegate brief
//     briefObj      — optional per-item brief (kind:"recovery-item")
//     explanation   — structured explanation for Phase-1 label chokepoint
//     deps          — passed through to enqueueDelegateIntent; add
//                     `enqueue` key to override the queue function in tests
//     applyLabel    — writeStatus object ({ applyLabel }) passed to Phase-1
//     env           — process.env override (for tests / injection)
//     log           — logger override
//     appendEvent   — injectable event emitter (default: no-op; Phase-3 wires real)
//
// Returns:
//   off / shadow   → { routed:false, labelled:<bool>, [shadow:true] }
//   enforce+ok     → { routed:true, reason:<string> }
//   enforce+fallback → { routed:false, labelled:<bool>, reason:<string> }
//
export function routeStuckTicketToDelegate(
  orchDir,
  ticket,
  {
    site = "unknown",
    kind = "board-health",
    reason = null,
    boardContext = null,
    briefObj = null,
    explanation = undefined,
    deps = {},
    applyLabel,
    env = process.env,
    log: logArg = null,
    appendEvent = () => {},
  } = {}
) {
  const mode = readDelegateFirstMode(env);

  // helper: call the Phase-1 label chokepoint and return { labelled: bool }
  const labelDirect = () => {
    const labelled = labelNeedsHumanUnlessBeliefOwner(orchDir, ticket, applyLabel, {
      env,
      site,
      log: logArg,
      explanation,
    });
    return labelled;
  };

  // ── off: byte-identical to Phase 1 ────────────────────────────────────────
  if (mode === "off") {
    const labelled = labelDirect();
    return { routed: false, labelled };
  }

  // ── shadow: log would-route, do NOT enqueue, DO label ─────────────────────
  if (mode === "shadow") {
    appendEvent({ name: "delegate.would-route", ticket, site, reason });
    const labelled = labelDirect();
    return { routed: false, shadow: true, labelled };
  }

  // ── enforce: enqueue to delegate, fall back to label on failure ───────────
  //
  // FAIL-SAFE GATE (Codex P1). Suppressing `needs-human` is only sound when
  // something will actually drain the queue. `readDelegateRunnerConfig` couples the
  // runner's default to CATALYST_BOARD_HEALTH / CATALYST_RECOVERY_PASS being
  // `enforce` — it knows nothing about CATALYST_DELEGATE_FIRST. So an operator who
  // lights ONLY this flag would get intents that queue forever (holding slot
  // reservations) with the label suppressed and no human ever told: a silent
  // black hole exactly where the escalation safety net is supposed to be.
  //
  // We refuse to route rather than auto-enabling the runner, because auto-enabling
  // would change behavior for pathways nobody opted into. Escalate loudly instead
  // of going quiet: fall through to the label.
  const readRunnerConfig = deps.readRunnerConfig ?? readDelegateRunnerConfig;
  if (readRunnerConfig(env).mode !== "on") {
    appendEvent({ name: "delegate.route-fallback", ticket, site, reason: "runner-disabled" });
    const labelled = labelDirect();
    return { routed: false, labelled, reason: "runner-disabled" };
  }

  const enqueue = deps.enqueue ?? enqueueDelegateIntent;
  // Arm the enqueue-side worker-live dedup seam too. Without this, enforce
  // mode can still let a terminal blocked listing suppress the replacement
  // intent before the runner or scheduler gets a chance to reclaim it.
  const enqueueDeps = deps.isBgJobAlive
    ? deps
    : { ...deps, isBgJobAlive: createConfiguredBlockedGhostProbe({ env }) };
  const q = enqueue(
    ticket,
    { kind, phase: "recovery-pass", reason, boardContext, briefObj },
    enqueueDeps
  );

  // Mirror enqueueRecoveryItemDelegate's `initiated` predicate: a fresh enqueue
  // OR an idempotent no-op both mean the delegate already owns the ticket.
  const initiated = q.enqueued || q.reason === "already-pending" || q.reason === "worker-live";

  if (initiated) {
    appendEvent({ name: "delegate.routed", ticket, site, reason: q.reason });
    return { routed: true, reason: q.reason };
  }

  // Fallback: queue-full / write-failed / no-orch-dir → label+explain
  appendEvent({ name: "delegate.route-fallback", ticket, site, reason: q.reason });
  const labelled = labelDirect();
  return { routed: false, labelled, reason: q.reason };
}
