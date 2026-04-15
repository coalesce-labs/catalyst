import { cn } from "@/lib/utils";
import type { CollectedAttention } from "@/lib/types";
import { AlertCircle, CheckCircle2 } from "lucide-react";

interface AttentionBarProps {
  items: CollectedAttention[];
  onItemClick?: (orchId: string, ticket: string) => void;
}

export function AttentionBar({ items, onItemClick }: AttentionBarProps) {
  if (!items.length) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-green/20 bg-green/5 px-4 py-2 text-[12px] text-green">
        <CheckCircle2 className="h-3.5 w-3.5" />
        All clear
      </div>
    );
  }

  const errors = items.filter((i) => i.severity === "error").length;
  const warnings = items.length - errors;

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted">
          <AlertCircle className="h-3.5 w-3.5 text-red" />
          Needs attention
        </div>
        <span className="font-mono text-[11px] text-fg">
          {errors > 0 && `${errors} error${errors !== 1 ? "s" : ""}`}
          {errors > 0 && warnings > 0 && " · "}
          {warnings > 0 && `${warnings} warning${warnings !== 1 ? "s" : ""}`}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {items.map((item, i) => (
          <button
            key={i}
            onClick={() => onItemClick?.(item.orchId, item.ticket)}
            className={cn(
              "flex items-center gap-2 rounded px-3 py-1.5 text-left text-[13px] transition-colors",
              item.severity === "error"
                ? "border-l-[3px] border-red bg-red/8 hover:bg-red/15"
                : "border-l-[3px] border-yellow bg-yellow/8 hover:bg-yellow/15",
            )}
          >
            <span className="font-mono text-[12px] font-semibold text-accent">
              {item.ticket}
            </span>
            <span className="font-mono text-[11px] text-muted">
              {item.orchId}
            </span>
            <span
              className={cn(
                "flex-1",
                item.severity === "error" ? "text-[#f4a8a8]" : "text-[#f4dc8a]",
              )}
            >
              {item.reason}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
