import { cn } from "@/lib/utils";
import { EmptyState } from "./ui/empty-state";
import type { EventEntry } from "@/lib/types";
import { Radio } from "lucide-react";

interface EventLogProps {
  events: EventEntry[];
  filterOrchId?: string | null;
}

const KIND_STYLES: Record<string, string> = {
  status: "bg-[#1f3a5a] text-[#9ec7f4]",
  phase: "bg-[#2a3c1f] text-[#b5d67a]",
  pr: "bg-[#3a2a5a] text-[#c8a8f4]",
  live: "bg-[#5a2a2a] text-[#f4a8a8]",
  attn: "bg-[#5a4a1a] text-[#f4dc8a]",
  new: "bg-[#1a4a3a] text-[#8af4cc]",
  wave: "bg-[#4a3a1f] text-[#f4c88a] font-bold",
  brief: "bg-[#3a4a1a] text-[#c8f48a]",
};

export function EventLog({ events, filterOrchId }: EventLogProps) {
  const filtered = filterOrchId
    ? events.filter((e) => !e.orchId || e.orchId === filterOrchId)
    : events;

  if (!filtered.length) {
    return <EmptyState icon={Radio} message="No events yet" />;
  }

  return (
    <div className="max-h-[420px] overflow-y-auto">
      {filtered.map((e, i) => (
        <div
          key={i}
          className="flex items-baseline gap-2 border-b border-border-subtle px-3 py-1.5 font-mono text-[12px]"
        >
          <span className="shrink-0 text-muted tabular-nums">{e.when}</span>
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-px text-[10px] uppercase tracking-wider",
              KIND_STYLES[e.kind] || "bg-surface-3 text-muted",
            )}
          >
            {e.kind}
          </span>
          <span className="min-w-0 flex-1 text-fg">{e.message}</span>
        </div>
      ))}
    </div>
  );
}
