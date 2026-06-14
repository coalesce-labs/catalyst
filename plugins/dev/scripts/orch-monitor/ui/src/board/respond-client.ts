// respond-client.ts — THE write path of the calm Inbox home (CTL-903 / HOME5).
// This is the only MUTATING path in HOME and the payoff of the whole Inbox: one
// bright verb on a needs-you row both RECORDS the operator's response AND RESUMES
// the paused agent. It is a React-/jotai-/router-free module (same pattern as
// home-inbox.ts / reading-pane-model.ts) so the orch-monitor `bun test` suite can
// unit it directly from outside the `ui/` module graph; the React surface that
// owns the optimistic state + the grace timer renders THROUGH it.
//
// IT DOES NOT OWN A BACKEND. The resume loop is CTL-876 and the write endpoint is
// the BFF12 read-model mutation route POST /api/ticket/<ticket>/respond
// (server.ts → lib/respond-ticket.mjs), both already merged. This module is the
// WEB ENTRY POINT: it calls that endpoint, maps its discriminated result to a
// closed outcome the surface acts on, and carries the optimistic-rollback math.
//
// FENCE-AWARENESS (the cluster Gherkin) lives ENTIRELY server-side: the endpoint
// passes the held run's generation through the cross-host fence-check and a
// single-host host set (hosts.json absent / length 1) is an exact identity no-op
// pass (it returns `resuming` with `fenceNoop:true`, zero added latency). The
// client never reads hosts.json and adds no cluster code on the hot path — a
// verified-stale / unconfirmable fence simply arrives as a 409 we surface as a
// `rejected` outcome (the write did NOT act). That keeps the single-node MVP an
// exact pass-through while the multi-node rejection rides for free.

import { isNeedsYouSection, type InboxRow } from "./home-inbox";

/** The kind of needs-you item a verb acts on — drives the verb word + accent.
 *  CTL-729: 'attention' is the single needs-attention bucket (waiting-on-you ∪
 *  needs-human) whose ONE bright verb is "Respond". */
export type VerbKind = "decision" | "blocked" | "attention";

/** The ONE bright primary verb a needs-you row carries (Direction A
 *  non-negotiable #3: "one primary verb per item"). Everything else
 *  (View-in-Claude / Snooze / Dismiss) is demoted to the overflow set below. */
export interface VerbAction {
  /** The ticket the verb acts on (e.g. "CTL-642"). */
  ticket: string;
  /** The bright verb word — "Respond" for an attention item, "Answer" for a
   *  decision, "Unblock" for a blocker. */
  verb: "Respond" | "Answer" | "Unblock";
  /** Which needs-you kind this is — drives the accent (attention/decision = yellow,
   *  blocked = red). */
  kind: VerbKind;
}

/** The demoted actions, kept OFF the bright button so the row stays calm — they
 *  live on hover / in the `⋯` overflow menu (Direction A: "demoted to hover /
 *  overflow"). This is the closed set the row's overflow renders. */
export const OVERFLOW_ACTIONS = ["View in Claude", "Snooze", "Dismiss"] as const;
type OverflowAction = (typeof OVERFLOW_ACTIONS)[number];

/**
 * The single primary verb action for a row, or null for the neutral
 * (running / done) sets which carry no action at all. A `waiting` item is a
 * decision → "Answer"; a `blocked` item → "Unblock". This is the SAME mapping
 * home-inbox.ts::verbFor uses for the row's verb label — re-derived here as a
 * typed action object the write path consumes (the label stays a string for the
 * bare row; the action carries the ticket + kind the verb's onClick needs).
 */
export function verbActionFor(row: InboxRow): VerbAction | null {
  if (!isNeedsYouSection(row.section)) return null;
  // CTL-729: the single needs-attention bucket — its ONE bright verb is "Respond"
  // (it covers both waiting-on-you and needs-human escalations).
  if (row.section === "attention") {
    return { ticket: row.id, verb: "Respond", kind: "attention" };
  }
  if (row.section === "blocked") {
    return { ticket: row.id, verb: "Unblock", kind: "blocked" };
  }
  // waiting (decision)
  return { ticket: row.id, verb: "Answer", kind: "decision" };
}

