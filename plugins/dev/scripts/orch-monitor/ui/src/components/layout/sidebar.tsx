import { useState } from "react";
import { cn } from "@/lib/utils";
import type { OrchestratorState, ConnectionStatus, SessionState } from "@/lib/types";
import { sessionKind, SESSION_TIME_FILTERS, type SessionTimeFilter } from "@/lib/types";
import { filterSessions } from "@/lib/session-filters";
import { computeOrchestratorStats } from "@/lib/computations";
import { fmtSince } from "@/lib/formatters";
import { groupSidebarItems, type GroupingMode } from "@/lib/grouping";
import { NavItem } from "../ui/nav-item";
import { SidebarGroup } from "../ui/sidebar-group";
import { HealthIcon, StatusDot, ConnectionDot } from "../ui/status-dot";
import { LayoutDashboard, ChevronRight, Terminal, Workflow } from "lucide-react";

const GROUPING_MODES = ["flat", "repo", "ticket"] as const;

interface SidebarProps {
  orchestrators: OrchestratorState[];
  sessions: SessionState[];
  selectedOrchId: string | null;
  onSelect: (orchId: string | null) => void;
  selectedSessionId?: string | null;
  onSessionSelect?: (sessionId: string) => void;
  connectionStatus: ConnectionStatus;
  attentionCount: number;
  collapsed?: boolean;
  onToggle?: () => void;
  groupingMode: GroupingMode;
  onGroupingModeChange: (mode: GroupingMode) => void;
}

