// chart-card.tsx — the 4-state "honesty ladder" wrapper used by EVERY OBSERVE
// panel (OBS-2). The whole point of this component is that no panel can ever
// render blank or fabricate data: the (health, dataSource) → state decision is
// made exactly once, here, and every downstream surface gets the same honest
// degraded states for free.
//
// The four states (design §2.3, build-plan §2.4):
//   1. Unconfigured            → dimmed skeleton + "Configure Prometheus" CTA
//   2. Configured-but-unreachable → amber STALE banner (OtelHealthBanner) + last-good greyed
//   3. Reachable-but-empty     → plain "no data in range"
//   4. Live                    → children
//
// CRITICAL: the layout MUST NOT reflow between states. Every state renders the
// same Panel footprint (PanelHeader + a fixed min-height body), so a panel that
// flips unconfigured→live (or live→unreachable) never changes the page geometry.
//
// Health is driven by /api/health/otel (10s-TTL live probe) — NOT /api/otel/status,
// which lies via a no-TTL circuit breaker (build-plan §8 "Prometheus
// circuit-breaker lies in both directions"). Callers pass the already-fetched
// OtelHealth (use-monitor.ts already fetches it from /api/health/otel).

import { cn } from "@/lib/utils";
import type { OtelHealth } from "@/lib/types";
import { Panel, PanelHeader, SectionLabel } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/empty-state";
import { OtelHealthBanner } from "@/components/ui/otel-health-banner";
import { Badge } from "@/components/ui/badge";
import { Database, Lock } from "lucide-react";
import type { ReactNode } from "react";

// ── data-source → backend mapping ────────────────────────────────────────────
// dataSource is the bracketed tag a panel declares (e.g. "[loki]", "[prom]",
// "[board]"). It tells the card WHICH backend's reachability gates this panel,
// so Loki-backed and Prometheus-backed panels degrade INDEPENDENTLY (design §2.3).

export type ChartCardBackend = "prometheus" | "loki" | "board" | "events";

/**
 * Normalize a free-form dataSource tag (e.g. "[prom]", "loki", "[loki+board]")
 * to the backend whose reachability gates the panel. Board/events sources never
 * gate on OTEL health — they are always "live-capable" because they read from the
 * monitor's own state, so they resolve to "board".
 */
export function dataSourceBackend(dataSource: string): ChartCardBackend {
  const s = dataSource.toLowerCase();
  // A panel that names a telemetry backend gates on it. Prefer prometheus when
  // both appear (a $-panel is unusable without prom); otherwise loki.
  if (s.includes("prom")) return "prometheus";
  if (s.includes("loki")) return "loki";
  if (s.includes("event")) return "events";
  return "board";
}

// ── the four states ───────────────────────────────────────────────────────────

export type ChartCardState =
  | "unconfigured"
  | "unreachable"
  | "empty"
  | "locked"
  | "live";

/** OBS-16: an OBS-15-gated panel's locked descriptor. When a ChartCard carries
 *  `locked`, the honesty ladder short-circuits to the "locked" state — a dashed,
 *  dimmed card that occupies the SAME footprint as the live version and explains,
 *  in plain language, what it is waiting on ("{reason} · {ticket}"). This is the
 *  honest-degraded contract (design Principle 6) generalized BEYOND the OTEL
 *  "Configure Prometheus" CTA: the deferred occupancy timeline + quota gauges need
 *  the OBS-15 event-log read-model (not built), so they render locked rather than
 *  blank, fake, or abusing the Prometheus-config CTA. */
export interface ChartCardLocked {
  /** Plain-language reason the panel is dark (e.g. "needs event-log reader"). */
  reason: string;
  /** The ticket that unlocks it (e.g. "OBS-15"). */
  ticket: string;
}

