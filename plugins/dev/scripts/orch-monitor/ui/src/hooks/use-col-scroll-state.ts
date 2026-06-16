// use-col-scroll-state.ts — CTL-1206. Saves/restores the flat (ungrouped) board's
// per-column vertical scroll against the board's own per-history-entry atom, so an
// Escape-back from a ticket lands the operator exactly where they were INSIDE a
// column. Mirrors the CTL-1049 detail-scroll precedent (Shell.tsx:471-500), but the
// flat board has N independent viewports (one per column) instead of one, so we
// iterate `[data-flat-col-scroll][data-col-key]` within the board container and key
// the saved offsets by `data-col-key` (= col.key).
import { useEffect, useRef, type RefObject } from "react";
import { useDetailEntryState } from "./use-detail-entry-state";
import { colScrollFor, setColScroll } from "../board/detail-entry-state";

const COL_SAVE_DEBOUNCE_MS = 120; // parity with Shell.tsx detail-scroll save

export function useColScrollState(containerRef: RefObject<HTMLElement | null>): void {
  const { key: entryKey, state, setState } = useDetailEntryState();

  // Snapshot the restore target map ONCE per entry key, so the restore effect
  // doesn't fight the live scroll writes that follow (mirrors Shell.tsx:461-466).
  const restoreRef = useRef<{ key: string; map: Record<string, number> } | null>(null);
  if (restoreRef.current?.key !== entryKey) {
    restoreRef.current = { key: entryKey, map: state.colScrollY };
  }

  // Restore each column's saved offset after paint (rAF → real scrollHeight).
  useEffect(() => {
    const container = containerRef.current;
    const snap = restoreRef.current;
    if (!container || !snap) return;
    const raf = requestAnimationFrame(() => {
      const els = container.querySelectorAll<HTMLElement>("[data-flat-col-scroll][data-col-key]");
      els.forEach((el) => {
        const colKey = el.getAttribute("data-col-key");
        if (!colKey) return;
        const y = snap.map[colKey] ?? 0;
        if (y > 0) el.scrollTop = y;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [entryKey, containerRef]);

  // Save each column's offset on scroll-idle (debounced) into THIS entry's state.
  // scroll events don't bubble, so we listen in the CAPTURE phase on the container
  // to catch every descendant viewport with one listener (robust to columns
  // mounting/unmounting as grouping/filters change).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (!el || !el.matches?.("[data-flat-col-scroll][data-col-key]")) return;
      const colKey = el.getAttribute("data-col-key");
      if (!colKey) return;
      const prevTimer = timers.get(colKey);
      if (prevTimer) clearTimeout(prevTimer);
      timers.set(
        colKey,
        setTimeout(() => {
          const y = el.scrollTop;
          setState((prev) => (colScrollFor(prev, colKey) === y ? prev : setColScroll(prev, colKey, y)));
        }, COL_SAVE_DEBOUNCE_MS),
      );
    };
    container.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      container.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      timers.forEach((t) => clearTimeout(t));
    };
  }, [entryKey, containerRef, setState]);
}
