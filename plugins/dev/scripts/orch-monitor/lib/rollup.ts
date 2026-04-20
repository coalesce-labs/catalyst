import type { OrchestratorState, WorkerState } from "./state-reader";

export interface ShippedItem {
  ticket: string;
  pr?: number;
  title: string;
  oneliner?: string;
}

export interface RollupBriefing {
  whatShipped: ShippedItem[];
  whatToSee: string;
  gotchas: string;
  generatedAt: string;
  generatedBy: "auto" | "manual" | "ai";
}

type RollupInput = Pick<OrchestratorState, "id" | "startedAt" | "workers">;

const ONELINER_MAX = 120;

function firstMeaningfulLine(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length <= ONELINER_MAX) return trimmed;
    return trimmed.slice(0, ONELINER_MAX - 1).trimEnd() + "…";
  }
  return undefined;
}

function prTitle(worker: WorkerState): string {
  if (worker.pr?.title && worker.pr.title.trim().length > 0) return worker.pr.title;
  return worker.ticket;
}

/**
 * Assemble an orchestrator-level rollup briefing from worker signals and optional
 * per-worker rollup fragments. Returns null when the orchestrator has nothing to
 * report (no merged/open PRs AND no fragments).
 *
 * Pure function — `generatedAt` is injected by the caller for deterministic tests.
 */
export function assembleRollup(
  orch: RollupInput,
  fragments: Record<string, string>,
  generatedAt: string,
): RollupBriefing | null {
  const workerEntries = Object.entries(orch.workers).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  const whatShipped: ShippedItem[] = [];
  for (const [, worker] of workerEntries) {
    if (!worker.pr?.number) continue;
    const fragment = fragments[worker.ticket];
    const item: ShippedItem = {
      ticket: worker.ticket,
      pr: worker.pr.number,
      title: prTitle(worker),
    };
    if (fragment) {
      const oneliner = firstMeaningfulLine(fragment);
      if (oneliner) item.oneliner = oneliner;
    }
    whatShipped.push(item);
  }

  const fragmentTickets = Object.keys(fragments).sort();
  const hasFragments = fragmentTickets.some(
    (t) => typeof fragments[t] === "string" && fragments[t].trim().length > 0,
  );

  if (whatShipped.length === 0 && !hasFragments) return null;

  let whatToSee = "";
  if (whatShipped.length > 0) {
    const urls = whatShipped
      .map((s) => {
        const worker = orch.workers[s.ticket];
        return worker?.pr?.url;
      })
      .filter((u): u is string => typeof u === "string" && u.length > 0);
    const lines = [
      "Review each merged PR for reviewer notes and test plans:",
      "",
      ...urls.map((u) => `- ${u}`),
    ];
    whatToSee = lines.join("\n");
  }

  const gotchaSections: string[] = [];
  for (const ticket of fragmentTickets) {
    const body = fragments[ticket];
    if (typeof body !== "string" || body.trim().length === 0) continue;
    gotchaSections.push(`### ${ticket}\n\n${body.trim()}`);
  }
  const gotchas = gotchaSections.join("\n\n");

  return {
    whatShipped,
    whatToSee,
    gotchas,
    generatedAt,
    generatedBy: "auto",
  };
}
