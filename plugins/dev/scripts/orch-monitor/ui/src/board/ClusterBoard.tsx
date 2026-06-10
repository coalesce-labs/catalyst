// ClusterBoard.tsx — CTL-865. Cluster tab: aggregate host view with heartbeat
// liveness and per-host drill-down. Polls /api/cluster/board every 15s.
import { useEffect, useState } from "react";
import type { ClusterBoardPayload, ClusterHostStatus, ClusterTicketRow } from "./types";
import { livenessColor, livenessLabel, monitorUrlForHost } from "./cluster-helpers";
import { C } from "./board-tokens";
import { fmtDuration } from "../lib/formatters";

const REFRESH_MS = 15_000;

function fmtAgo(isoOrNull: string | null): string {
  if (!isoOrNull) return "never";
  const ms = Date.now() - Date.parse(isoOrNull);
  if (!Number.isFinite(ms) || ms < 0) return "?";
  return `${fmtDuration(ms)} ago`;
}

function LivenessDot({ liveness }: { liveness: ClusterHostStatus["liveness"] }) {
  const color = livenessColor(liveness);
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        marginRight: 4,
      }}
      title={livenessLabel(liveness)}
    />
  );
}

function TicketCard({ ticket, hostName }: { ticket: ClusterTicketRow; hostName: string }) {
  const href = monitorUrlForHost(hostName, ticket.id);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => window.open(href, "_blank")}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") window.open(href, "_blank"); }}
      style={{
        background: C.s1,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "6px 10px",
        marginBottom: 6,
        cursor: "pointer",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <span style={{ fontFamily: C.mono, fontSize: 11, color: C.fgMuted }}>{ticket.id}</span>
        {ticket.phase && (
          <span style={{ fontSize: 10, background: C.s2, border: `1px solid ${C.border}`, borderRadius: 3, padding: "1px 5px", color: C.fgMuted }}>
            {ticket.phase}
          </span>
        )}
        {ticket.pr != null && (
          <span style={{ fontSize: 10, color: C.fgDim }}>PR #{ticket.pr}{ticket.prState ? ` · ${ticket.prState}` : ""}</span>
        )}
      </div>
      <div style={{ color: C.fg, fontSize: 12, lineHeight: 1.3 }}>{ticket.title}</div>
    </div>
  );
}

function HostColumn({ host }: { host: ClusterHostStatus }) {
  const lColor = livenessColor(host.liveness);
  return (
    <div
      style={{
        minWidth: 220,
        maxWidth: 280,
        flexShrink: 0,
        borderRight: `1px solid ${C.border}`,
        display: "flex",
        flexDirection: "column",
        padding: "0 12px 12px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "10px 0 8px",
          borderBottom: `1px solid ${C.border}`,
          marginBottom: 10,
          flexShrink: 0,
        }}
      >
        <LivenessDot liveness={host.liveness} />
        <span style={{ fontWeight: 600, fontSize: 13, color: C.fg }}>{host.hostName}</span>
        <span style={{ fontSize: 11, color: lColor, marginLeft: "auto" }}>{livenessLabel(host.liveness)}</span>
      </div>
      <div style={{ fontSize: 11, color: C.fgDim, marginBottom: 8 }}>
        {host.lastHeartbeatISO ? fmtAgo(host.lastHeartbeatISO) : "no heartbeat"}
      </div>
      <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
        {host.tickets.length === 0 ? (
          <div style={{ color: C.fgDim, fontSize: 11, fontStyle: "italic" }}>idle</div>
        ) : (
          host.tickets.map((t) => (
            <TicketCard key={t.id} ticket={t} hostName={host.hostName} />
          ))
        )}
      </div>
    </div>
  );
}

export function ClusterBoard() {
  const [payload, setPayload] = useState<ClusterBoardPayload | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        const res = await fetch("/api/cluster/board");
        if (!res.ok || !alive) { if (alive) setError(true); return; }
        const body = (await res.json()) as ClusterBoardPayload;
        if (alive) { setPayload(body); setError(false); }
      } catch { if (alive) setError(true); }
    }

    void load();
    const id = setInterval(() => { void load(); }, REFRESH_MS);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (!payload && !error) {
    return <div style={{ color: C.fgMuted, padding: 24, fontSize: 13 }}>Loading cluster…</div>;
  }
  if (error && !payload) {
    return <div style={{ color: C.red, padding: 24, fontSize: 13 }}>Could not reach /api/cluster/board</div>;
  }
  if (!payload) return null;

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden", background: C.s0, color: C.fg }}>
      <div style={{ display: "flex", flexDirection: "row", overflowX: "auto", flex: 1, minWidth: 0 }}>
        {payload.hosts.map((h) => (
          <HostColumn key={h.hostName} host={h} />
        ))}
        {/* Unclaimed column */}
        <div
          style={{
            minWidth: 220,
            maxWidth: 280,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            padding: "0 12px 12px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "10px 0 8px",
              borderBottom: `1px solid ${C.border}`,
              marginBottom: 10,
              flexShrink: 0,
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 13, color: C.fgMuted }}>Unclaimed</span>
            <span style={{ marginLeft: 8, fontSize: 11, color: C.fgDim }}>{payload.unclaimed.length}</span>
          </div>
          <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
            {payload.unclaimed.length === 0 ? (
              <div style={{ color: C.fgDim, fontSize: 11, fontStyle: "italic" }}>none</div>
            ) : (
              payload.unclaimed.map((t) => (
                <TicketCard key={t.id} ticket={t} hostName="localhost" />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
