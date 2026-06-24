// severity-pill.tsx — CTL-1328: the severity tag used on board cards and in the
// drawer. Colour comes from the shared `severityTone` token (info/warn/error),
// so the pill stays on the rulebook palette; the tint is `bg-current/10` (the
// same severity colour at 10%), never a hard-coded hex.
import { cn } from "@/lib/utils";
import { severityTone } from "@/lib/rulebook-theme";

export function SeverityPill({
  severity,
  className,
}: {
  severity: string;
  className?: string;
}) {
  if (!severity) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-medium leading-none",
        "bg-current/10",
        severityTone(severity),
        className,
      )}
    >
      {severity}
    </span>
  );
}
