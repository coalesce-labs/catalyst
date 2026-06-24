// state-chip.tsx — CTL-1328: the shared "render a workflow/status state" chip.
// The common renderer the operator asked for: it maps ANY state name to a
// semantic tone through the already-shared statusSemantic() + SEMANTIC_PILL_CLASSES
// (lib/formatters), so every surface renders a state the same calm way. New
// surfaces (e.g. the Rulebook eligible_state threshold) use this instead of
// hand-rolling a colour. (ticket-detail-page.tsx still has a local
// SEMANTIC_COLOR map — a candidate to migrate onto this chip as a follow-up.)
import { cn } from "@/lib/utils";
import { statusSemantic, SEMANTIC_PILL_CLASSES } from "@/lib/formatters";

export function StateChip({
  state,
  className,
}: {
  state: string;
  className?: string;
}) {
  const semantic = statusSemantic(state.toLowerCase());
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-none",
        SEMANTIC_PILL_CLASSES[semantic],
        className,
      )}
    >
      {state}
    </span>
  );
}
