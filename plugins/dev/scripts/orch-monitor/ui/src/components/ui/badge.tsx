import { cn } from "@/lib/utils";
import {
  statusSemantic,
  SEMANTIC_BADGE_CLASSES,
  SEMANTIC_PILL_CLASSES,
} from "@/lib/formatters";

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const sem = statusSemantic(status);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap",
        SEMANTIC_BADGE_CLASSES[sem],
        className,
      )}
    >
      {status}
    </span>
  );
}

export function StatusPill({
  label,
  status,
  className,
}: {
  label: string;
  status: string;
  className?: string;
}) {
  const sem = statusSemantic(status);
  return (
    <span
      className={cn(
        "rounded px-1.5 py-px font-mono text-[11px]",
        SEMANTIC_PILL_CLASSES[sem],
        className,
      )}
    >
      {label}
    </span>
  );
}
