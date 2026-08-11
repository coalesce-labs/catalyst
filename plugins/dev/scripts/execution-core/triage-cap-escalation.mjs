import { buildExplanation, coerceExplanation } from "./escalation-explanation.mjs";

export function buildTriageCapExplanation(ev = {}) {
  const ticket = ev.ticket ?? "this ticket";
  const cap = ev.cap ?? 3;
  const count = ev.count ?? cap;
  // CAT-83 (Codex #3218 P2): the cap path deliberately parks a ticket that HAS a
  // triage.json when the current phase signal is failed or missing (the durable
  // artifact is stale, from an earlier episode). Asserting "no artifact" flatly
  // would hand the operator evidence that contradicts the observed.artifactPresent
  // value printed directly beneath it, in exactly that stale-artifact case.
  const artifactPresent = ev.artifactPresent ?? false;
  const artifactClause = artifactPresent
    ? "still has no SUCCESSFUL triage (its triage.json is stale — left by an earlier episode)"
    : "still has no triage.json artifact";
  const fields = {
    escalation_type: "decision",
    problem: `${ticket} reached ${count} of ${cap} triage dispatches and ${artifactClause}${ev.signalStatus ? ` (last signal: ${ev.signalStatus})` : ""}.`,
    call_to_action: `Choose whether to re-arm ${ticket}, triage it by hand, or remove it from the queue.`,
    options: [
      { label: "Re-arm daemon triage", tradeoff: "Allows another dispatch budget but may repeat the failure if its cause remains." },
      { label: "Triage by hand", tradeoff: `Unblocks ${ticket} now but does not repair the failed automated path.` },
      { label: "Re-scope or cancel", tradeoff: "Avoids more attempts but removes the ticket from its queued position." },
    ],
    why_you: "Repeated dispatches produced no artifact, so choosing whether further attempts are worthwhile requires an operator decision.",
    observed: {
      count,
      cap,
      artifactPresent: ev.artifactPresent ?? false,
      signalStatus: ev.signalStatus ?? null,
      firstDispatchAt: ev.firstDispatchAt ?? null,
      lastDispatchAt: ev.lastDispatchAt ?? null,
      host: ev.host ?? null,
    },
  };
  try {
    return buildExplanation(fields);
  } catch {
    return coerceExplanation(fields, { ticket, canExecute: false });
  }
}

export function formatTriageCapComment(ev = {}) {
  const e = buildTriageCapExplanation(ev);
  const options = e.options.map((o) => `- **${o.label}** — ${o.tradeoff}`).join("\n");
  return `**Triage dispatches capped**\n\n${e.problem}\n\nNo triage.json was produced after ${e.observed.count} of ${e.observed.cap} attempts. To re-arm automated triage, clear the dispatch counter after addressing the failure.\n\n${options}`;
}
// triage-cap-escalation.mjs — CAT-83: operator-facing CTL-1441 park evidence
// and Linear comment formatting. Pure; the monitor owns all writes.
