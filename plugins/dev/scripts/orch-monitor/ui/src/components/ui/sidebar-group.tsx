import { useState, type ReactNode } from "react";
import { ChevronRight, ChevronDown, Folder } from "lucide-react";

interface SidebarGroupProps {
  label: string;
  count: number;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function SidebarGroup({
  label,
  count,
  defaultOpen = true,
  children,
}: SidebarGroupProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mt-3 first:mt-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface-3"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted" />
        )}
        <Folder className="h-3 w-3 flex-shrink-0 text-muted" />
        <span className="flex-1 truncate text-[10px] font-semibold uppercase tracking-wider text-muted">
          {label}
        </span>
        <span className="rounded-full bg-surface-3 px-1.5 py-px text-[9px] font-bold text-muted tabular-nums">
          {count}
        </span>
      </button>
      {open && <div className="ml-2">{children}</div>}
    </div>
  );
}
