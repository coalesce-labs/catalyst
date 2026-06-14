// service-health-strip.tsx — the Fleet Ops SERVICES strip (CTL-1050 §2). A
// full-width shrink-0 block placed BETWEEN FleetOpsHero and HostMatrix. ONE quiet
// flex-wrap row of eight service dots — the calm read is one green line when all
// is well. Reads ONLY the monitor's own /api/health/services (Fleet Ops stays
// Prometheus/Loki-FREE). The severity→token mapping + ordering + last-checked
// label are PURE in service-health-kit.ts; this component is the thin skin.
//
// The dot vocabulary is the EXACT HostMatrix pattern (host-matrix.tsx:86-91):
// a backgroundColor from a CSS var + a 0 0 6px glow ONLY when up, NOT Tailwind
// bg-* classes. Fetch failure → the honest grey "service status unavailable"
// line (never fabricate green — the fleetHero `unavailable` precedent).

import { Panel, PanelHeader, SectionLabel } from "@/components/ui/panel";
import {
  type ServiceStatusView,
  hoverText,
  isLabelMuted,
  lastCheckedLabel,
  orderServices,
  severityDotColor,
  severityDotGlow,
  severityDotOpacity,
} from "./service-health-kit";

export interface ServiceHealthStripProps {
  /** The /api/health/services snapshot, or null until the first fetch lands. */
  services: ServiceStatusView[] | null;
  /** True ⇒ the last fetch failed → the strip renders the honest grey
   *  "service status unavailable" line instead of a stale/fabricated row. */
  unavailable: boolean;
  /** The surface's `now` tick — drives the per-entry last-checked label. */
  now: number;
}

function ServiceEntry({ s, now }: { s: ServiceStatusView; now: number }) {
  const color = severityDotColor(s.severity);
  const muted = isLabelMuted(s.severity);
  return (
    <span
      className="flex items-center gap-1.5 text-[12px] tabular-nums"
      title={hoverText(s)}
    >
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{
          backgroundColor: color,
          boxShadow: severityDotGlow(s.severity),
          opacity: severityDotOpacity(s.severity),
        }}
        aria-hidden
      />
      <span className={muted ? "text-muted-foreground" : undefined}>{s.label}</span>
      <span className="text-muted-foreground/70">
        · {lastCheckedLabel(s.lastCheckedAt, now)}
      </span>
    </span>
  );
}

export function ServiceHealthStrip({ services, unavailable, now }: ServiceHealthStripProps) {
  const ordered = services !== null ? orderServices(services) : [];

  return (
    <Panel className="shrink-0">
      <PanelHeader className="flex items-center justify-between gap-2">
        <SectionLabel>Services</SectionLabel>
        <span className="font-mono text-[10px] tracking-wide text-muted/70">
          [probes+events]
        </span>
      </PanelHeader>
      <div className="p-2">
        {unavailable || services === null ? (
          <div className="px-1 py-1 text-[12px] text-muted">
            service status unavailable
          </div>
        ) : (
          <div className="flex flex-wrap gap-x-5 gap-y-1 px-1 py-1">
            {ordered.map((s) => (
              <ServiceEntry key={s.id} s={s} now={now} />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
