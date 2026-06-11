// use-respond.ts — the React adapter around the HOME5 write path (CTL-903). The
// PURE write client + the optimistic-rollback math live in board/respond-client.ts
// (unit-tested without a DOM); this thin hook owns ONLY the React state the
// surface needs: which rows are optimistically `resuming`, which just failed to
// take ("it didn't take"), the verb's onClick, and the grace-window reconcile
// against the current inbox order.
//
// The contract it gives the surface:
//   • respond(ticket, note) — fire the verb. On a `resuming` outcome the row is
//     marked optimistically (the verb hides, a `resuming…` affordance shows). On
//     a `rejected` / `not_held` outcome the row is flagged so the surface can tell
//     the operator it did not take — the verb is NEVER hidden on a non-resume.
//   • markFor(ticket) / didNotTake(ticket) — per-row status the components read to
//     render the optimistic state without re-deriving it.
//   • reconcile(stillWaitingIds) — called every read-model frame: drops marks
//     whose row cleared (the resume took), and rolls back marks still waiting past
//     the grace window (the resume did NOT take → the verb returns + "it didn't
//     take").
//
// FENCE-AWARENESS is entirely server-side (single-host is an identity no-op pass);
// a multi-node fence rejection simply arrives as a `rejected` outcome here.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  reconcileMarks,
  respondTicket,
  ROLLBACK_GRACE_MS,
  type OptimisticMark,
  type RespondOutcome,
} from "../board/respond-client";

/** Per-row optimistic status the components render. */
export type RespondRowStatus = "idle" | "resuming" | "did-not-take";

export interface UseRespond {
  /** Fire the verb for a row: record the note + resume the agent. Returns the
   *  outcome so a caller can react (e.g. close a dialog) — the hook already
   *  applied the optimistic state. */
  respond: (ticket: string, note: string) => Promise<RespondOutcome>;
  /** The optimistic status for a row (resuming / did-not-take / idle). */
  statusFor: (ticket: string) => RespondRowStatus;
  /** Reconcile the in-flight marks against the CURRENT frame's still-waiting set
   *  (drops cleared marks, rolls back expired ones). Idempotent; call per frame. */
  reconcile: (stillWaitingIds: ReadonlySet<string>) => void;
}

/**
 * Own the optimistic-resume state for the Inbox verbs. `respondImpl` is injected
 * for tests (defaults to the real `respondTicket`); a `now()` clock + the grace
 * window are likewise injectable so the rollback timing is testable without
 * wall-clock waits.
 */
export function useRespond(
  {
    respondImpl = respondTicket,
    now = () => Date.now(),
  }: {
    respondImpl?: typeof respondTicket;
    now?: () => number;
  } = {},
): UseRespond {
  // Marks in flight (optimistically `resuming`) + the ids that just failed to
  // take. Held in refs mirrored to state so the grace timer reads fresh values
  // without re-subscribing, while the components re-render on change.
  const [marks, setMarks] = useState<OptimisticMark[]>([]);
  const [didNotTake, setDidNotTake] = useState<ReadonlySet<string>>(new Set());
  const marksRef = useRef<OptimisticMark[]>(marks);
  marksRef.current = marks;
  const stillWaitingRef = useRef<ReadonlySet<string>>(new Set());

  const applyReconcile = useCallback(
    (stillWaitingIds: ReadonlySet<string>) => {
      stillWaitingRef.current = stillWaitingIds;
      const { marks: surviving, rollBack } = reconcileMarks({
        marks: marksRef.current,
        stillWaitingIds,
        now: now(),
      });
      if (surviving.length !== marksRef.current.length) setMarks(surviving);
      if (rollBack.length > 0) {
        setDidNotTake((prev) => {
          const next = new Set(prev);
          for (const id of rollBack) next.add(id);
          return next;
        });
      }
    },
    [now],
  );

  const respond = useCallback(
    async (ticket: string, note: string): Promise<RespondOutcome> => {
      // Clear any prior "did not take" flag for this ticket as the operator retries.
      setDidNotTake((prev) => {
        if (!prev.has(ticket)) return prev;
        const next = new Set(prev);
        next.delete(ticket);
        return next;
      });
      const outcome = await respondImpl({ ticket, response: note });
      if (outcome.status === "resuming") {
        // Optimistically mark the row resuming + arm the grace window.
        setMarks((prev) => [
          ...prev.filter((m) => m.ticket !== ticket),
          { ticket, markedAt: now() },
        ]);
      } else {
        // not_held / rejected → the write did NOT act; tell the operator it did
        // not take (the verb stays put — never a false resume).
        setDidNotTake((prev) => {
          const next = new Set(prev);
          next.add(ticket);
          return next;
        });
      }
      return outcome;
    },
    [respondImpl, now],
  );

  // The grace-window timer: while any mark is in flight, re-reconcile against the
  // last-seen still-waiting set so an item that never cleared rolls back even if
  // no new board frame arrives within the window.
  useEffect(() => {
    if (marks.length === 0) return;
    const id = setInterval(() => applyReconcile(stillWaitingRef.current), ROLLBACK_GRACE_MS);
    return () => clearInterval(id);
  }, [marks.length, applyReconcile]);

  const statusFor = useCallback(
    (ticket: string): RespondRowStatus => {
      if (marks.some((m) => m.ticket === ticket)) return "resuming";
      if (didNotTake.has(ticket)) return "did-not-take";
      return "idle";
    },
    [marks, didNotTake],
  );

  return { respond, statusFor, reconcile: applyReconcile };
}
