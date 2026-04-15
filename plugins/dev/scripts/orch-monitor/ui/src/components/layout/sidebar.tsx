import { cn } from "@/lib/utils";
import type { OrchestratorState, ConnectionStatus } from "@/lib/types";
import { computeOrchestratorStats } from "@/lib/computations";
import { NavItem } from "../ui/nav-item";
import { HealthIcon, ConnectionDot } from "../ui/status-dot";
import { LayoutDashboard, ChevronRight } from "lucide-react";

interface SidebarProps {
  orchestrators: OrchestratorState[];
  selectedOrchId: string | null;
  onSelect: (orchId: string | null) => void;
  connectionStatus: ConnectionStatus;
  attentionCount: number;
  collapsed?: boolean;
  onToggle?: () => void;
}

export function Sidebar({
  orchestrators,
  selectedOrchId,
  onSelect,
  connectionStatus,
  attentionCount,
  collapsed = false,
}: SidebarProps) {
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
        <div className="min-w-0">
          <div className="text-sm font-semibold text-fg">Catalyst</div>
          <div className="text-[11px] text-muted">Orchestration Monitor</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
          Navigation
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

        {orchestrators.length > 0 && (
          <>
            <div className="mt-4 mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
              Orchestrators
            </div>
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
