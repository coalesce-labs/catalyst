// terminal-state.mjs — the SHARED Linear terminal-state predicate (CTL-642 + CTL-758).
//
// ONE mechanism, ONE source of truth for "is this ticket's Linear workflow state
// terminal?". Both the CTL-642 recovery short-circuit (stop escalating a ticket
// that already reached Done/Canceled or whose PR already merged) and the CTL-758
// backward-write guard (refuse a daemon write that would move a terminal ticket
// BACK to a non-terminal state) read this single predicate so the two features
// can never disagree about what "terminal" means.
//
// CRITICAL — THREE DISTINCT TERMINAL SETS, never conflated:
//   1. signal-reader.TERMINAL = {done, failed, stalled, skipped}  — phase SIGNAL
//      statuses (the worker's local lifecycle).
//   2. phase-fsm.TERMINAL_STATES = {done, stalled}                — phase FSM
//      transition states.
//   3. THIS isLinearTerminal = {Done, Canceled}                   — LINEAR
//      workflow-STATE NAMES (the human-visible board column).
// These are different namespaces (signal status vs FSM state vs Linear state
// name). isLinearTerminal is its OWN set and must NEVER reuse the other two, nor
// TERMINAL_LINEAR_KEY ("done", a transition KEY, not a state NAME).

// LINEAR_TERMINAL_STATES — the Linear workflow-state NAMES that mean the ticket
// is finished and the daemon must stop acting on it. These are the canonical
// Linear `completed`/`canceled` category state names. Frozen so no caller can
// mutate the shared set.
export const LINEAR_TERMINAL_STATES = Object.freeze(new Set(["Done", "Canceled"]));

// isLinearTerminal — is the given Linear workflow-state NAME terminal?
// A null/undefined/unknown name is NOT terminal (D5 fail-safe: when we cannot
// read the state we treat the ticket as still in-flight rather than silently
// dropping it).
export function isLinearTerminal(name) {
  return LINEAR_TERMINAL_STATES.has(name);
}

// isTicketTerminalOrMerged — CHEAP-FIRST determination of whether a ticket has
// reached a terminal Linear state OR has an already-merged PR. Used by the
// CTL-642 recovery short-circuit to stop escalating / reviving a ticket the
// pipeline (or a human) has already finished.
//
// Order matters — the cheap cached Linear read runs FIRST, the expensive `gh`
// PR view runs ONLY if the Linear state is non-terminal AND a PR number exists:
//   1. cached `fetchState(ticket)` → isLinearTerminal? → {terminal:true, reason:"linear-terminal"}.
//      A NULL read (linearis down / unparseable) is the D5 fail-safe → falls
//      through to NOT-terminal (never short-circuits on an unknown state).
//   2. only if step 1 is non-terminal AND signal.raw.pr.number is present:
//      prAdapter.prView(ticket, pr) → merged? → {terminal:true, reason:"pr-merged"}.
//      "merged" means state === "MERGED" or a non-null mergedAt.
//   3. else → {terminal:false}.
//
// Returns { terminal, reason }. Best-effort: never throws — a thrown read is
// swallowed to the fail-safe NOT-terminal verdict (the caller then proceeds with
// its normal escalate/revive path, exactly as before this guard existed).
export function isTicketTerminalOrMerged({ ticket, signal, fetchState, cache, prAdapter } = {}) {
  try {
    // (1) CHEAP cached Linear read first.
    if (typeof fetchState === "function") {
      const state = fetchState(ticket, { cache });
      if (isLinearTerminal(state)) {
        return { terminal: true, reason: "linear-terminal", state };
      }
    }
    // (2) Only escalate to the expensive PR view when we have a PR number AND
    //     the Linear state did not already prove terminal.
    const pr = signal?.raw?.pr ?? signal?.pr ?? null;
    if (prAdapter && typeof prAdapter.prView === "function" && pr?.number) {
      const view = prAdapter.prView(ticket, pr);
      if (view && (view.state === "MERGED" || view.mergedAt != null)) {
        return { terminal: true, reason: "pr-merged", state: view.state ?? null };
      }
    }
    // (3) Neither terminal nor merged (or unreadable → D5 fail-safe).
    return { terminal: false };
  } catch {
    // Fail-safe: an unexpected throw must NOT manufacture a false terminal.
    return { terminal: false };
  }
}
