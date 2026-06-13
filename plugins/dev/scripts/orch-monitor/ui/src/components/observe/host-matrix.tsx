// host-matrix.tsx — the FLEETOPS P1 core panel (OBS-18, layout spec §4). A
// CSS-grid table: rows = hosts (one per /api/cluster node), columns split into a
// LIVE block (left: daemon, broker, monitor, workers) and a DEFERRED block (right:
// disk/load/version) rendered as ONE merged dimmed locked cell ("enable host stats
// · OBS-15"). The matrix renders day-one multi-row scaffolding so a second host's
// heartbeat lights a second row with zero code change — singleHost is
// informational only, never a layout branch.
//
// Wrapped in Panel/PanelHeader/SectionLabel (not a single ChartCard) because the
// matrix has heterogeneous PER-CELL honesty: the LIVE columns are real, the
// DEFERRED block is a dashed locked placeholder. Full-width shrink-0 sibling ABOVE
// the grid wrapper (the collapse-bug rule — see fleetops-surface.tsx).

import { Lock } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Panel, PanelHeader, SectionLabel } from "@/components/ui/panel";
import type { ClusterSignalNode } from "@/lib/cluster-signal";
import type { BoardWorker } from "@/board/types";
import { hostWorkerCount, shortHostName, nodeStatusVar } from "./fleetops-kit";

export interface HostMatrixProps {
  /** The cluster roster (one row per node). null ⇒ cluster signal unreachable. */
  nodes: readonly ClusterSignalNode[] | null;
  /** Live board workers — filtered per-host for the wkrs column. */
  workers: readonly BoardWorker[];
  /** AUTOTUNED total slot capacity (board config.maxParallel) — the wkrs denominator. */
  maxParallel: number;
  /** Board freshness: ms since the board snapshot's generatedAt. Drives the broker
   *  cell (the board IS the broker's projection → board freshness is the honest
   *  broker-liveness proxy without OBS-15). null when not yet known. */
  boardAgeMs: number | null;
}

/** A board snapshot older than this reads as a STALE broker projection. */
const BROKER_STALE_MS = 60_000;

/** The grid template: host | daemon | broker | monitor | wkrs (LIVE) | deferred. */
const GRID_COLS =
  "grid-cols-[1.4fr_auto_auto_auto_auto_minmax(0,1.6fr)]";

export function HostMatrix({ nodes, workers, maxParallel, boardAgeMs }: HostMatrixProps) {
  const navigate = useNavigate();
  const brokerFresh = boardAgeMs != null && boardAgeMs < BROKER_STALE_MS;

  return (
    <Panel className="shrink-0">
      <PanelHeader className="flex items-center justify-between gap-2">
        <SectionLabel>Hosts</SectionLabel>
        <span className="font-mono text-[10px] tracking-wide text-muted/70">
          [events+board]
        </span>
      </PanelHeader>
      <div className="p-2">
        {/* Header row — LIVE block | a vertical honesty boundary | DEFERRED block. */}
        <div
          className={`grid ${GRID_COLS} items-center gap-x-3 border-b border-border/40 px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted/70`}
        >
          <span>Host</span>
          <span>Daemon</span>
          <span>Broker</span>
          <span>Monitor</span>
          <span>Wkrs</span>
          <span className="border-l border-border/40 pl-3">Disk · Load · Version</span>
        </div>

        {nodes === null ? (
          <div className="px-2 py-3 text-[12px] text-muted">
            cluster signal unreachable — host roster unavailable
          </div>
        ) : nodes.length === 0 ? (
          <div className="px-2 py-3 text-[12px] text-muted">no hosts in roster</div>
        ) : (
          nodes.map((n) => {
            const busy = hostWorkerCount(workers, n.host);
            const daemonColor = nodeStatusVar(n.status);
            return (
              <button
                key={n.host}
                type="button"
                onClick={() => void navigate({ to: "/dispatch" })}
                title={`${shortHostName(n.host)} — host swimlane`}
                className={`grid ${GRID_COLS} h-10 items-center gap-x-3 rounded px-2 text-left text-[12px] tabular-nums hover:bg-surface-3`}
              >
                {/* host — colored 3-state dot (StatusDot only does green/grey, so we
                    render a colored span for the live/degraded/offline case) + short name. */}
                <span className="flex items-center gap-2 truncate">
                  <span
                    className="inline-block h-2 w-2 shrink-0 rounded-full"
                    style={{
                      backgroundColor: daemonColor,
                      boxShadow:
                        n.status === "live" ? `0 0 6px ${daemonColor}` : undefined,
                    }}
                    aria-hidden
                  />
                  <span className="truncate font-mono">{shortHostName(n.host)}</span>
                </span>

                {/* daemon — liveness status word, tone-colored. The UI cluster signal
                    carries no lastSeen, so we render the status word (not a heartbeat
                    age — that needs the OBS-15 reader) honestly. */}
                <span style={{ color: daemonColor }}>
                  {n.status === "live" ? "live" : n.status === "degraded" ? "degraded" : "OFFLINE"}
                </span>

                {/* broker — board-freshness proxy (the board IS the broker projection). */}
                <span
                  style={{
                    color: brokerFresh ? "var(--chart-2)" : "var(--chart-3)",
                  }}
                >
                  {brokerFresh ? "ok" : "stale"}
                </span>

                {/* monitor — self: if this page renders, the monitor is up. */}
                <span style={{ color: "var(--chart-2)" }}>ok</span>

                {/* wkrs — busy/total: per-node maxParallel from the cluster signal
                    (CTL-1092) when available; falls back to the global prop so
                    single-host fleets behave identically to before. Offline rows
                    show 0/0 (no dead-worker counts). */}
                <span className="text-muted">
                  {n.status === "offline" ? "0/0" : `${busy}/${n.maxParallel ?? maxParallel}`}
                </span>

                {/* DEFERRED — ONE merged dimmed locked cell spanning disk/load/version.
                    Same locked idiom as ChartCard LockedState; never blank, never fake. */}
                <span className="flex items-center gap-1.5 border-l border-dashed border-border/60 pl-3 text-[11px] text-muted opacity-40">
                  <Lock className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">
                    enable host stats ·{" "}
                    <span className="font-mono text-muted-foreground/80">OBS-15</span>
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </Panel>
  );
}