export function Sidebar({
  orchestrators,
  sessions,
  selectedOrchId,
  onSelect,
  selectedSessionId,
  onSessionSelect,
  connectionStatus,
  attentionCount,
  collapsed = false,
  groupingMode,
  onGroupingModeChange,
}: SidebarProps) {
  const [timeFilter, setTimeFilter] = useState<SessionTimeFilter>(() => {
    const stored = localStorage.getItem("catalyst-session-filter");
    return SESSION_TIME_FILTERS.includes(stored as SessionTimeFilter)
      ? (stored as SessionTimeFilter)
      : "active";
  });

  const handleTimeFilterChange = (filter: SessionTimeFilter) => {
    setTimeFilter(filter);
    localStorage.setItem("catalyst-session-filter", filter);
  };

  const { active: activeSessions, dead: recentDead } = filterSessions(sessions, timeFilter);

  const groups = groupSidebarItems(orchestrators, activeSessions, recentDead, groupingMode);
  const isFlat = groupingMode === "flat";

  return (
    <aside
      style={{ width: collapsed ? 0 : 240 }}
      className={cn(
        "flex h-screen flex-shrink-0 flex-col overflow-hidden border-r bg-surface-1 transition-all duration-200",
        collapsed ? "border-transparent" : "border-border",
      )}
    >
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <img
          src="/public/catalyst-logo.svg"
          alt="Catalyst"
          className="h-5 w-5 flex-shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fg">Catalyst</div>
          <div className="text-[11px] text-muted">Monitor</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <div className="mb-1 flex items-center justify-between px-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
            Navigation
          </div>
          <div className="flex rounded-md border border-border">
            {GROUPING_MODES.map((m) => (
              <button
                key={m}
                onClick={() => onGroupingModeChange(m)}
                className={cn(
                  "px-2 py-0.5 text-[9px] font-medium capitalize transition-colors first:rounded-l-[5px] last:rounded-r-[5px]",
                  groupingMode === m
                    ? "bg-accent/15 text-accent"
                    : "text-muted hover:bg-surface-3 hover:text-fg",
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <NavItem active={selectedOrchId === null} onClick={() => onSelect(null)}>
          <LayoutDashboard className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1 font-medium">Dashboard</span>
          {attentionCount > 0 && (
            <span className="rounded-full bg-red/20 px-1.5 py-0.5 text-[10px] font-bold text-red tabular-nums">
              {attentionCount}
            </span>
          )}
        </NavItem>

        <SessionTimeFilterBar filter={timeFilter} onChange={handleTimeFilterChange} className="mt-3 mb-1 px-2" />

        {isFlat ? (
          <FlatSections
            orchestrators={orchestrators}
            activeSessions={activeSessions}
            recentDead={recentDead}
            selectedOrchId={selectedOrchId}
            onSelect={onSelect}
            selectedSessionId={selectedSessionId}
            onSessionSelect={onSessionSelect}
          />
        ) : (
          <>
          {groups.map((group) => {
            const itemCount =
              group.orchestrators.length +
              group.activeSessions.length +
              group.recentDead.length;
            if (itemCount === 0) return null;
            return (
              <SidebarGroup key={group.key} label={group.label} count={itemCount}>
                <OrchestratorList
                  orchestrators={group.orchestrators}
                  selectedOrchId={selectedOrchId}
                  onSelect={onSelect}
                />
                <SessionList
                  activeSessions={group.activeSessions}
                  recentDead={group.recentDead}
                  selectedSessionId={selectedSessionId}
                  onSessionSelect={onSessionSelect}
                />
              </SidebarGroup>
            );
          })}
          </>
        )}
      </nav>

      <div className="border-t border-border px-4 py-2.5">
        <div className="flex items-center gap-2 text-[12px]">
          <ConnectionDot status={connectionStatus} />
          <span className="text-muted">{connectionStatus}</span>
        </div>
      </div>
    </aside>
  );
}

function FlatSections({
  orchestrators,
  activeSessions,
  recentDead,
  selectedOrchId,
  onSelect,
  selectedSessionId,
  onSessionSelect,
}: {
  orchestrators: OrchestratorState[];
  activeSessions: SessionState[];
  recentDead: SessionState[];
  selectedOrchId: string | null;
  onSelect: (orchId: string | null) => void;
  selectedSessionId?: string | null;
  onSessionSelect?: (sessionId: string) => void;
}) {
  return (
    <>
      {orchestrators.length > 0 && (
        <>
          <div className="mt-4 mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
            Orchestrators
          </div>
          <OrchestratorList
            orchestrators={orchestrators}
            selectedOrchId={selectedOrchId}
            onSelect={onSelect}
          />
        </>
      )}

      <div className="mt-4 mb-1 px-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          Sessions
          {activeSessions.length > 0 && (
            <span className="ml-1.5 rounded-full bg-green/20 px-1.5 py-px text-[9px] font-bold text-green tabular-nums">
              {activeSessions.length}
            </span>
          )}
        </div>
      </div>
      {(activeSessions.length > 0 || recentDead.length > 0) ? (
        <SessionList activeSessions={activeSessions} recentDead={recentDead} selectedSessionId={selectedSessionId} onSessionSelect={onSessionSelect} />
      ) : (
        <div className="px-2 py-3 text-center text-[11px] text-muted">
          No sessions
        </div>
      )}
    </>
  );
}

function OrchestratorList({
  orchestrators,
  selectedOrchId,
  onSelect,
}: {
  orchestrators: OrchestratorState[];
  selectedOrchId: string | null;
  onSelect: (orchId: string | null) => void;
}) {
  return (
    <>
      {orchestrators.map((o) => {
        const s = computeOrchestratorStats(o, {});
        const isActive = selectedOrchId === o.id;
        return (
          <NavItem
            key={o.id}
            active={isActive}
            onClick={() => onSelect(o.id)}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <HealthIcon
                  failed={s.failed}
                  active={s.active}
                  size="h-3.5 w-3.5"
                />
                <span className="truncate font-mono text-[12px] font-medium">
                  {o.id}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                <span>
                  {s.done}/{s.total} done
                </span>
                <span>
                  W{o.currentWave}/{o.totalWaves}
                </span>
              </div>
            </div>
            <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-border transition-colors group-hover:text-muted" />
          </NavItem>
        );
      })}
    </>
  );
}

function SessionList({
  activeSessions,
  recentDead,
  selectedSessionId,
  onSessionSelect,
}: {
  activeSessions: SessionState[];
  recentDead: SessionState[];
  selectedSessionId?: string | null;
  onSessionSelect?: (sessionId: string) => void;
}) {
  if (activeSessions.length === 0 && recentDead.length === 0) return null;

  return (
    <ul role="list" className="space-y-0.5">
      {activeSessions.map((s) => {
        const kind = sessionKind(s);
        const label = s.label || s.ticket || s.sessionId.slice(-12);
        const elapsed = s.startedAt
          ? (Date.now() - Date.parse(s.startedAt)) / 1000
          : 0;
        const isSelected = selectedSessionId === s.sessionId;
        return (
          <li key={s.sessionId}>
            <button
              onClick={() => onSessionSelect?.(s.sessionId)}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md border-l-[3px] px-2.5 py-1.5 text-left transition-colors hover:bg-surface-3",
                isSelected
                  ? "border-accent bg-surface-3/80"
                  : "border-transparent",
              )}
              aria-label={`${label} — ${kind}, ${s.alive ? "running" : s.status}`}
            >
              <StatusDot alive={s.alive} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {kind === "orchestrator" ? (
                    <Workflow className="h-3 w-3 flex-shrink-0 text-accent" />
                  ) : (
                    <Terminal className="h-3 w-3 flex-shrink-0 text-green" />
                  )}
                  <span className="truncate text-[11px] font-medium text-fg">
                    {label}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted">
                  <span>{kind}</span>
                  {s.skillName && s.skillName !== "interactive" && (
                    <span className="font-mono">{s.skillName}</span>
                  )}
                  {elapsed > 0 && <span>{fmtSince(elapsed)}</span>}
                </div>
              </div>
            </button>
          </li>
        );
      })}
      {recentDead.map((s) => {
        const kind = sessionKind(s);
        const label = s.label || s.ticket || s.sessionId.slice(-12);
        const isSelected = selectedSessionId === s.sessionId;
        return (
          <li key={s.sessionId}>
            <button
              onClick={() => onSessionSelect?.(s.sessionId)}
              className={cn(
                "group flex w-full items-center gap-2 rounded-md border-l-[3px] px-2.5 py-1.5 text-left transition-colors hover:bg-surface-3",
                isSelected
                  ? "border-accent bg-surface-3/80 opacity-80"
                  : "border-transparent opacity-50 hover:opacity-80",
              )}
              aria-label={`${label} — ${kind}, ${s.status}`}
            >
              <StatusDot alive={false} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <Terminal className="h-3 w-3 flex-shrink-0 text-muted" />
                  <span className="truncate text-[11px] font-medium text-fg">
                    {label}
                  </span>
                </div>
                <div className="mt-0.5 text-[10px] text-muted">
                  {kind} &middot; {s.status}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const FILTER_LABELS: Record<SessionTimeFilter, string> = {
  active: "Active",
  "1h": "1h",
  "24h": "24h",
  "48h": "48h",
  all: "All",
};

function SessionTimeFilterBar({
  filter,
  onChange,
  className,
}: {
  filter: SessionTimeFilter;
  onChange: (f: SessionTimeFilter) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-0.5", className)}>
      {SESSION_TIME_FILTERS.map((f) => (
        <button
          key={f}
          onClick={() => onChange(f)}
          className={cn(
            "rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors",
            filter === f
              ? "bg-accent/15 text-accent"
              : "text-muted hover:bg-surface-3 hover:text-fg",
          )}
        >
          {FILTER_LABELS[f]}
        </button>
      ))}
    </div>
  );
}
