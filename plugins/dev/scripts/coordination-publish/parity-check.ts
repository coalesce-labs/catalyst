#!/usr/bin/env bun
// parity-check — CTL-1668 Phase 3.
//
// Compares the local coordination mirror (the would-publish stream) against the CTL-532
// worker_state projection. Three-way exit contract:
//   0 = healthy  (non-zero matched pairs, zero divergences)
//   1 = divergent (a worker_state's terminal status conflicts with its coordination events)
//   2 = inconclusive (zero matched pairs — mirror empty or no matching pairs)

type WorkerStateRow = { orchestrator: string; ticket: string; status: string; [key: string]: unknown };
type CoordinationRow = Record<string, unknown>;

type Verdict = "healthy" | "divergent" | "inconclusive";

export interface ParityResult {
  matchedPairs: number;
  coverageGaps: Array<{ orchestrator: string; ticket: string }>;
  divergences: Array<{ orchestrator: string; ticket: string; reason: string }>;
  orderedTickets: string[];
  verdict: Verdict;
}

function ticketFromEventName(eventName: string): string {
  const parts = eventName.split(".");
  return parts[parts.length - 1] ?? "";
}

function terminalOutcomeFromEventName(eventName: string): "success" | "failure" | null {
  const parts = eventName.split(".");
  if (parts.length < 2) return null;
  const statusSeg = parts[parts.length - 2];
  if (statusSeg === "complete" || statusSeg === "skipped") return "success";
  if (statusSeg === "failed" || statusSeg === "turn-cap-exhausted") return "failure";
  return null;
}

function workerStateOutcome(status: string): "success" | "failure" | null {
  if (status === "done") return "success";
  if (status === "failed") return "failure";
  return null;
}

export function computeParity(input: {
  workerStates: WorkerStateRow[];
  coordinationRows: CoordinationRow[];
}): ParityResult {
  const { workerStates, coordinationRows } = input;

  // Build coordination index in input order (never sort).
  const coordByTicket = new Map<string, CoordinationRow[]>();
  const orderedTickets: string[] = [];
  const seenTickets = new Set<string>();

  for (const row of coordinationRows) {
    const attrs = row.attributes as Record<string, unknown> | undefined;
    const eventName = typeof attrs?.["event.name"] === "string" ? attrs["event.name"] : "";
    const ticket = ticketFromEventName(eventName);
    if (!ticket) continue;
    if (!seenTickets.has(ticket)) {
      seenTickets.add(ticket);
      orderedTickets.push(ticket);
    }
    const existing = coordByTicket.get(ticket);
    if (existing) existing.push(row);
    else coordByTicket.set(ticket, [row]);
  }

  let matchedPairs = 0;
  const coverageGaps: ParityResult["coverageGaps"] = [];
  const divergences: ParityResult["divergences"] = [];

  for (const ws of workerStates) {
    const rows = coordByTicket.get(ws.ticket);
    if (!rows || rows.length === 0) {
      coverageGaps.push({ orchestrator: ws.orchestrator, ticket: ws.ticket });
      continue;
    }

    // This worker_state has ≥1 coordination row → counted as a matched pair.
    matchedPairs++;

    // Check for terminal status conflict: find the last terminal coordination outcome.
    const wsOutcome = workerStateOutcome(ws.status);
    if (wsOutcome !== null) {
      let lastTerminalOutcome: "success" | "failure" | null = null;
      for (const row of rows) {
        const attrs = row.attributes as Record<string, unknown> | undefined;
        const eventName = typeof attrs?.["event.name"] === "string" ? attrs["event.name"] : "";
        const outcome = terminalOutcomeFromEventName(eventName);
        if (outcome !== null) lastTerminalOutcome = outcome;
      }
      if (lastTerminalOutcome !== null && lastTerminalOutcome !== wsOutcome) {
        divergences.push({
          orchestrator: ws.orchestrator,
          ticket: ws.ticket,
          reason: `worker_state status "${ws.status}" (${wsOutcome}) conflicts with coordination terminal "${lastTerminalOutcome}"`,
        });
      }
    }
  }

  let verdict: Verdict;
  if (matchedPairs === 0) verdict = "inconclusive";
  else if (divergences.length > 0) verdict = "divergent";
  else verdict = "healthy";

  return { matchedPairs, coverageGaps, divergences, orderedTickets, verdict };
}

export function verdictToExit(verdict: Verdict): number {
  return ({ healthy: 0, divergent: 1, inconclusive: 2 } as Record<string, number>)[verdict] ?? 2;
}

// --- CLI entrypoint (not unit-tested) ----------------------------------------
if (import.meta.main) {
  const brokerStateSpecifier = ["../broker/broker-state.mjs"].join("");
  const configSpecifier = ["../execution-core/config.mjs"].join("");
  const { getAllWorkerStates, openBrokerStateDb } = await import(brokerStateSpecifier) as {
    getAllWorkerStates: () => WorkerStateRow[];
    openBrokerStateDb: (path?: string) => unknown;
  };
  const { getCoordinationMirrorPath } = await import(configSpecifier) as { getCoordinationMirrorPath: () => string };

  openBrokerStateDb();

  const { existsSync, readFileSync } = await import("node:fs");
  const mirrorPath = getCoordinationMirrorPath();

  let coordinationRows: CoordinationRow[] = [];
  if (existsSync(mirrorPath)) {
    try {
      coordinationRows = readFileSync(mirrorPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as CoordinationRow);
    } catch {
      // Empty or malformed mirror → inconclusive
    }
  }

  const workerStates = getAllWorkerStates();
  const result = computeParity({ workerStates, coordinationRows });

  console.log(`\nparity-check report:`);
  console.log(`  matched pairs : ${result.matchedPairs}`);
  console.log(`  coverage gaps : ${result.coverageGaps.length}`);
  console.log(`  divergences   : ${result.divergences.length}`);
  console.log(`  verdict       : ${result.verdict}`);

  if (result.coverageGaps.length > 0) {
    console.log(`\ncoverage gaps (worker_state with no coordination rows):`);
    for (const g of result.coverageGaps) console.log(`  ${g.orchestrator} / ${g.ticket}`);
  }
  if (result.divergences.length > 0) {
    console.log(`\ndivergences:`);
    for (const d of result.divergences) console.log(`  ${d.orchestrator} / ${d.ticket}: ${d.reason}`);
  }

  process.exit(verdictToExit(result.verdict));
}
