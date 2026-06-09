// resizable-split.tsx — the master-detail resizable split for the Inbox home
// (CTL-899 / HOME1). A two-pane horizontal split with a draggable divider and
// FIRM floors: the list pane never shrinks below `LIST_FLOOR_PX` (320) and the
// reading pane never below `READING_FLOOR_PX` (360). Those floors are the
// CTL-899 "split survives an iPad-landscape width" Gherkin — at ~1024–1366px
// neither pane is crushed and there is no horizontal overflow.
//
// Hand-rolled (no react-resizable-panels dependency) so the floors are exact and
// the whole surface stays inside the existing ui dependency set. The container is
// `min-w-0 overflow-hidden` so a wide reading pane can never push the split past
// the viewport (no horizontal scrollbar). Below the combined floor (an iPad
// PORTRAIT / phone width) the split stacks the panes vertically rather than
// crushing either — but the firm-floor case the ticket targets is landscape.
//
// The PURE floor math (clampListWidth + the floor constants) lives in the
// DOM-free board/home-split.ts so the orch-monitor `bun test` suite can unit it
// without dragging this DOM-touching component into the DOM-less typecheck — the
// floors enforced here and the floors the tests assert are ONE source.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clampListWidth,
  shouldStack,
  DEFAULT_LIST_PX,
  LIST_FLOOR_PX,
  READING_FLOOR_PX,
} from "@/board/home-split";

const STORAGE_KEY = "catalyst:home-list-width";

function readStoredWidth(): number {
  if (typeof window === "undefined") return DEFAULT_LIST_PX;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= LIST_FLOOR_PX ? n : DEFAULT_LIST_PX;
}

export function ResizableSplit({
  list,
  reading,
}: {
  list: React.ReactNode;
  reading: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [listPx, setListPx] = useState<number>(readStoredWidth);
  const draggingRef = useRef(false);

  // Track the container width so the clamp keeps both floors as the window/iPad
  // viewport resizes (ResizeObserver — no horizontal overflow at any width).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === "number") setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const persist = useCallback((px: number) => {
    setListPx(px);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, String(px));
    }
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      draggingRef.current = true;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const el = containerRef.current;
      if (!el) return;
      const left = el.getBoundingClientRect().left;
      persist(clampListWidth(e.clientX - left, el.clientWidth));
    },
    [persist],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  }, []);

  // Keyboard resize for a11y: ←/→ on the focused divider nudges the split.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const el = containerRef.current;
      if (!el) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        persist(clampListWidth(listPx - 16, el.clientWidth));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        persist(clampListWidth(listPx + 16, el.clientWidth));
      }
    },
    [listPx, persist],
  );

  // Below the combined floor (portrait / phone) the firm floors can't both hold
  // side-by-side — stack vertically so neither pane is crushed. The landscape
  // case the ticket targets keeps the horizontal split.
  const stacked = shouldStack(containerWidth);
  const effectiveListPx = clampListWidth(listPx, containerWidth || DEFAULT_LIST_PX);

  if (stacked) {
    return (
      <div ref={containerRef} className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto border-b border-border">{list}</div>
        <div className="min-h-0 flex-1 overflow-y-auto">{reading}</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full min-w-0 overflow-hidden">
      {/* List pane — fixed (resizable) width, never below its floor. */}
      <div
        className="h-full min-h-0 shrink-0 overflow-y-auto"
        style={{ width: effectiveListPx, minWidth: LIST_FLOOR_PX }}
      >
        {list}
      </div>

      {/* Draggable divider — a hairline with a wider hit area. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the inbox list"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
        className="relative w-px shrink-0 cursor-col-resize bg-border outline-none before:absolute before:inset-y-0 before:-left-1.5 before:-right-1.5 before:content-[''] hover:bg-accent focus-visible:bg-accent"
      />

      {/* Reading pane — flexes to fill, never below its floor; min-w-0 so it can
          shrink within its flex track without forcing horizontal overflow. */}
      <div
        className="h-full min-h-0 flex-1 overflow-y-auto"
        style={{ minWidth: READING_FLOOR_PX }}
      >
        {reading}
      </div>
    </div>
  );
}
