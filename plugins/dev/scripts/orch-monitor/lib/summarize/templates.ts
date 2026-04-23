import { readFileSync } from "fs";
import { join } from "path";
import type { SummarizeSnapshot } from "./snapshot";
import type { WorkerState } from "../state-reader";

export const TEMPLATE_NAMES = [
  "run-summary",
  "attention-digest",
  "worker-status",
] as const;

export type TemplateName = (typeof TEMPLATE_NAMES)[number];

function loadTemplate(name: string): string {
  const path = join(import.meta.dir, "templates", `${name}.md`);
  return readFileSync(path, "utf8");
}

const TEMPLATES: Record<TemplateName, string> = {
  "run-summary": loadTemplate("run-summary"),
  "attention-digest": loadTemplate("attention-digest"),
  "worker-status": loadTemplate("worker-status"),
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function workerStatusLine(w: WorkerState): string {
  const parts = [`${w.ticket}: status=${w.status}, phase=${w.phase}`];
  if (w.pr) parts.push(`PR=#${w.pr.number}`);
  if (w.alive === false) parts.push("[process dead]");
  return `- ${parts.join(", ")}`;
}

function renderWorkerStatus(snap: SummarizeSnapshot): string {
  const workers = Object.values(snap.workers);
  if (workers.length === 0) return "(no workers)";
  return workers.map(workerStatusLine).join("\n");
}

function renderAttention(snap: SummarizeSnapshot): string {
  const items = snap.state.attention;
  if (!Array.isArray(items) || items.length === 0) return "(none)";
  const lines: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const type = typeof item.type === "string" ? item.type : "unknown";
    const ticket = typeof item.ticket === "string" ? item.ticket : "";
    const message = typeof item.message === "string" ? item.message : "";
    lines.push(`- [${type}] ${ticket} — ${message}`);
  }
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

function renderBriefings(snap: SummarizeSnapshot): string {
  const entries = Object.entries(snap.briefings);
  if (entries.length === 0) return "(none)";
  const lines: string[] = [];
  for (const [wave, body] of entries) {
    lines.push(`### Wave ${wave}`);
    lines.push(body);
  }
  return lines.join("\n");
}

export function renderTemplate(
  name: string,
  snap: SummarizeSnapshot,
): string {
  const template = (TEMPLATES as Record<string, string | undefined>)[name];
  if (!template) {
    throw new Error(`unknown template: ${name}`);
  }

  const summaryMd = snap.summaryMd?.trim() || "(none)";

  return template
    .replace(/\{\{orchId\}\}/g, snap.orchId)
    .replace(/\{\{workerStatusTable\}\}/g, renderWorkerStatus(snap))
    .replace(/\{\{attentionItems\}\}/g, renderAttention(snap))
    .replace(/\{\{briefings\}\}/g, renderBriefings(snap))
    .replace(/\{\{summaryMd\}\}/g, summaryMd);
}