// ── the read-model write call ────────────────────────────────────────────────

/** The closed outcome the surface maps a respond call to. `resuming` =
 *  optimistically mark the row resuming + arm the rollback timer; `not_held` =
 *  nothing parked to answer (refresh, the row is stale); `rejected` = the write
 *  did NOT act (fence / confirm / network) — never mark the row resumed. */
export type RespondOutcome =
  | { status: "resuming"; ticket: string; phase: string; fenceNoop?: boolean }
  | { status: "not_held"; ticket: string }
  | {
      status: "rejected";
      ticket: string;
      /** Why it was rejected — drives the "it didn't take" surface copy. */
      reason: "fenced" | "fence_indeterminate" | "confirm_mismatch" | "error";
      message?: string;
    };

/** The verb's recorded note + the typed-confirm token. `confirm` defaults to the
 *  ticket id (the BFF12 typed-confirm gate: the operator confirms the ticket id),
 *  so the row's one-click verb does not force a second typed-confirm step — the
 *  detail/dialog path can still pass an explicit confirm if a workflow wants it. */
export interface RespondInput {
  ticket: string;
  /** The operator's answer / unblock note (the recorded human response). */
  response: string;
  /** Typed-confirm token; defaults to the ticket id. */
  confirm?: string;
}

interface RespondDeps {
  /** Injectable fetch so the unit tests drive every branch without a server. */
  fetchImpl?: typeof fetch;
}

/** The raw discriminated shape the BFF12 endpoint returns (respond-ticket.mjs). */
interface RespondServerResult {
  status?: string;
  ticket?: string;
  phase?: string;
  fenceNoop?: boolean;
  expected?: string;
  error?: string;
}

/**
 * Call the read-model write endpoint for a needs-you row's verb. POSTs the
 * operator's note + the typed-confirm to POST /api/ticket/<ticket>/respond and
 * maps the discriminated server result onto a `RespondOutcome`:
 *   • 200 resuming             → { resuming, ticket, phase } (mark optimistically)
 *   • 404 not_held             → { not_held } (nothing parked — refresh)
 *   • 409 fenced / fence_indet → { rejected, reason } (the write did NOT act)
 *   • 400 confirm_mismatch     → { rejected, reason: "confirm_mismatch" }
 *   • any throw / non-JSON     → { rejected, reason: "error" } (never a false resume)
 *
 * SINGLE-NODE: the success path is identical — the endpoint returns `resuming`
 * with `fenceNoop:true` (an identity fence no-op pass); the client adds no
 * cluster code on the hot path.
 */
export async function respondTicket(
  { ticket, response, confirm }: RespondInput,
  { fetchImpl = fetch }: RespondDeps = {},
): Promise<RespondOutcome> {
  const url = `/api/ticket/${encodeURIComponent(ticket)}/respond`;
  let raw: RespondServerResult;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response, confirm: confirm ?? ticket }),
    });
    raw = (await res.json()) as RespondServerResult;
  } catch (e) {
    // Network failure / non-JSON body → a hard rejection, never a false resume.
    return { status: "rejected", ticket, reason: "error", message: errMessage(e) };
  }

  switch (raw.status) {
    case "resuming":
      return {
        status: "resuming",
        ticket: raw.ticket ?? ticket,
        phase: raw.phase ?? "",
        fenceNoop: raw.fenceNoop === true,
      };
    case "not_held":
      return { status: "not_held", ticket: raw.ticket ?? ticket };
    case "fenced":
      return { status: "rejected", ticket: raw.ticket ?? ticket, reason: "fenced", message: raw.error };
    case "fence_indeterminate":
      return {
        status: "rejected",
        ticket: raw.ticket ?? ticket,
        reason: "fence_indeterminate",
        message: raw.error,
      };
    case "confirm_mismatch":
      return {
        status: "rejected",
        ticket: raw.ticket ?? ticket,
        reason: "confirm_mismatch",
        message: raw.error,
      };
    default:
      // Any unexpected status → treat as a rejection (conservative for a write).
      return { status: "rejected", ticket: raw.ticket ?? ticket, reason: "error", message: raw.error };
  }
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ── optimistic rollback ──────────────────────────────────────────────────────

