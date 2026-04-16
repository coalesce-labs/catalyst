import { useState } from "react";
import { cn } from "@/lib/utils";
import { fmtSince, fmtTokens, fmtCost } from "@/lib/formatters";
import { StatusBadge } from "./ui/badge";
import { StatusDot } from "./ui/status-dot";
import { ExternalLink } from "./ui/external-link";
import { SectionLabel } from "./ui/panel";
import type { SessionState } from "@/lib/types";
import { sessionKind } from "@/lib/types";
import {
  X,
  Terminal,
  Workflow,
  Clock,
  DollarSign,
  Zap,
  GitBranch,
  FolderOpen,
  Tag,
  Hash,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

interface SessionDetailDrawerProps {
  session: SessionState;
  onClose: () => void;
}

function MetricPill({
  icon,
  label,
  value,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border border-border bg-surface-3/50 px-2.5 py-1.5",
        className,
      )}
    >
      {icon}
      <span className="text-[10px] uppercase text-muted">{label}</span>
      <span className="font-mono text-[12px] font-semibold text-fg tabular-nums">
        {value}
      </span>
    </div>
  );
}

const KIND_ICON: Record<string, React.ReactNode> = {
  orchestrator: <Workflow className="h-3.5 w-3.5 text-accent" />,
  worker: <Terminal className="h-3.5 w-3.5 text-green" />,
  standalone: <Terminal className="h-3.5 w-3.5 text-muted" />,
};

export function SessionDetailDrawer({
  session,
  onClose,
}: SessionDetailDrawerProps) {
  const [rawOpen, setRawOpen] = useState(false);

  const kind = sessionKind(session);
  const label = session.label || session.ticket || session.sessionId;
  const elapsed = session.startedAt
    ? (Date.now() - Date.parse(session.startedAt)) / 1000
    : 0;
  const cost = session.cost?.costUSD || 0;
  const tokens = session.cost
    ? (session.cost.inputTokens || 0) +
      (session.cost.outputTokens || 0) +
      (session.cost.cacheReadTokens || 0)
    : 0;
  const dir = session.cwd ? session.cwd.split("/").slice(-2).join("/") : null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40"
        onClick={onClose}
      />
      <div className="animate-drawer-in fixed inset-y-0 right-0 z-50 flex w-[420px] max-w-[90vw] flex-col border-l border-border bg-surface-1 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <StatusDot alive={session.alive} />
              <span className="truncate font-mono text-sm font-bold text-fg">
                {label}
              </span>
              <StatusBadge status={session.status} />
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
              {KIND_ICON[kind]}
              <span>{kind}</span>
              {session.skillName && session.skillName !== "interactive" && (
                <span className="rounded bg-surface-3 px-1.5 py-px font-mono text-[11px]">
                  {session.skillName}
                </span>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-muted transition-colors hover:bg-surface-3 hover:text-fg"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          {/* Metrics strip */}
          <div className="flex flex-wrap gap-2 border-b border-border-subtle px-4 py-3">
            <MetricPill
              icon={<Clock className="h-3 w-3 text-muted" />}
              label="elapsed"
              value={fmtSince(elapsed)}
            />
            <MetricPill
              icon={<DollarSign className="h-3 w-3 text-muted" />}
              label="cost"
              value={cost > 0 ? fmtCost(cost) : "—"}
            />
            <MetricPill
              icon={<Zap className="h-3 w-3 text-muted" />}
              label="tokens"
              value={tokens > 0 ? fmtTokens(tokens) : "—"}
            />
          </div>

          {/* Details section */}
          <div className="border-b border-border-subtle px-4 py-3">
            <SectionLabel>Details</SectionLabel>
            <div className="mt-2 space-y-2.5">
              {session.ticket && (
                <div className="flex items-center gap-2 text-[12px]">
                  <Tag className="h-3 w-3 text-muted" />
                  <span className="text-muted">Ticket</span>
                  <span className="font-mono font-semibold text-fg">
                    {session.ticket}
                  </span>
                </div>
              )}
              {session.gitBranch && (
                <div className="flex items-center gap-2 text-[12px]">
                  <GitBranch className="h-3 w-3 text-muted" />
                  <span className="text-muted">Branch</span>
                  <span className="truncate font-mono text-fg">
                    {session.gitBranch}
                  </span>
                </div>
              )}
              {session.cwd && (
                <div className="flex items-center gap-2 text-[12px]">
                  <FolderOpen className="h-3 w-3 text-muted" />
                  <span className="text-muted">Directory</span>
                  <span
                    className="truncate font-mono text-fg"
                    title={session.cwd}
                  >
                    {dir}
                  </span>
                </div>
              )}
              <div className="flex items-center gap-2 text-[12px]">
                <Hash className="h-3 w-3 text-muted" />
                <span className="text-muted">Phase</span>
                <span className="font-mono text-fg">{session.phase}</span>
              </div>
              {session.workflowId && (
                <div className="flex items-center gap-2 text-[12px]">
                  <Workflow className="h-3 w-3 text-muted" />
                  <span className="text-muted">Workflow</span>
                  <span className="truncate font-mono text-[11px] text-fg">
                    {session.workflowId}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* PR info */}
          {session.pr && (
            <div className="border-b border-border-subtle px-4 py-3">
              <SectionLabel>Pull Request</SectionLabel>
              <div className="mt-1.5 flex items-center gap-2">
                {session.pr.url ? (
                  <ExternalLink href={session.pr.url}>
                    #{session.pr.number}
                  </ExternalLink>
                ) : (
                  <span className="font-mono text-[13px] text-fg">
                    #{session.pr.number}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Session ID + timestamps */}
          <div className="border-b border-border-subtle px-4 py-3">
            <SectionLabel>Timestamps</SectionLabel>
            <div className="mt-2 space-y-1.5 text-[11px]">
              <div className="flex justify-between">
                <span className="text-muted">Session ID</span>
                <span className="font-mono text-fg">{session.sessionId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Started</span>
                <span className="font-mono text-fg">
                  {new Date(session.startedAt).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted">Updated</span>
                <span className="font-mono text-fg">
                  {new Date(session.updatedAt).toLocaleString()}
                </span>
              </div>
              {session.completedAt && (
                <div className="flex justify-between">
                  <span className="text-muted">Completed</span>
                  <span className="font-mono text-fg">
                    {new Date(session.completedAt).toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Raw data (collapsible) */}
          <div className="px-4 py-3">
            <button
              onClick={() => setRawOpen(!rawOpen)}
              className="flex items-center gap-1.5 text-muted transition-colors hover:text-fg"
            >
              {rawOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              <SectionLabel>Raw Data</SectionLabel>
            </button>
            {rawOpen && (
              <pre className="mt-2 max-h-64 overflow-auto rounded border border-border bg-surface-3 p-3 font-mono text-[11px] text-fg">
                {JSON.stringify(session, null, 2)}
              </pre>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
