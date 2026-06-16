/**
 * substep-reader.ts — CTL-753 workflow-substep reader for /api/ticket-substeps,
 * extracted from server.ts (CTL-1215) so the ring path + the legacy file path
 * can be unit-tested for parity.
 *
 * The substep timeline for ONE ticket is a tiny, recent slice (a ticket actively
 * moving through phases), so the shared in-memory event ring (event-ring.ts)
 * covers the realistic case without `readFileSync`-ing the whole current-month
 * log on every request. `readSubStepEventsFromFile` is retained as the legacy
 * single-file scan for parity tests and as an optional underflow fallback.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EventRing } from "./event-ring";

export interface SubStepEvent {
  ts: string;
  workflowName: string;
  stepLabel: string;
  stepIndex: number;
  status: string;
}

function safeParseJson(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

function projectSubStep(ev: Record<string, unknown>): SubStepEvent {
  const payload =
    ((ev.body as Record<string, unknown>)?.payload as Record<string, unknown>) ??
    {};
  return {
    ts: (ev.ts as string) ?? "",
    workflowName: (payload.workflowName as string) ?? "",
    stepLabel: (payload.stepLabel as string) ?? "",
    stepIndex: (payload.stepIndex as number) ?? 0,
    status: (payload.status as string) ?? "",
  };
}

/**
 * Ring-backed substep read. Queries the in-memory ring with a jq predicate
 * matching `workflow.substep.(started|complete|failed).<ticket>`, projects the
 * payloads, sorts ascending by ts. Same semantics + output as the file path.
 */
export function readSubStepEvents(ring: EventRing, ticket: string): SubStepEvent[] {
  // Escape regex metacharacters for jq's oniguruma `test()`. Crucially this does
  // NOT escape "-" (a literal outside a character class; jq treats "\-" as an
  // invalid escape and the predicate would error → fail-open to no match — the
  // bug that made a ticket like "CTL-1" never resolve). A Linear key is
  // `[A-Z]+-\d+`, so "." is the only real metacharacter present, but we escape
  // the full set defensively.
  const escaped = ticket.replace(/[.[\]{}()*+?\\^$|#\s]/g, "\\$&");
  const predicate = `(.attributes."event.name") | test("^workflow\\\\.substep\\\\.(started|complete|failed)\\\\.${escaped}$")`;
  const lines = ring.query({ predicate, limit: 5000 });
  const results: SubStepEvent[] = [];
  for (const line of lines) {
    const ev = safeParseJson(line);
    if (!ev) continue;
    results.push(projectSubStep(ev));
  }
  results.sort((a, b) => a.ts.localeCompare(b.ts));
  return results;
}

/**
 * Legacy single-file scan (the pre-CTL-1215 behavior). Reads the whole
 * current-month log and post-filters with a per-ticket regex. Kept for parity
 * tests + as an optional underflow fallback.
 */
export function readSubStepEventsFromFile(
  eventsDir: string,
  ticket: string,
): SubStepEvent[] {
  const month = new Date().toISOString().slice(0, 7);
  const logPath = join(eventsDir, `${month}.jsonl`);
  const escapedTicket = escapeRegex(ticket);
  const pattern = new RegExp(
    `^workflow\\.substep\\.(started|complete|failed)\\.${escapedTicket}$`,
  );
  try {
    const text = readFileSync(logPath, "utf-8");
    const results: SubStepEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const ev = safeParseJson(line);
      if (!ev) continue;
      const name =
        (ev.attributes as Record<string, string> | undefined)?.["event.name"] ??
        "";
      if (!pattern.test(name)) continue;
      results.push(projectSubStep(ev));
    }
    results.sort((a, b) => a.ts.localeCompare(b.ts));
    return results;
  } catch {
    return [];
  }
}
