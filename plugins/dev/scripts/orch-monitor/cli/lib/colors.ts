import type { CanonicalEvent } from "../../lib/canonical-event.ts";

export type RowColor = "green" | "red" | "yellow" | "blue" | "magenta" | "cyan" | "gray" | "white";

const COLOR_MAP: Record<string, RowColor> = {
  "github.pr.merged": "green",
  "github.pr.opened": "blue",
  "github.pr.closed": "gray",
  "orchestrator.worker.done": "green",
  "orchestrator.worker.failed": "red",
  "orchestrator.attention.raised": "yellow",
  "comms.message.posted": "magenta",
};

export function getRowColor(event: CanonicalEvent): RowColor {
  const name = event.attributes["event.name"];
  if (name === "github.check_suite.completed") {
    return event.attributes["cicd.pipeline.run.result"] === "success" ? "green" : "red";
  }
  if (name.startsWith("filter.wake")) return "cyan";
  return COLOR_MAP[name] ?? "gray";
}