export interface ResolveChartCardStateArgs {
  /** Health snapshot from /api/health/otel. null = not yet loaded (treat as live-pending so we don't flash a degraded state on first paint). */
  health: OtelHealth | null;
  /** The panel's declared data source tag, e.g. "[loki]" / "[prom]" / "[board]". */
  dataSource: string;
  /** Whether the panel actually has rows to render. Lets the card own the "reachable-but-empty" state. Defaults to true (caller hasn't told us → assume data). */
  hasData?: boolean;
  /** OBS-16: when set, the card short-circuits to the "locked" state (an
   *  OBS-15-gated panel) regardless of health/data — the data source is not built
   *  yet, so it renders a dashed dimmed placeholder, never blank or fabricated. */
  locked?: ChartCardLocked;
}

/**
 * PURE state-decision function — the single source of truth for the honesty
 * ladder. Exported so it is unit-testable in isolation (all four states are
 * covered in observe-kit.test.ts).
 *
 * Decision order (most-degraded first):
 *   0. `locked` set → "locked" (OBS-16): an OBS-15-gated panel whose data source is
 *      not built yet — wins over EVERYTHING, including health/data, so the card is
 *      an honest dashed placeholder rather than blank or a fabricated empty.
 *   1. Board/events-backed panels NEVER gate on OTEL health — they read the
 *      monitor's own state, so they only ever go empty or live.
 *   2. health === null → "live" (first-paint optimism; the real state lands on
 *      the next render once /api/health/otel resolves — avoids a degraded flash).
 *   3. !health.configured OR the backend url is absent → "unconfigured".
 *   4. backend.reachable === false → "unreachable".
 *   5. hasData === false → "empty".
 *   6. otherwise → "live".
 */
export function resolveChartCardState({
  health,
  dataSource,
  hasData = true,
  locked,
}: ResolveChartCardStateArgs): ChartCardState {
  // OBS-16: a locked (OBS-15-gated) panel short-circuits — its data source does not
  // exist yet, so no health/data path could make it live. Render the dashed dimmed
  // placeholder, never blank/fake.
  if (locked) return "locked";

  const backend = dataSourceBackend(dataSource);

  // Board/events panels read the monitor's own state — they never degrade on
  // OTEL health, only on data presence.
  if (backend === "board" || backend === "events") {
    return hasData ? "live" : "empty";
  }

  // Not loaded yet → optimistic live (no degraded flash on first paint).
  if (health === null) {
    return hasData ? "live" : "empty";
  }

  const endpoint = backend === "prometheus" ? health.prometheus : health.loki;

  // Unconfigured: the whole stack is off, OR this specific backend has no URL.
  if (!health.configured || endpoint.url === null) {
    return "unconfigured";
  }

  // Configured but this backend can't be reached.
  if (!endpoint.reachable) {
    return "unreachable";
  }

  // Reachable — honest zero vs real data.
  return hasData ? "live" : "empty";
}

// ── the card ──────────────────────────────────────────────────────────────────

export interface ChartCardProps {
  title: string;
  /** Bracketed source tag rendered in the header, e.g. "[loki]" / "[prom]" / "[board]". */
  dataSource: string;
  /** Health snapshot from /api/health/otel (use-monitor.ts fetches it). */
  health: OtelHealth | null;
  /** When false, the card shows the "no data in range" state instead of children. */
  hasData?: boolean;
  /** Live content — rendered only in the "live" state. */
  children?: ReactNode;
  className?: string;
  /** Body min-height so the footprint is identical across all four states (no reflow). */
  bodyClassName?: string;
  /** Optional header-right content (e.g. a P2 trend sparkline — layout spec §5 #2:
   *  the trend belongs in the header, never inside a row or as a full chart). Sits
   *  before the data-source chip. */
  headerExtra?: ReactNode;
  /** OBS-16: when set, the card renders the dashed "locked" placeholder (an
   *  OBS-15-gated panel) instead of children/empty/degraded — same footprint, plain
   *  "{reason} · {ticket}" copy, never blank or fabricated. */
  locked?: ChartCardLocked;
}

// Fixed body so the panel footprint never changes between states (no reflow).
const BODY_BASE = "relative min-h-[180px] p-4";

