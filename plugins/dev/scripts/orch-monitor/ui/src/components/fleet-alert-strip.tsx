// fleet-alert-strip.tsx — CTL-2161. The board's ONE row per fleet condition.
//
// ⛔ WHY IT IS A STRIP AND NOT A CARD LIST. This epic deletes the `needs-human`
// label because SYSTEM trouble was being escalated one ticket at a time: of 86
// items flagged as waiting on a human, 41 were the model provider being
// overloaded and 3 genuinely needed a person. The alert path (CTL-2156) fans N
// affected tickets into ONE alert per KIND. This component must preserve that: a
// row here is a CONDITION, never a ticket. If it ever grows per-ticket rows it
// has re-created the bin.
//
// It renders nothing when nothing is raised — an outage-free fleet costs no
// vertical space, so the strip stays trustworthy when it does appear.
import type { FleetAlert } from "../board/types";
import { C } from "../board/board-tokens";

function ago(iso?: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs}h` : `${Math.round(hrs / 24)}d`;
}

export function FleetAlertStrip({ alerts }: { alerts?: FleetAlert[] | null }) {
  const rows = Array.isArray(alerts) ? alerts : [];
  if (rows.length === 0) return null;
  return (
    <section
      aria-label="Fleet alerts"
      style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}
    >
      {rows.map((a) => {
        const since = ago(a.raisedAt);
        return (
          <div
            key={a.kind}
            role="status"
            data-alert-kind={a.kind}
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 8,
              padding: "6px 10px",
              borderLeft: `2px solid ${C.red}`,
              background: C.s2,
              fontFamily: C.mono,
              fontSize: 12,
            }}
          >
            <span style={{ color: C.red }}>▲</span>
            <span style={{ color: C.fg }}>{a.title}</span>
            {typeof a.count === "number" && a.count > 0 ? (
              <span style={{ color: C.fgDim }}>×{a.count}</span>
            ) : null}
            {a.reason ? <span style={{ color: C.fgDim }}>— {a.reason}</span> : null}
            {since ? <span style={{ color: C.fgDim, marginLeft: "auto" }}>{since}</span> : null}
          </div>
        );
      })}
    </section>
  );
}