/** The grace window before the optimistic `resuming` mark is re-checked against
 *  the next read-model frame — the SAME ~10s the detail-pages design (§3.4 / P10)
 *  prescribes for the Stop-worker mutation. After the response is recorded + the
 *  resume event emitted, the daemon re-dispatches and the held row should clear
 *  within this window; if it has NOT, the mark did not take and we roll back. */
export const ROLLBACK_GRACE_MS = 10_000;

/**
 * Decide whether an optimistic `resuming` mark must ROLL BACK, given the next
 * board frame. The mark rolls back ONLY when the item is STILL waiting AND the
 * grace window has elapsed — i.e. the resume did not take, so the row must
 * reappear and the operator be told it did not take. While the window is open we
 * hold the optimistic mark (the row legitimately still shows for a beat as the
 * daemon re-dispatches); once the item has CLEARED (left "What's waiting") the
 * mark held and there is nothing to roll back, regardless of elapsed time. PURE.
 */
export function shouldRollBack({
  stillWaiting,
  elapsedMs,
}: {
  /** Does the next read-model frame STILL carry this row as a needs-you item? */
  stillWaiting: boolean;
  /** Milliseconds since the optimistic mark was applied. */
  elapsedMs: number;
}): boolean {
  if (!stillWaiting) return false; // it cleared — the resume took (happy path).
  return elapsedMs >= ROLLBACK_GRACE_MS;
}

/** One optimistic mark in flight: a ticket whose verb succeeded (`resuming`) and
 *  the wall-clock instant it was marked, so the grace window can be measured. */
export interface OptimisticMark {
  ticket: string;
  /** Date.now() when the optimistic mark was applied. */
  markedAt: number;
}

/** The reconcile reducer's output: the marks that SURVIVE to the next render and
 *  the ticket ids to ROLL BACK (the resume did not take — the verb returns and
 *  the operator is told it did not take). */
export interface ReconcileResult {
  marks: OptimisticMark[];
  rollBack: string[];
}

/**
 * Reconcile the optimistic marks in flight against the next read-model frame —
 * the WHOLE scenario-5 loop as ONE pure step the React surface just applies on
 * every frame (and on a grace-window timer). For each mark:
 *   • the row CLEARED (id absent from `stillWaitingIds`) → the resume took: RETIRE
 *     the mark silently (the row left "What's waiting", nothing to roll back).
 *   • still waiting, grace window OPEN → HOLD the mark (the row keeps showing
 *     `resuming…` for a beat as the daemon re-dispatches).
 *   • still waiting, grace window ELAPSED → ROLL BACK: drop the mark and report
 *     the id so the surface reinstates the verb + tells the operator it did not
 *     take (shouldRollBack is the per-mark decision).
 * PURE — no timers, no fetch; the hook injects `now` + the set of still-waiting
 * ids derived from the current inbox model.
 */
export function reconcileMarks({
  marks,
  stillWaitingIds,
  now,
}: {
  marks: readonly OptimisticMark[];
  /** Ids the CURRENT frame STILL carries as needs-you (blocked | waiting). */
  stillWaitingIds: ReadonlySet<string>;
  now: number;
}): ReconcileResult {
  const surviving: OptimisticMark[] = [];
  const rollBack: string[] = [];
  for (const mark of marks) {
    const stillWaiting = stillWaitingIds.has(mark.ticket);
    if (!stillWaiting) continue; // cleared → retire silently (the resume took).
    if (shouldRollBack({ stillWaiting, elapsedMs: now - mark.markedAt })) {
      rollBack.push(mark.ticket); // expired & still waiting → it did not take.
    } else {
      surviving.push(mark); // window still open → hold the optimistic mark.
    }
  }
  return { marks: surviving, rollBack };
}
