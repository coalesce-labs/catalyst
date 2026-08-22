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
//   off / shadow   → { routed:false, labelled:<bool>, stallClass:<string|null>, [shadow:true] }
//   enforce+ok     → { routed:true, reason:<string> }
//   enforce+fallback → { routed:false, labelled:<bool>, stallClass:<string|null>, reason:<string> }
//
// `stallClass` is the CTL-2158 verdict the publish produced ("system"|"ask"|
// "moot"|"held"), or null when nothing was published (belief-owner deferral,
// marker no-op, or a routed intent). Callers that write a HUMAN-facing record off
// this result MUST gate on it via escalationIsHumanFacing — `labelled` is a retry
// contract and is true for a provider outage too.
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

  // helper: call the Phase-1 label chokepoint and return { labelled, stallClass }
  //
  // CTL-2159: the CLASS is carried out alongside the boolean because the boolean
  // alone is a RETRY contract — it is true for a provider outage too. Four
  // scheduler call sites read it and emitted a durable per-ticket
  // `worker.transition { toDisposition:"needs-human" }`; without the class they
  // would keep writing that record for exactly the SYSTEM stalls this epic
  // stopped labelling, moving the artifact one layer down instead of deleting it.
  let lastStallClass = null;
  const labelDirect = () => {
    const labelled = labelNeedsHumanUnlessBeliefOwner(orchDir, ticket, applyLabel, {
      env,
      site,
      log: logArg,
      explanation,
      onOutcome: (o) => {
        lastStallClass = o?.stallClass ?? null;
      },
      // ⛔ CTL-2159: forward the reason. All six escalation sites that reach the
      // label ONLY through this seam already compute one (`dispatch-circuit-
      // breaker:N`, `triage-redispatch-cap`, `unresolvable-conflict`, …) and it
      // was dropped here. Without it the classifier sees no reason and returns
      // HELD for every one of them — including scheduler.mjs:9294, the volume
      // producer — so the SYSTEM retry/alert path would never fire and this
      // phase would ship inert while passing its own tests.
      reason,
    });
    return labelled;
  };

  // ── off: byte-identical to Phase 1 ────────────────────────────────────────
  if (mode === "off") {
    const labelled = labelDirect();
    return { routed: false, labelled, stallClass: lastStallClass };
  }

  // ── shadow: log would-route, do NOT enqueue, DO label ─────────────────────
  if (mode === "shadow") {
    appendEvent({ name: "delegate.would-route", ticket, site, reason });
    const labelled = labelDirect();
    return { routed: false, shadow: true, labelled, stallClass: lastStallClass };
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
    return { routed: false, labelled, stallClass: lastStallClass, reason: "runner-disabled" };
  }

  const enqueue = deps.enqueue ?? enqueueDelegateIntent;
  const q = enqueue(ticket, { kind, phase: "recovery-pass", reason, boardContext, briefObj }, deps);

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
  return { routed: false, labelled, stallClass: lastStallClass, reason: q.reason };
}
