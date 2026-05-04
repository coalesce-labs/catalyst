import { cn } from "@/lib/utils";
import type { ActivityEvent } from "@/hooks/use-activity";

/**
 * One row in the activity feed: timestamp + topic chip + scope chips +
 * one-line summary of the event detail. Clicking a scope chip with both
 * orchestrator + worker (or v1 top-level orchestrator+worker) calls
 * `onPivot` so the parent can switch to the orchestrator view and open
 * the worker drawer.
 */

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
  { prefix: "comms.", cls: "bg-[#3a4a1a] text-[#c8f48a]" },
  { prefix: "session-", cls: "bg-[#5a4a1a] text-[#f4dc8a]" },
  { prefix: "phase-", cls: "bg-[#5a4a1a] text-[#f4dc8a]" },
  { prefix: "pr-opened", cls: "bg-[#3a2a5a] text-[#c8a8f4]" },
  { prefix: "worker-", cls: "bg-[#1f3a5a] text-[#9ec7f4]" },
  { prefix: "wave-", cls: "bg-[#4a3a1f] text-[#f4c88a]" },
  { prefix: "orchestrator-", cls: "bg-[#5a2a2a] text-[#f4a8a8]" },
  { prefix: "attention-", cls: "bg-[#5a2a2a] text-[#f4a8a8]" },
  { prefix: "verification-", cls: "bg-[#1a4a3a] text-[#8af4cc]" },
];

function topicStyle(topic: string): string {
  for (const { prefix, cls } of TOPIC_PREFIX_STYLES) {
    if (topic.startsWith(prefix)) return cls;
  }
  return "bg-surface-3 text-muted";
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
  const detail = (e.detail ?? {}) as Record<string, unknown>;
  const scope = e.scope ?? {};
  // GitHub family
  if (e.event.startsWith("github.pr.")) {
    const verb = e.event.slice("github.pr.".length);
    const pr = scope.pr ?? "?";
    const repo = scope.repo ?? "";
    const user =
      ((detail as { user?: { login?: string } }).user?.login as string) ??
      ((detail as { sender?: { login?: string } }).sender?.login as string) ??
      "";
    return `${repo ? repo + " " : ""}PR #${pr} ${verb}${user ? ` by ${user}` : ""}`;
  }
  if (e.event.startsWith("github.check_suite.")) {
    const conclusion = (detail.conclusion as string | undefined) ?? "?";
    const sha =
      ((detail.head_sha as string) ?? "").slice(0, 7) ||
      ((scope.sha as string) ?? "").slice(0, 7);
    return `${conclusion} on ${sha || "?"}`;
  }
  if (e.event.startsWith("github.deployment_status.")) {
    const state = e.event.slice("github.deployment_status.".length);
    const env = scope.environment ?? "?";
    return `${state} on ${env}`;
  }
  if (e.event === "github.push") {
    const ref = scope.ref ?? "?";
    const repo = scope.repo ?? "?";
    return `${repo} ${ref}`;
  }
  if (e.event === "github.pr_review.submitted") {
    const verb = (detail as { state?: string }).state ?? "submitted";
    return `review ${verb} on PR #${scope.pr ?? "?"}`;
  }
  // Linear
  if (e.event === "linear.issue.state_changed") {
    const fromV = (detail as { from?: string }).from ?? "?";
    const toV = (detail as { to?: string }).to ?? "?";
    return `${scope.ticket ?? "?"}: ${fromV} → ${toV}`;
  }
  if (e.event.startsWith("linear.")) {
    return `${scope.ticket ?? ""} ${e.event.slice("linear.".length)}`.trim();
  }
  // Comms
  if (e.event === "comms.message.posted") {
    const channel = (detail as { channel?: string }).channel ?? "?";
    const type = (detail as { type?: string }).type ?? "info";
    const from = e.worker ?? "";
    return `[${type}] ${channel}${from ? ` (${from})` : ""}`;
  }
  // Catalyst session lifecycle
  if (e.event === "phase-changed") {
    const to = (detail as { to?: string }).to ?? "?";
    return `→ ${to}`;
  }
  if (e.event === "session-started" || e.event === "session-ended") {
    const status = (detail as { status?: string }).status;
    return status ? `${status}` : e.event;
  }
  if (e.event === "pr-opened") {
    const pr = (detail as { pr?: number }).pr ?? "?";
    return `PR #${pr} opened`;
  }
  if (e.event.startsWith("worker-")) {
    const reason = (detail as { reason?: string }).reason ?? "";
    return reason || e.event;
  }
  // Fallback
  try {
    const s = JSON.stringify(e.detail);
    if (s && s !== "null" && s !== "{}") return s.slice(0, 160);
  } catch {
    /* ignore */
  }
  return "";
}

interface Props {
  event: ActivityEvent;
  onPivot?: (orchId: string, ticket: string) => void;
}

export function ActivityEventRow({ event, onPivot }: Props) {
  const scope = event.scope ?? {};
  const orch = scope.orchestrator ?? event.orchestrator ?? null;
  const worker = scope.worker ?? event.worker ?? null;
  const ticket = scope.ticket ?? null;
  const repo = scope.repo ?? null;
  const pr = scope.pr ?? null;

  const canPivot = !!(onPivot && orch && worker);

  return (
    <div className="flex items-baseline gap-2 border-b border-border-subtle px-3 py-1.5 font-mono text-[12px]">
      <span className="shrink-0 text-muted tabular-nums">{fmtTime(event.ts)}</span>
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-px text-[10px] tracking-wider",
          topicStyle(event.event),
        )}
      >
        {event.event}
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
        {repo && pr !== null && (
          <span className="rounded bg-surface-3 px-1.5 py-px text-[10px] text-muted">
            {repo}#{pr}
          </span>
        )}
      </span>
    </div>
  );
}
