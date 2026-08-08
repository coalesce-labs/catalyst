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

// worker_state is PRIMARY KEY (orchestrator, ticket) in broker-state.mjs, and coordination
// events carry the emitting orchestrator in attributes["catalyst.orchestrator.id"]. Parity must
// match on that composite identity — keying by ticket alone merges records from multiple
// orchestrators/runs of the same ticket, so one run's projection row gets compared against
// another run's terminal event, producing a false divergence or a false match (Codex P1).
function orchestratorFromRow(row: CoordinationRow): string {
  const attrs = row.attributes as Record<string, unknown> | undefined;
  const orch = attrs?.["catalyst.orchestrator.id"];
  return typeof orch === "string" ? orch : "";
}

// NUL-joined composite key — NUL can never appear in an orchestrator id or ticket, so the join
// is unambiguous (no "a" + "b\x00c" vs "a\x00b" + "c" collision).
function parityKey(orchestrator: string, ticket: string): string {
  return `${orchestrator}\u0000${ticket}`;
}

function terminalOutcomeFromEventName(eventName: string): "success" | "failure" | null {
  const parts = eventName.split(".");
  if (parts.length < 2) return null;
  const statusSeg = parts[parts.length - 2];
  if (statusSeg === "complete" || statusSeg === "skipped") return "success";
  if (statusSeg === "failed" || statusSeg === "turn-cap-exhausted") return "failure";
  return null;
}

// Mirrors broker-state.mjs's canonical WORKER_TERMINAL_STATUSES = {"done","failed","complete"}:
// "complete" is a SUCCESSFUL terminal outcome (the canonical CTL-532 done status), not a skip.
// Classifying it as null here would let a worker_state row whose coordination stream ends in a
// failure event pass unexamined and report "healthy" (Codex P1).
function workerStateOutcome(status: string): "success" | "failure" | null {
  if (status === "done" || status === "complete") return "success";
  if (status === "failed") return "failure";
  return null;
}

// Worker_state statuses that mean the projection HAS folded a terminal event — ticket-level
// (done/failed/complete) OR the per-PHASE terminals the CTL-532 reducer emits for the phase.*
// terminal events themselves (projection.mjs PHASE_STATUS_MAP: phase-complete / phase-failed /
// turn-cap-exhausted). Reverse-coverage treats any of these as "the projection accounted for a
// terminal here"; a merely-intermediate status (dispatched, pr-created, …) does NOT count, so a
// genuinely dropped terminal still surfaces. Recognizing the phase terminals prevents ordinary
// active multi-phase work — where each finished phase legitimately sits at phase-complete before
// the ticket reaches done — from being reported as a dropped-projection divergence (Codex P1, round 12).
const PROJECTED_TERMINAL_STATUSES = new Set([
  "done",
  "failed",
  "complete",
  "phase-complete",
  "phase-failed",
  "turn-cap-exhausted",
]);

// Select the winning terminal coordination outcome for one (orchestrator, ticket) using the SAME
// ordering the worker_state projection applies (broker-state.mjs upsertWorkerState): status is
// gated on the greatest `last_event_ts` watermark, with `>=` so a later-PROCESSED event wins on an
// exact-timestamp tie. Selecting by input order alone (Codex P1) mis-picks when terminal events
// are appended out of timestamp order — e.g. a newer failure landing before a delayed older
// success — producing a false divergence or a false match. ISO-8601 timestamps sort
// lexicographically, so a string `>=` reproduces the projection's comparison. A null ts never
// advances the watermark (mirrors the projection's `excluded.last_event_ts IS NOT NULL` guard);
// if EVERY terminal row lacks a ts we fall back to processing order (last non-null-less wins).
function selectTerminalOutcome(rows: CoordinationRow[]): "success" | "failure" | null {
  let best: { ts: string | null; outcome: "success" | "failure" } | null = null;
  for (const row of rows) {
    const attrs = row.attributes as Record<string, unknown> | undefined;
    const eventName = typeof attrs?.["event.name"] === "string" ? attrs["event.name"] : "";
    const outcome = terminalOutcomeFromEventName(eventName);
    if (outcome === null) continue;
    const ts = typeof row.ts === "string" ? row.ts : null;
    if (best === null) {
      best = { ts, outcome };
      continue;
    }
    // Later-processed event wins iff its ts advances the watermark: a ts'd event beats a
    // null-ts incumbent and beats-or-ties an earlier ts; a null-ts event only wins when the
    // incumbent is also null (pure processing order).
    const advances = ts !== null ? best.ts === null || ts >= best.ts : best.ts === null;
    if (advances) best = { ts, outcome };
  }
  return best?.outcome ?? null;
}

