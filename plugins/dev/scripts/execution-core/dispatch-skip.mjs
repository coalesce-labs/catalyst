import { phaseIndex, isKnownPhase } from "../lib/phase-fsm.mjs";

export const OPERATOR_OWNED_STALL_REASONS = Object.freeze(new Set([
  "needs_human", "escalation-ask-cap", "remediate-cycle-cap-exhausted", "phantom-ticket",
]));
export const MACHINE_OWNED_STALL_REASONS = Object.freeze(new Set([
  "boot-resume-gate-expired", "dispatch-circuit-breaker",
  "prior-artifact-retry-exhausted", "no-probe-for-phase",
]));

export function classifyStallReason(reason) {
  if (typeof reason !== "string" || reason.length === 0) return "unknown";
  if (OPERATOR_OWNED_STALL_REASONS.has(reason)) return "operator-owned";
  if (MACHINE_OWNED_STALL_REASONS.has(reason)) return "machine-owned";
  return "unknown";
}

function liveEntries(signals) {
  const entries = Object.entries(signals ?? {});
  const known = entries.filter(([phase]) => isKnownPhase(phase));
  const max = known.reduce((n, [phase]) => Math.max(n, phaseIndex(phase)), -1);
  return entries.filter(([phase]) => !isKnownPhase(phase) || phaseIndex(phase) === max);
}

// Keep this precedence aligned with board-data.mjs's worker-signal contract.
export function signalReason(raw) {
  return raw?.failureReason ?? raw?.attentionReason ?? raw?.stalledReason ?? null;
}

export function describeSkip({ signals, raw } = {}) {
  const live = liveEntries(signals);
  const [phase = null, status = null] = live.at(-1) ?? [];
  const phaseRaw = phase && raw && typeof raw === "object" ? (raw[phase] ?? raw) : raw;
  const reason = signalReason(phaseRaw);
  return { status, phase, reason, class: classifyStallReason(reason) };
}

export function summarizeSkips(entries, { cap = 20 } = {}) {
  const all = Array.isArray(entries) ? entries : [];
  return {
    entries: all.slice(0, cap),
    count: all.length,
    operatorOwned: all.filter((e) => e.class === "operator-owned").length,
    machineOwned: all.filter((e) => e.class === "machine-owned").length,
    unknown: all.filter((e) => e.class === "unknown").length,
  };
}

export function hasStarvingWork({ readyIds, skips }) {
  if (!Array.isArray(readyIds) || readyIds.length === 0) return false;
  const byTicket = new Map((skips ?? []).map((entry) => [entry.ticket, entry.class]));
  return readyIds.some((ticket) => byTicket.get(ticket) !== "operator-owned");
}
