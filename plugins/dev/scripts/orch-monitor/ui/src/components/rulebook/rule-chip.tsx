// rule-chip.tsx — CTL-1328: the quiet relation/cfg chip shared by the board card
// and the drawer. A leading arrow shows the direction of the relation (→ feeds,
// ← reads, ⊣ negates); `mono` is for cfg keys.
import { cn } from "@/lib/utils";

export function RuleChip({
  label,
  arrow,
  mono,
  className,
}: {
  label: string;
  arrow?: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded border bg-muted/40 px-1.5 py-px text-[10px] leading-none text-muted-foreground",
        mono && "font-mono",
        className,
      )}
    >
      {arrow && <span className="text-muted-foreground/50">{arrow}</span>}
      {label}
    </span>
  );
}
