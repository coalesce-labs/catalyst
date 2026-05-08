import { cn } from "@/lib/utils";
import type { ActivityEvent } from "@/hooks/use-activity";
import { summarizeLinearEvent } from "../../../lib/summarize-linear-event";

function repoBasename(repo: string): string {
  const slash = repo.lastIndexOf("/");
  return slash >= 0 ? repo.slice(slash + 1) : repo;
}

function stripRefPrefix(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return ref;
}

/**
 * One row in the activity feed: timestamp + source chip + topic chip + scope chips +
 * one-line summary of the event detail. Clicking a scope chip with both
 * orchestrator + worker calls `onPivot` so the parent can switch to the
 * orchestrator view and open the worker drawer.
 */

type SourceLabel = "GitHub" | "Linear" | "Comms" | "Filter" | "System";

const SOURCE_CHIP_STYLES: Record<SourceLabel, string> = {
  GitHub: "bg-[#1f3a5a] text-[#9ec7f4]",
  Linear: "bg-[#3a2a5a] text-[#c8a8f4]",
  Comms: "bg-[#4a3a1f] text-[#f4c88a]",
  Filter: "bg-[#1a4a3a] text-[#8af4cc]",
  System: "bg-surface-3 text-muted",
};

const TOPIC_PREFIX_STYLES: Array<{ prefix: string; cls: string }> = [
  { prefix: "github.pr.", cls: "bg-[#3a2a5a] text-[#c8a8f4]" },
  { prefix: "github.check_suite.", cls: "bg-[#1f3a5a] text-[#9ec7f4]" },
  { prefix: "github.status.", cls: "bg-[#1f3a5a] text-[#9ec7f4]" },
  { prefix: "github.deployment", cls: "bg-[#1a4a3a] text-[#8af4cc]" },
  { prefix: "github.push", cls: "bg-[#2a3c1f] text-[#b5d67a]" },
  { prefix: "github.pr_review", cls: "bg-[#4a3a1f] text-[#f4c88a]" },
  { prefix: "github.issue_comment", cls: "bg-[#4a3a1f] text-[#f4c88a]" },
  { prefix: "github.", cls: "bg-surface-3 text-muted" },
  { prefix: "linear.", cls: "bg-[#1a4a4a] text-[#8ae6f4]" },
  { prefix: "filter.", cls: "bg-[#1a4040] text-[#7ae8e8]" },
  { prefix: "comms.", cls: "bg-[#3a4a1a] text-[#c8f48a]" },
  { prefix: "session.", cls: "bg-[#5a4a1a] text-[#f4dc8a]" },
  { prefix: "orchestrator.worker.", cls: "bg-[#1f3a5a] text-[#9ec7f4]" },
  { prefix: "orchestrator.", cls: "bg-[#5a2a2a] text-[#f4a8a8]" },
  { prefix: "orchestrator.attention.", cls: "bg-[#5a2a2a] text-[#f4a8a8]" },
];

function topicStyle(topic: string): string {
  for (const { prefix, cls } of TOPIC_PREFIX_STYLES) {
    if (topic.startsWith(prefix)) return cls;
  }
  return "bg-surface-3 text-muted";
}

function deriveSource(event: ActivityEvent): SourceLabel | null {
  const eventName = event.attributes["event.name"];
  if (eventName === "session.heartbeat") return null;
  // Use resource service.name as authoritative source
  const serviceName = event.resource["service.name"];
  if (serviceName === "catalyst.github") return "GitHub";
  if (serviceName === "catalyst.linear") return "Linear";
  if (serviceName === "catalyst.comms") return "Comms";
  if (serviceName === "catalyst.filter") {
    const payload = (event.body?.payload ?? {}) as Record<string, unknown>;
    const reason = (payload.reason as string) ?? "";
    if (reason === "No matching events found") return null;
    return "Filter";
  }
  // Fall back to event name prefix for robustness
  if (eventName.startsWith("github.")) return "GitHub";
  if (eventName.startsWith("linear.")) return "Linear";
  if (eventName.startsWith("comms.")) return "Comms";
  if (eventName.startsWith("filter.")) {
    const payload = (event.body?.payload ?? {}) as Record<string, unknown>;
    const reason = (payload.reason as string) ?? "";
    if (reason === "No matching events found") return null;
    return "Filter";
  }
  return "System";
}

