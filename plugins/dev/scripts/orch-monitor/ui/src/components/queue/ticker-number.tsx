// ticker-number.tsx — split-flap (Solari departure-board) numeral (CTL-1015).
//
// The ONLY split-flap flavor on the /queue surface, used for the capacity
// numerals ONLY (in-use count, open count, the "· n waiting" queue count) — never
// on rows, titles, or ages (per spec §6.4). Each digit is its own <span>; on a
// digit CHANGE the old glyph flaps up and out while the new one enters from below.
//
// Reduced motion → instant swap (no flap), matching the enterVariantsReduced
// semantics the rest of the surface uses.
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "../../board/motion-utils";
import { C } from "../../board/board-tokens";

const flapTransition = { duration: 0.18, ease: "easeOut" as const };

export function TickerNumber({ value }: { value: number }) {
  const reduced = useReducedMotion();
  // Split the rendered number into per-character cells so each digit flaps
  // independently. A stable per-position key (`pos-i`) keeps a digit's slot
  // identity across renders, so only the digits that actually changed animate.
  const chars = String(value).split("");
  return (
    <span
      style={{
        display: "inline-flex",
        overflow: "hidden",
        fontFamily: C.mono,
        fontVariantNumeric: "tabular-nums",
      }}
      aria-label={String(value)}
    >
      {chars.map((ch, i) => (
        <span
          key={`pos-${i}`}
          aria-hidden
          style={{ position: "relative", display: "inline-flex", overflow: "hidden" }}
        >
          {/* mode="popLayout" pops the exiting glyph from layout flow so the
              entering glyph occupies the cell immediately (no width jump). */}
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={ch}
              initial={reduced ? { opacity: 1 } : { y: "0.55em", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={reduced ? { opacity: 0 } : { y: "-0.55em", opacity: 0 }}
              transition={reduced ? { duration: 0 } : flapTransition}
              style={{ display: "inline-block" }}
            >
              {ch}
            </motion.span>
          </AnimatePresence>
        </span>
      ))}
    </span>
  );
}
