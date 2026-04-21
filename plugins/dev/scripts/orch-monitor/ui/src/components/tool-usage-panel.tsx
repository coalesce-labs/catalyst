import { Wrench } from "lucide-react";
import { Panel, PanelHeader, SectionLabel } from "./ui/panel";
import { EmptyState } from "./ui/empty-state";

interface ToolUsagePanelProps {
  tools: Record<string, number> | null;
  configured: boolean;
}

const MAX_ROWS = 8;

export function ToolUsagePanel({ tools, configured }: ToolUsagePanelProps) {
  if (!configured) return null;

  return (
    <Panel>
      <PanelHeader className="flex items-center justify-between">
        <SectionLabel>Tool usage · last 1h</SectionLabel>
        <Wrench className="h-3.5 w-3.5 text-muted" />
      </PanelHeader>
      <div className="p-3">{renderBody(tools)}</div>
    </Panel>
  );
}

function renderBody(tools: Record<string, number> | null) {
  if (tools === null) {
    return (
      <div className="flex flex-col gap-1.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-4 animate-pulse rounded bg-surface-3 opacity-60"
          />
        ))}
      </div>
    );
  }

  const entries = Object.entries(tools).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return <EmptyState icon={Wrench} message="No tool usage in the last hour" />;
  }

  const top = entries.slice(0, MAX_ROWS);
  const maxCount = top[0]?.[1] ?? 1;

  return (
    <div className="flex flex-col gap-1.5 font-mono text-[12px]">
      {top.map(([name, count]) => {
        const pct = Math.max(4, Math.round((count / maxCount) * 100));
        return (
          <div key={name} className="flex items-center gap-2">
            <span className="w-24 shrink-0 truncate text-fg">{name}</span>
            <div className="relative h-3 flex-1 overflow-hidden rounded bg-surface-3">
              <div
                className="h-full bg-gradient-to-r from-accent to-green"
                style={{ width: pct + "%" }}
              />
            </div>
            <span className="w-10 shrink-0 text-right tabular-nums text-muted">
              {count}
            </span>
          </div>
        );
      })}
    </div>
  );
}
