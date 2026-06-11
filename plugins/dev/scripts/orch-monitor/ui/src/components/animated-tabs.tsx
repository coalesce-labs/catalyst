// animated-tabs.tsx — the VISIBLE, animated sliding-pill tab control for the
// ticket reading page (CTL-996 §B4). Builds ON TOP of the shared Radix
// `ui/tabs.tsx` primitive (it does NOT restyle the shared component — the board
// and every other Tabs consumer is untouched): an `AnimatedTabsList` wrapper
// renders an absolutely-positioned indicator div BEHIND the triggers and, on
// value change, measures the active trigger's offsetLeft/offsetWidth and applies
// a translateX + width transition (180ms ease-out). The pill supplies the active
// bg; the triggers are ghost (transparent), 12px / 28px / px-3, with the active
// one going fg-text.
//
// Reduced-motion: the slide transition is dropped under prefers-reduced-motion
// (the pill still moves, just instantly — no animation).
//
// The control is URL-driven by the caller (ticket-detail-page passes `value` from
// the route search param and writes the next value via navigate()); this file is
// the pure presentation skin — it holds NO tab state of its own.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { cn } from "@/lib/utils";

// useLayoutEffect on the client, useEffect on the server (avoids the SSR warning;
// the measure must run pre-paint so the pill never flashes at x=0).
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** A single tab definition. */
export interface AnimatedTab {
  value: string;
  label: ReactNode;
}

export interface AnimatedTabsProps {
  /** The active tab value (URL-driven by the caller — controlled). */
  value: string;
  /** Called with the next value on a trigger click. */
  onValueChange: (next: string) => void;
  /** The ordered tab set. */
  tabs: AnimatedTab[];
  /** The tab panels — typically <TabsContent value=…> from ui/tabs. */
  children: ReactNode;
  /** Optional data-attr passthrough for tests/screenshots. */
  "data-testid"?: string;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** The measured geometry of the active trigger (drives the sliding pill). */
interface IndicatorGeom {
  left: number;
  width: number;
}

function AnimatedTabsList({
  value,
  tabs,
}: {
  value: string;
  tabs: AnimatedTab[];
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [geom, setGeom] = useState<IndicatorGeom | null>(null);
  const reduced = prefersReducedMotion();

  // Measure the active trigger's offsetLeft/offsetWidth relative to the list.
  // Runs on value change AND on a resize (the reading column reflows at 680px).
  useIsoLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const active = list.querySelector<HTMLElement>(
        '[data-slot="tabs-trigger"][data-state="active"]',
      );
      if (active) {
        setGeom({ left: active.offsetLeft, width: active.offsetWidth });
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [value, tabs.length]);

  return (
    <TabsList
      ref={listRef}
      data-animated-tabs-list
      className="relative h-7 w-fit gap-1 bg-transparent p-0"
    >
      {/* the sliding pill — absolutely positioned BEHIND the triggers */}
      {geom && (
        <span
          aria-hidden
          data-animated-tabs-indicator
          className="bg-muted absolute top-0 bottom-0 rounded-md"
          style={{
            transform: `translateX(${geom.left}px)`,
            width: geom.width,
            transition: reduced
              ? "none"
              : "transform 180ms ease-out, width 180ms ease-out",
          }}
        />
      )}
      {tabs.map((t) => (
        <TabsTrigger
          key={t.value}
          value={t.value}
          className={cn(
            // ghost triggers; the pill supplies the active bg, so neutralise the
            // shared primitive's active bg/shadow here (additive className only).
            "relative z-10 h-7 border-0 bg-transparent px-3 text-[11px] shadow-none",
            "data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none",
          )}
        >
          {t.label}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

/** AnimatedTabs — the controlled sliding-pill Tabs root. */
export function AnimatedTabs({
  value,
  onValueChange,
  tabs,
  children,
  ...rest
}: AnimatedTabsProps) {
  return (
    <Tabs
      value={value}
      onValueChange={onValueChange}
      data-animated-tabs
      {...rest}
    >
      <AnimatedTabsList value={value} tabs={tabs} />
      {children}
    </Tabs>
  );
}
