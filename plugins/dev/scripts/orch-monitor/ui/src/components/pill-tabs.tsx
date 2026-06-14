// pill-tabs.tsx — the Linear-style DISCRETE pill tab control for the ticket
// reading page (CTL-1003 §A3). Replaces animated-tabs.tsx: there is NO sliding
// indicator, NO offsetLeft/offsetWidth measurement, NO ResizeObserver. The active
// state comes SOLELY from Radix `data-state="active"`, which kills both the
// sliding-pill misrender (it measured before DOM sync) and the wrong-tab
// highlight (animated-tabs.tsx:79-95). Each tab is a small bordered rounded-rect
// pill: active = filled (secondary bg + visible border + slight elevation),
// inactive = ghost muted text.
//
// Controlled by the caller (ticket-detail-page passes `value` from the route
// search param and writes the next value via navigate()); this file holds NO tab
// state of its own.

import { type ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

/** A single tab definition. */
export interface PillTab {
  value: string;
  label: ReactNode;
}

export interface PillTabsProps {
  /** The active tab value (URL-driven by the caller — controlled). */
  value: string;
  /** Called with the next value on a trigger click. */
  onValueChange: (next: string) => void;
  /** The ordered tab set. */
  tabs: PillTab[];
  /** The tab panels — typically <TabsContent value=…> from ui/tabs. */
  children: ReactNode;
  /** Optional data-attr passthrough for tests/screenshots. */
  "data-testid"?: string;
}

/** PillTabs — controlled Radix Tabs rendered as Linear-style discrete pills. */
export function PillTabs({
  value,
  onValueChange,
  tabs,
  children,
  ...rest
}: PillTabsProps) {
  return (
    <Tabs value={value} onValueChange={onValueChange} data-pill-tabs {...rest}>
      <TabsList className="h-auto w-fit items-center gap-1 rounded-none bg-transparent p-0">
        {tabs.map((t) => (
          <TabsTrigger
            key={t.value}
            value={t.value}
            // Discrete pill: ghost when inactive, filled + bordered + elevated
            // when active. Active state is Radix data-state only (no measurement).
            className="h-7 flex-none rounded-md border border-transparent bg-transparent px-3 text-xs font-medium text-muted-foreground shadow-none hover:text-foreground data-[state=active]:border-border data-[state=active]:bg-secondary data-[state=active]:text-foreground data-[state=active]:shadow-sm"
          >
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  );
}
