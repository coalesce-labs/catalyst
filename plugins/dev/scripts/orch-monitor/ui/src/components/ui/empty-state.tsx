import { cn } from "@/lib/utils";
import { Inbox, type LucideIcon } from "lucide-react";

interface EmptyStateProps {
  message: string;
  icon?: LucideIcon;
  className?: string;
}

export function EmptyState({
  message,
  icon: Icon = Inbox,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 py-12 text-muted",
        className,
      )}
    >
      <Icon className="h-8 w-8 opacity-40" />
      <span className="text-[13px]">{message}</span>
    </div>
  );
}