export function ChartCard({
  title,
  dataSource,
  health,
  hasData = true,
  children,
  className,
  bodyClassName,
  headerExtra,
  locked,
}: ChartCardProps) {
  const state = resolveChartCardState({ health, dataSource, hasData, locked });

  return (
    <Panel className={cn("flex flex-col", className)}>
      <PanelHeader className="flex items-center justify-between gap-2">
        <SectionLabel>{title}</SectionLabel>
        <div className="flex items-center gap-2">
          {/* header trend (e.g. P2 sparkline) — only meaningful in the live state. */}
          {state === "live" && headerExtra}
          <span className="font-mono text-[10px] tracking-wide text-muted/70">
            {dataSource}
          </span>
        </div>
      </PanelHeader>
      <div className={cn(BODY_BASE, bodyClassName)}>
        {state === "unconfigured" && <UnconfiguredState />}
        {state === "unreachable" && <UnreachableState health={health} />}
        {state === "locked" && locked && <LockedState locked={locked} />}
        {state === "empty" && (
          <EmptyState message="no data in range" className="py-0 h-full" />
        )}
        {state === "live" && children}
      </div>
    </Panel>
  );
}

// State (OBS-16) — a dashed, dimmed placeholder for an OBS-15-gated panel. Fills the
// SAME footprint as a live chart (the dimmed skeleton geometry from UnconfiguredState)
// so the panel never reflows when its data source later ships — and explains, in
// plain language, what it is waiting on. NOT the "Configure Prometheus" CTA (this is
// gated on a missing READER, not a missing backend) and NEVER a fabricated number.
function LockedState({ locked }: { locked: ChartCardLocked }) {
  return (
    <div
      className="flex h-full flex-col gap-3 rounded border border-dashed border-border/60 p-3"
      aria-label={`${locked.reason} — ${locked.ticket}`}
    >
      {/* dimmed skeleton bars — placeholder geometry that matches a live chart's
          footprint (same shape UnconfiguredState uses), so going live never reflows. */}
      <div className="flex flex-1 items-end gap-2 opacity-25" aria-hidden>
        {[40, 65, 30, 80, 55, 70, 45].map((h, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm bg-fg/30"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <Lock className="h-4 w-4 shrink-0 opacity-50" />
        <span>
          {locked.reason} ·{" "}
          <span className="font-mono text-muted-foreground/80">{locked.ticket}</span>
        </span>
      </div>
    </div>
  );
}

// State 1 — dimmed skeleton + Configure CTA. Fills the same footprint as a live
// chart so flipping configured→live never reflows the page.
function UnconfiguredState() {
  return (
    <div className="flex h-full flex-col gap-3">
      {/* dimmed skeleton bars — placeholder geometry, not data */}
      <div className="flex flex-1 items-end gap-2 opacity-25" aria-hidden>
        {[40, 65, 30, 80, 55, 70, 45].map((h, i) => (
          <div
            key={i}
            className="flex-1 rounded-sm bg-fg/30"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <Database className="h-4 w-4 shrink-0 opacity-50" />
        <span>
          Configure Prometheus —{" "}
          <a
            href="https://github.com/coalesce-labs/catalyst-otel"
            target="_blank"
            rel="noreferrer"
            className="font-mono text-accent underline-offset-2 hover:underline"
          >
            catalyst-otel
          </a>
        </span>
      </div>
    </div>
  );
}

// State 2 — amber STALE banner (reuses OtelHealthBanner) + last-good greyed.
function UnreachableState({ health }: { health: OtelHealth | null }) {
  return (
    <div className="flex h-full flex-col gap-3">
      <OtelHealthBanner health={health} />
      <div className="flex flex-1 items-center justify-center gap-2 opacity-40">
        <Badge variant="outline" className="font-mono text-[10px]">
          STALE
        </Badge>
        <span className="text-[12px] text-muted">last-good data unavailable</span>
      </div>
    </div>
  );
}