function fmtTime(ts: string): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}

function summarize(e: ActivityEvent): string {
  const eventName = e.attributes["event.name"];
  const payload = (e.body?.payload ?? {}) as Record<string, unknown>;
  const pr = e.attributes["vcs.pr.number"];
  const repo = e.attributes["vcs.repository.name"] ?? "";
  const ticket = e.attributes["linear.issue.identifier"] ?? "";
  const orchId = e.attributes["catalyst.orchestrator.id"] ?? "?";

  // GitHub family
  if (eventName.startsWith("github.pr.")) {
    const verb = eventName.slice("github.pr.".length);
    const user =
      ((payload as { user?: { login?: string } }).user?.login as string) ??
      ((payload as { sender?: { login?: string } }).sender?.login as string) ??
      "";
    return `${repo ? repo + " " : ""}PR #${pr ?? "?"} ${verb}${user ? ` by ${user}` : ""}`;
  }
  if (eventName.startsWith("github.check_suite.")) {
    const conclusion =
      e.attributes["cicd.pipeline.run.conclusion"] ??
      (payload.conclusion as string | undefined) ??
      "?";
    const sha =
      ((payload.head_sha as string) ?? "").slice(0, 7) ||
      (e.attributes["vcs.revision"] ?? "").slice(0, 7);
    return `${conclusion} on ${sha || "?"}`;
  }
  if (eventName.startsWith("github.deployment_status.")) {
    const state = eventName.slice("github.deployment_status.".length);
    const env = e.attributes["deployment.environment"] ?? "?";
    return `${state} on ${env}`;
  }
  if (eventName === "github.push") {
    const ref = e.attributes["vcs.ref.name"] ?? "?";
    return `${repo || "?"} ${ref}`;
  }
  if (eventName === "github.pr_review.submitted") {
    const verb = (payload as { state?: string }).state ?? "submitted";
    return `review ${verb} on PR #${pr ?? "?"}`;
  }
  // Linear
  if (eventName.startsWith("linear.comment.")) {
    const action = eventName.slice("linear.comment.".length);
    if (action === "created") return `new comment${ticket ? " · " + ticket : ""}`;
    return `comment ${action}${ticket ? " · " + ticket : ""}`;
  }
  if (eventName.startsWith("linear.cycle.")) {
    const action = eventName.slice("linear.cycle.".length);
    return `cycle ${action}`;
  }
  if (eventName.startsWith("linear.issue.") || eventName.startsWith("linear.issue_label.")) {
    const keys = (payload as { updatedFromKeys?: string[] }).updatedFromKeys ?? [];
    return summarizeLinearEvent(eventName, ticket || undefined, keys);
  }
  if (eventName.startsWith("linear.")) {
    return `${ticket} ${eventName.slice("linear.".length)}`.trim();
  }
  // Comms
  if (eventName === "comms.message.posted") {
    const channel = (payload as { channel?: string }).channel ?? "?";
    const type = (payload as { type?: string }).type ?? "info";
    const body = (payload as { body?: string }).body ?? "";
    const from = e.attributes["catalyst.worker.ticket"] ?? "";
    const prefix = `[${type}] ${channel}${from ? ` (${from})` : ""}`;
    return body ? `${prefix}: ${body}` : prefix;
  }
  // Catalyst session lifecycle
  if (eventName === "session.phase") {
    const to = (payload as { to?: string }).to ?? "?";
    return `→ ${to}`;
  }
  if (eventName === "session.started" || eventName === "session.ended") {
    const status = (payload as { status?: string }).status;
    return status ? `${status}` : eventName;
  }
  if (eventName === "session.pr_opened") {
    const prNum = pr ?? (payload as { pr?: number }).pr ?? "?";
    return `PR #${prNum} opened`;
  }
  if (eventName.startsWith("orchestrator.worker.")) {
    const reason = (payload as { reason?: string }).reason ?? "";
    return reason || eventName;
  }
  // Filter daemon
  if (eventName === "filter.wake") {
    const reason = (payload as { reason?: string }).reason ?? "";
    const sourceIds = (payload as { source_event_ids?: unknown[] }).source_event_ids ?? [];
    if (reason === "No matching events found") return "";
    if (sourceIds.length === 0) return `Worker went silent — ${reason}`;
    return `Filter woke ${orchId} — ${reason}`;
  }
  if (eventName === "filter.register") {
    return `${orchId} registered filter interest`;
  }
  if (eventName === "filter.deregister") {
    return `${orchId} deregistered interest`;
  }
  // Fallback
  try {
    const s = JSON.stringify(e.body?.payload);
    if (s && s !== "null" && s !== "{}") return s.slice(0, 160);
  } catch {
    /* ignore */
  }
  return "";
}

