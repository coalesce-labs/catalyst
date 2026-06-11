// all-clear-hero.tsx — the calm ALL-CLEAR reading-pane hero (CTL-904 / HOME6).
// The empty state is the relief payoff, designed as a FEATURE not a fallback: the
// demo / first-impression hero shot, the shoulders-drop moment the whole
// Direction-A page optimizes for. When nothing needs the operator (zero blocked +
// zero waiting — the read-model emptiness gate, isAllClear), Home swaps THIS calm
// celebratory hero into the reading pane instead of leaving a blank pane.
//
// It reassures structurally (Direction A): the agents are still running on their
// own and the operator can check back whenever — never alarm, never a bare blank.
//
// MOTION (ethos-compliant, detail-pages §3.4): the entrance is a soft fade+rise
// (`animate-fade-in`), and `prefers-reduced-motion` collapses that to an INSTANT,
// still-calm state via the Tailwind `motion-reduce:` variant (no library, pure
// CSS) — the celebratory entrance drops, the calm content stays.
import { CheckCircle2 } from "lucide-react";

import { allClearReassurance, type InboxCounts } from "@/board/home-inbox";

export function AllClearHero({ counts }: { counts: InboxCounts }) {
  return (
    <div
      data-all-clear-hero
      className="animate-fade-in motion-reduce:animate-none flex h-full flex-col items-center justify-center gap-3 px-8 text-center"
    >
      {/* The single calm glyph — the reserved-live cyan is deliberately NOT used
          here (accent = meaning, not celebration). A soft accent check reads as
          "handled", not "alarm". */}
      <CheckCircle2
        aria-hidden
        className="h-12 w-12 text-accent opacity-70 motion-safe:animate-fade-in"
      />

      {/* The everything-handled headline — the relief line, never an alarm count. */}
      <p className="text-[18px] font-medium leading-snug text-fg">
        All clear — nothing needs you right now.
      </p>

      {/* The structural reassurance: agents run on their own, check back whenever. */}
      <p className="max-w-sm text-[13px] leading-relaxed text-muted">
        {allClearReassurance(counts)}
      </p>
    </div>
  );
}
