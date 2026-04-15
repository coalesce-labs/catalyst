import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface PanelProps {
  children: ReactNode;
  className?: string;
}

export function Panel({ children, className }: PanelProps) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-surface-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface PanelHeaderProps {
  children: ReactNode;
  className?: string;
}

export function PanelHeader({ children, className }: PanelHeaderProps) {
  return (
    <div
      className={cn(
        "border-b border-border px-4 py-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SectionLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "text-[11px] font-semibold uppercase tracking-wider text-muted",
        className,
      )}
    >
      {children}
    </span>
  );
}

interface MetricCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: ReactNode;
  color: string;
}

export function MetricCard({ label, value, sub, icon, color }: MetricCardProps) {
  return (
    <div className="group flex items-start gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3 transition-colors hover:border-border hover:bg-surface-3/50">
      <div
        className={cn(
          "mt-0.5 transition-transform duration-200 group-hover:scale-110",
          color,
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <SectionLabel>{label}</SectionLabel>
        <div className="mt-0.5 font-mono text-xl font-bold text-fg tabular-nums">
          {value}
        </div>
        {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
      </div>
    </div>
  );
}