interface RepoColor {
  bg?: string;
  text?: string;
}

function RepoChip({
  name,
  repoColors,
}: {
  name: string;
  repoColors?: Record<string, RepoColor>;
}) {
  const base = repoBasename(name);
  const color = repoColors?.[name] ?? repoColors?.[base];
  if (color?.bg && color?.text) {
    return (
      <span
        className="rounded px-1.5 py-px text-[10px]"
        style={{ backgroundColor: color.bg, color: color.text }}
      >
        {base}
      </span>
    );
  }
  return (
    <span className="rounded bg-surface-3 px-1.5 py-px text-[10px] text-muted">
      {base}
    </span>
  );
}

interface Props {
  event: ActivityEvent;
  onPivot?: (orchId: string, ticket: string) => void;
  repoColors?: Record<string, RepoColor>;
}

export function ActivityEventRow({ event, onPivot, repoColors }: Props) {
  const eventName = event.attributes["event.name"];
  const orch = event.attributes["catalyst.orchestrator.id"] ?? null;
  const worker = event.attributes["catalyst.worker.ticket"] ?? null;
  const ticket = event.attributes["linear.issue.identifier"] ?? null;
  const repo = event.attributes["vcs.repository.name"] ?? null;
  const pr = event.attributes["vcs.pr.number"] ?? null;
  const ref = event.attributes["vcs.ref.name"] ?? null;

  const isLinear = eventName.startsWith("linear.");
  const canPivot = !!(onPivot && orch && worker);
  const sourceLabel = deriveSource(event);

  return (
    <div className="flex items-baseline gap-2 border-b border-border-subtle px-3 py-1.5 font-mono text-[12px]">
      <span className="shrink-0 text-muted tabular-nums">{fmtTime(event.ts)}</span>
      {sourceLabel && (
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-px text-[10px] font-semibold tracking-wider",
            SOURCE_CHIP_STYLES[sourceLabel],
          )}
        >
          {sourceLabel}
        </span>
      )}
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-px text-[10px] tracking-wider",
          topicStyle(eventName),
        )}
      >
        {eventName}
      </span>
      <span className="min-w-0 flex-1 truncate text-fg">{summarize(event)}</span>
      <span className="flex shrink-0 items-center gap-1">
        {canPivot && (
          <button
            type="button"
            onClick={() => onPivot!(orch!, worker!)}
            className="rounded bg-surface-3 px-1.5 py-px text-[10px] text-muted hover:bg-accent/20 hover:text-accent"
            title="Open worker drawer"
          >
            {worker}
          </button>
        )}
        {!canPivot && worker && (
          <span className="rounded bg-surface-3 px-1.5 py-px text-[10px] text-muted">
            {worker}
          </span>
        )}
        {ticket && (
          <span className="rounded bg-surface-3 px-1.5 py-px text-[10px] text-muted">
            {ticket}
          </span>
        )}
        {!isLinear && repo && pr !== null && (() => {
          const base = repoBasename(repo);
          const color = repoColors?.[repo] ?? repoColors?.[base];
          if (color?.bg && color?.text) {
            return (
              <span
                className="rounded px-1.5 py-px text-[10px]"
                style={{ backgroundColor: color.bg, color: color.text }}
              >
                {base}#{pr}
              </span>
            );
          }
          return (
            <span className="rounded bg-surface-3 px-1.5 py-px text-[10px] text-muted">
              {base}#{pr}
            </span>
          );
        })()}
        {repo && pr === null && (
          <RepoChip name={repo} repoColors={repoColors} />
        )}
        {ref && (
          <span className="rounded bg-surface-3 px-1.5 py-px text-[10px] text-muted">
            {stripRefPrefix(ref)}
          </span>
        )}
      </span>
    </div>
  );
}
