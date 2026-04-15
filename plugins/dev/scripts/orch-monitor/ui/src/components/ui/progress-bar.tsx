import { cn } from "@/lib/utils";

interface ProgressBarProps {
  pct: number;
  className?: string;
  trackClass?: string;
}

export function ProgressBar({
  pct,
  className,
  trackClass = "bg-surface-3",
}: ProgressBarProps) {
  return (
    <div className={cn("h-1.5 w-full rounded-full", trackClass, className)}>
      <div
        className="h-full rounded-full bg-gradient-to-r from-accent to-green transition-all duration-500"
        style={{ width: Math.min(100, Math.max(0, pct)) + "%" }}
      />
    </div>
  );
}
