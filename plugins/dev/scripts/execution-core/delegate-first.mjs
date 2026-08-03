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

const VALID_MODES = new Set(["off", "shadow", "enforce"]);

// readDelegateFirstMode — read CATALYST_DELEGATE_FIRST; default "off".
// Mirrors readBoardHealthConfig/CATALYST_RECOVERY_PASS parsing style.
export function readDelegateFirstMode(env = process.env) {
  const raw = env.CATALYST_DELEGATE_FIRST ?? "off";
  return VALID_MODES.has(raw) ? raw : "off";
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
    const labelled = labelNeedsHumanUnlessBeliefOwner(
      orchDir,
      ticket,
      applyLabel,
      { env, site, log: logArg, explanation }
    );
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
  const enqueue = deps.enqueue ?? enqueueDelegateIntent;
  const q = enqueue(
    ticket,
    { kind, phase: "recovery-pass", reason, boardContext, briefObj },
    deps
  );

  // Mirror enqueueRecoveryItemDelegate's `initiated` predicate: a fresh enqueue
  // OR an idempotent no-op both mean the delegate already owns the ticket.
  const initiated =
    q.enqueued || q.reason === "already-pending" || q.reason === "worker-live";

  if (initiated) {
    appendEvent({ name: "delegate.routed", ticket, site, reason: q.reason });
    return { routed: true, reason: q.reason };
  }

  // Fallback: queue-full / write-failed / no-orch-dir → label+explain
  appendEvent({ name: "delegate.route-fallback", ticket, site, reason: q.reason });
  const labelled = labelDirect();
  return { routed: false, labelled, reason: q.reason };
}