export function computeParity(input: {
  workerStates: WorkerStateRow[];
  coordinationRows: CoordinationRow[];
}): ParityResult {
  const { workerStates, coordinationRows } = input;

  // Index ALL coordination rows by ticket in a SINGLE list per ticket, preserving input (wire)
  // order and tagging each with its orchestrator. A worker_state then matches the entries whose
  // orchestrator is its OWN (composite isolation, so multiple orchestrators/runs of a ticket never
  // cross-contaminate) OR is identity-less. Identity-less rows (no catalyst.orchestrator.id) come
  // from the SDK terminal emitter's defaultAppendEventLog fallback (sdk-run-phase-agent.mjs, when
  // phase-agent-emit-complete is missing/fails) — a real terminal carrying the ticket but no
  // orchestrator; matching them against every worker_state for the ticket keeps a failed
  // identity-less terminal from silently disappearing. Keeping BOTH kinds in one ordered list (not
  // two concatenated maps) is essential: selectTerminalOutcome's watermark tie-break is
  // last-processed-wins, so re-ordering an earlier identity-less row after a later keyed row would
  // flip the winner and fabricate a divergence (Codex P1, round 8).
  const coordByTicket = new Map<string, Array<{ orch: string; row: CoordinationRow }>>();
  const orderedTickets: string[] = [];

  for (const row of coordinationRows) {
    // Only THIS host's own would-publish stream (local_seq set). Inbound-pulled rows (hub_seq, no
    // local_seq) are excluded: the composite (orchestrator, ticket) is NOT host-unique because
    // execution-core sets CATALYST_ORCHESTRATOR_ID to the ticket, so a same-ticket terminal from
    // another host would otherwise collide with — and, under selectTerminalOutcome's last-wins
    // tie-break, override — this host's local terminal, fabricating or masking a divergence against
    // the LOCAL worker_state (Codex P1, round 10). The whole harness is local-vs-local.
    if (typeof row.local_seq !== "number") continue;
    const attrs = row.attributes as Record<string, unknown> | undefined;
    const eventName = typeof attrs?.["event.name"] === "string" ? attrs["event.name"] : "";
    const ticket = ticketFromEventName(eventName);
    if (!ticket) continue;
    const entry = { orch: orchestratorFromRow(row), row };
    const existing = coordByTicket.get(ticket);
    if (existing) existing.push(entry);
    else {
      coordByTicket.set(ticket, [entry]);
      orderedTickets.push(ticket); // first sighting → wire-order provenance
    }
  }

  let matchedPairs = 0;
  const coverageGaps: ParityResult["coverageGaps"] = [];
  const divergences: ParityResult["divergences"] = [];

  for (const ws of workerStates) {
    // This run's OWN entries plus identity-less entries for the same ticket, IN INPUT ORDER.
    const rows = (coordByTicket.get(ws.ticket) ?? [])
      .filter((e) => e.orch === ws.orchestrator || e.orch === "")
      .map((e) => e.row);
    if (rows.length === 0) {
      coverageGaps.push({ orchestrator: ws.orchestrator, ticket: ws.ticket });
      continue;
    }

    // A matched PAIR requires a COMPARABLE terminal outcome on BOTH sides. A worker_state whose
    // coordination rows are all non-terminal (e.g. only a `worker.transition` event), or whose own
    // status is non-terminal, is not evaluable: counting it (Codex P1) would let the harness report
    // `healthy` — exit 0, ADR-023 promotion — with no terminal comparison performed at all.
    const wsOutcome = workerStateOutcome(ws.status);
    const coordOutcome = selectTerminalOutcome(rows);
    if (wsOutcome === null || coordOutcome === null) continue;

    matchedPairs++;
    if (coordOutcome !== wsOutcome) {
      divergences.push({
        orchestrator: ws.orchestrator,
        ticket: ws.ticket,
        reason: `worker_state status "${ws.status}" (${wsOutcome}) conflicts with coordination terminal "${coordOutcome}"`,
      });
    }
  }

  // Reverse coverage (Codex P1): the worker-driven loop above never examines a terminal coordination
  // event that has NO worker_state row at all, so a dropped projection could slip through as healthy
  // whenever some unrelated pair matches. Scan THIS host's OWN would-publish stream — rows carrying a
  // `local_seq` (locally tailed), NOT inbound-pulled `hub_seq` rows whose worker_state lives on
  // another host — for terminals with no matching worker_state and report each as a divergence.
  // Only TERMINAL worker_state rows count as coverage: a nonterminal projection (e.g. still
  // `dispatched`) that the forward pass skipped has NOT reconciled the coordination terminal, so
  // that terminal was effectively dropped and must still be flagged (Codex P1, round 11). Keying on
  // all worker_states — terminal or not — let an identity-less failure hide behind a merely-present
  // dispatched row for the ticket.
  const terminalWorkerStates = workerStates.filter((w) => PROJECTED_TERMINAL_STATUSES.has(w.status));
  const workerStateKeys = new Set(terminalWorkerStates.map((w) => parityKey(w.orchestrator, w.ticket)));
  const workerStateTickets = new Set(terminalWorkerStates.map((w) => w.ticket));
  const reportedOrphans = new Set<string>();
  for (const row of coordinationRows) {
    if (typeof row.local_seq !== "number") continue; // inbound-pulled row → worker_state is remote
    const attrs = row.attributes as Record<string, unknown> | undefined;
    const eventName = typeof attrs?.["event.name"] === "string" ? attrs["event.name"] : "";
    if (terminalOutcomeFromEventName(eventName) === null) continue;
    const ticket = ticketFromEventName(eventName);
    if (!ticket) continue;
    const orchestrator = orchestratorFromRow(row);
    // An identity-less terminal is covered iff a TERMINAL worker_state exists for its ticket (mirrors
    // the forward-direction ticket fallback); a keyed terminal needs its exact TERMINAL (orchestrator, ticket).
    const covered =
      orchestrator === "" ? workerStateTickets.has(ticket) : workerStateKeys.has(parityKey(orchestrator, ticket));
    if (covered) continue;
    const dedupKey = orchestrator === "" ? ` ${ticket}` : parityKey(orchestrator, ticket);
    if (reportedOrphans.has(dedupKey)) continue;
    reportedOrphans.add(dedupKey);
    divergences.push({
      orchestrator: orchestrator || "(unknown)",
      ticket,
      reason: `coordination terminal for "${orchestrator || "(no orchestrator)"}/${ticket}" has no worker_state row (projection dropped a terminal event)`,
    });
  }

  // A divergence is a positive finding of a problem, so it takes precedence over the
  // zero-matched-pairs "inconclusive" — an orphan terminal must not be masked as merely unevaluable.
  let verdict: Verdict;
  if (divergences.length > 0) verdict = "divergent";
  else if (matchedPairs === 0) verdict = "inconclusive";
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
