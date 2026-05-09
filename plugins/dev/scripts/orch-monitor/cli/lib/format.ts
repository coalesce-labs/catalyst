import type { CanonicalEvent } from "../../lib/canonical-event.ts";

const SKIP_EVENTS = new Set([
  "session.heartbeat",
  "orchestrator.archived",
  "session.started",
  "session.ended",
]);

export function shouldSkipEvent(event: CanonicalEvent): boolean {
  const name = event.attributes?.["event.name"];
  if (!name) return true; // skip legacy/malformed events missing the canonical envelope
  if (SKIP_EVENTS.has(name)) return true;
  if (name === "github.check_run.completed") {
    const c = event.attributes["cicd.pipeline.run.conclusion"];
    if (c === "success" || c === "neutral" || c === "skipped") return true;
  }
  if (name.startsWith("filter.wake")) {
    const payload = event.body?.payload as Record<string, string> | undefined;
    const reason = payload?.reason ?? "";
    if (reason.includes("No matching events found")) return true;
  }
  return false;
}

export function formatTime(event: CanonicalEvent): string {
  const d = new Date(event.ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export function formatRepo(event: CanonicalEvent): string {
  const repo = event.attributes["vcs.repository.name"] ?? "";
  return repo.includes("/") ? (repo.split("/").pop() ?? repo) : repo;
}

export function formatSource(event: CanonicalEvent): string {
  const name = event.attributes?.["event.name"];
  if (!name) return "legacy";
  if (name.startsWith("github.")) return "github";
  if (name.startsWith("linear.")) return "linear";
  if (name === "comms.message.posted") return "comms";
  if (name.startsWith("filter.")) return "filter";
  const orchId = event.attributes["catalyst.orchestrator.id"];
  const worker = event.attributes["catalyst.worker.ticket"];
  if (orchId && worker) return `${orchId}/${worker}`;
  if (orchId) return orchId;
  return "system";
}

const EVENT_LABELS: Record<string, string> = {
  "github.pr.merged": "merged",
  "github.pr.opened": "pr open",
  "github.pr.closed": "pr closed",
  "orchestrator.worker.done": "done",
  "orchestrator.worker.failed": "failed",
  "orchestrator.attention.raised": "attention",
  "comms.message.posted": "comms",
  "session.phase": "phase",
};

export function formatEvent(event: CanonicalEvent): string {
  const name = event.attributes?.["event.name"];
  if (!name) return "(legacy)";
  if (name === "github.check_suite.completed") {
    const c = event.attributes["cicd.pipeline.run.conclusion"];
    return c === "success" ? "ci pass" : "ci fail";
  }
  const label = EVENT_LABELS[name] ?? name;
  return label.slice(0, 15);
}

export function formatRef(event: CanonicalEvent): string {
  const pr = event.attributes["vcs.pr.number"];
  if (pr) return `#${pr}`;
  const ticket = event.attributes["linear.issue.identifier"];
  if (ticket) return ticket;
  const branch = event.attributes["vcs.ref.name"];
  if (branch) return `→${branch}`;
  return "";
}

export function formatDetails(event: CanonicalEvent): string {
  const payload = event.body?.payload;
  const msg = event.body?.message ?? "";
  if (payload && typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    const title = p["title"];
    if (typeof title === "string") return title;
    const body = p["body"];
    if (typeof body === "string") return body.slice(0, 80);
  }
  return msg.slice(0, 80);
}
