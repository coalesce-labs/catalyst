import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface NavItemProps {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}

export function NavItem({ active, onClick, children, className }: NavItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-2.5 rounded-md border-l-[3px] px-2.5 py-2 text-left text-[13px] transition-colors",
        active
          ? "border-accent bg-accent/8 text-fg"
          : "border-transparent text-muted hover:bg-surface-3 hover:text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}
