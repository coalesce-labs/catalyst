// worker-label.mjs — CTL-1481: best-effort `worker:<host>` label stamp on a
// cluster claim-win.
//
// VISIBILITY PROJECTION, NEVER THE CLAIM ARBITER. The claim/fence soft-CAS +
// generation stay entirely on cluster-claim.mjs / the #2553 event-log fence;
// this module's only job is to make the winning host's ownership visible on
// the Linear board via a single-select `worker` label group (sibling
// convention to the `type`/`worker-status` groups), so a human scanning the
// board can see which host is driving a ticket. A failure here (read, remove,
// or apply) never blocks, retries, or reverses the claim — it only means the
// board's label goes stale until the next claim-win re-stamps it.
//
// Linear enforces the `worker` group as an EXCLUSIVE single-select child set
// server-side: applying a second child to an already-labeled ticket is
// REJECTED ("labelIds not exclusive child labels" — write-tested 2026-07-14).
// So a swap from one host's label to another's is never a single mutation —
// it is always remove-old-then-add-new, exactly the two-step
// convergeHeldLabel/convergeDispositionLabel already use for the sibling
// worker-status group (scheduler.mjs).
//
// Steady state (the ticket already carries `worker:<hostName>` and no other
// group member) costs exactly ONE live read and ZERO writes.

import { readTicketLabelNodes } from "./linear-query.mjs";
import {
  applyLabel as defaultApplyLabel,
  removeLabel as defaultRemoveLabel,
} from "./linear-write.mjs";

// WORKER_LABEL_GROUP — the workspace-level label group's own name (matched by
// name + parent==null, per the #2631 isGroup gotcha). Provisioned by
// setup-execution-core-states.sh (which necessarily duplicates the string —
// bash), asserted by doctor.mjs checkWorkerLabels (which imports it from here).
export const WORKER_LABEL_GROUP = "worker";

// WORKER_LABEL_PREFIX — the shared prefix for the per-host children of the
// workspace `worker` label group. A ticket's desired label is always
// `${WORKER_LABEL_PREFIX}${hostName}`.
export const WORKER_LABEL_PREFIX = "worker:";

// stampWorkerLabel — apply `worker:<hostName>` to `ticket`, removing any OTHER
// `worker:*` label first (remove-before-add: Linear rejects a second
// exclusive-group child in one apply). The entire body is wrapped so this
// function NEVER throws — a claim-win call site can invoke it bare, wrapping
// only its own best-effort try/catch around the call (mirrors linear-write.mjs's
// applyLabel/removeLabel swallow discipline).
//
// Returns { stamped: true } once `worker:<hostName>` is confirmed present
// (already-present counts — zero writes at steady state), or
// { stamped: false, reason } on a read failure ("read-failed"), a foreign-label
// removal failure/throw ("remove-failed"), or an apply failure/throw
// ("apply-threw" or applyLabel's own reason string).
//
// `readLabelNodes`/`applyLabel`/`removeLabel` are injectable (tests fake them);
// production defaults to the real linear-query.mjs/linear-write.mjs functions —
// `readLabelNodes` is a LIVE read (labels are not yet served by the replica).
// `log` is an optional injectable logger (default null — no-op) so a bare test
// call needs no logger stub.
export function stampWorkerLabel({
  ticket,
  hostName,
  readLabelNodes = readTicketLabelNodes,
  applyLabel = defaultApplyLabel,
  removeLabel = defaultRemoveLabel,
  log = null,
} = {}) {
  try {
    const desired = `${WORKER_LABEL_PREFIX}${hostName}`;
    const read = readLabelNodes(ticket);
    if (!read?.ok || !Array.isArray(read.nodes)) {
      log?.warn?.(
        { ticket, hostName },
        "worker-label: label read failed — skipping stamp (no writes; cannot safely swap)"
      );
      return { stamped: false, reason: "read-failed" };
    }
    const nodes = read.nodes;
    // Remove BEFORE add: Linear rejects a second exclusive-group child in one
    // apply, so any foreign `worker:*` sibling must be cleared first.
    const foreign = nodes.filter(
      (n) =>
        typeof n?.name === "string" &&
        n.name.startsWith(WORKER_LABEL_PREFIX) &&
        n.name !== desired
    );
    const applyIfAbsent = () => {
      if (nodes.some((n) => n?.name === desired)) {
        return { stamped: true };
      }
      let applyRes;
      try {
        applyRes = applyLabel({ ticket, label: desired });
      } catch (err) {
        log?.warn?.(
          { ticket, label: desired, err: err.message },
          "worker-label: applyLabel threw — swallowed"
        );
        return { stamped: false, reason: "apply-threw" };
      }
      if (applyRes?.applied) {
        return { stamped: true };
      }
      log?.warn?.(
        { ticket, label: desired, reason: applyRes?.reason },
        "worker-label: applyLabel failed"
      );
      return { stamped: false, reason: applyRes?.reason ?? "apply-failed" };
    };
    // Sequential remove→confirm→next→apply chain. removeLabel (linear-write.mjs)
    // is declared `async` with an entirely spawnSync-synchronous body — the
    // mutation has already landed or failed by the time it returns; only the
    // RESULT is promise-wrapped. Mirror clearStalledLabel's thenable-aware
    // confirmation (CTL-764 round-5): a plain-object result (test fakes) is
    // confirmed inline; a thenable result is confirmed on a microtask, so the
    // apply still happens strictly AFTER a CONFIRMED remove and a failed remove
    // aborts the stamp in production too (never leaves the exclusive group with
    // an apply Linear would reject).
    const removeThenContinue = (idx) => {
      if (idx >= foreign.length) return applyIfAbsent();
      const node = foreign[idx];
      let res;
      try {
        res = removeLabel(ticket, node.name);
      } catch (err) {
        log?.warn?.(
          { ticket, label: node.name, err: err.message },
          "worker-label: removeLabel threw — stamp aborted (no apply)"
        );
        return { stamped: false, reason: "remove-failed" };
      }
      const confirm = (r) => {
        if (r?.removed === false) {
          log?.warn?.(
            { ticket, label: node.name, reason: r.reason },
            "worker-label: removeLabel failed — stamp aborted (no apply)"
          );
          return { stamped: false, reason: "remove-failed" };
        }
        return removeThenContinue(idx + 1);
      };
      if (res && typeof res.then === "function") {
        res.then(confirm).catch((err) =>
          log?.warn?.(
            { ticket, label: node.name, err: err?.message },
            "worker-label: removeLabel rejected — stamp aborted (no apply)"
          )
        );
        // The swap completes on a microtask; the sync caller only learns it was
        // deferred. Best-effort projection — the outcome is logged, not returned.
        return { stamped: false, reason: "swap-deferred" };
      }
      return confirm(res);
    };
    return removeThenContinue(0);
  } catch (err) {
    log?.warn?.(
      { ticket, hostName, err: err?.message },
      "worker-label: stampWorkerLabel threw — swallowed"
    );
    return { stamped: false, reason: "threw" };
  }
}
