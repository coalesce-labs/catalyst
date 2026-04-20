import { marked } from "marked";
import DOMPurify from "dompurify";
import type { OrchestratorState } from "./types";

export interface BriefingEntry {
  wave: number;
  body: string;
}

export function hasAnyBriefings(orch: OrchestratorState): boolean {
  const briefings = orch.briefings;
  if (!briefings) return false;
  for (const key of Object.keys(briefings)) {
    const body = briefings[Number(key)];
    if (typeof body === "string" && body.length > 0) return true;
  }
  return false;
}

export function collectBriefings(orch: OrchestratorState): BriefingEntry[] {
  const briefings = orch.briefings || {};
  const entries: BriefingEntry[] = [];
  for (const key of Object.keys(briefings)) {
    const wave = Number(key);
    const body = briefings[wave];
    if (typeof body === "string" && body.length > 0) {
      entries.push({ wave, body });
    }
  }
  entries.sort((a, b) => a.wave - b.wave);
  return entries;
}

export function renderBriefingHtml(markdown: string): string {
  try {
    const raw = marked.parse(markdown, {
      gfm: true,
      breaks: false,
    }) as string;
    return DOMPurify.sanitize(raw, { ADD_ATTR: ["target", "rel"] });
  } catch {
    return `<pre>${markdown}</pre>`;
  }
}
