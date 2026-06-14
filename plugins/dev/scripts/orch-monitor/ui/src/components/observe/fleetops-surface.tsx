// fleetops-surface.tsx — the OBSERVE FleetOps surface (OBS-18). "Is my hardware
// healthy and do I need to intervene?" The diagnostic surface that stays GREEN
// when the telemetry stack is what broke: DELIBERATELY Prometheus/Loki-FREE —
// board + /api/cluster + events ONLY (design §3.4). The diagnostic surface must
// not depend on the patient. It issues ZERO /api/otel/* fetches and runs NO
// health probe, so it survives a telemetry-stack outage.
//
// LAYOUT (mirrors utilization-surface.tsx, the proven non-collapsing structure):
// the hero + the P1 host matrix are full-width shrink-0 siblings ABOVE a
// `grid min-h-0 flex-1` wrapper, so they always render before any scroll and the
// ChartCards (P2-P5) keep their fixed min-h footprint instead of collapsing to
// ~2px (the known hero-collapse bug — do NOT place ChartCards as direct children
// of the scroll column).
//
// TIME: pinned NOW (a stateful matrix, not a time series) — a static 📌 NOW chip,
// not a ToggleGroup. Refresh on a fixed 15s interval.
//
// HONESTY: the hero / host matrix LIVE columns / stuck-dead reap list are
// board+cluster-backed → ALWAYS live (never gate on OTEL health). The DEFERRED
// panels (reconcile / event-log hygiene / version skew) and the matrix's
// disk/load/version cell render the dashed "needs event-log reader · OBS-15"
// locked state — never blank, never fabricated.
import { useEffect, useMemo, useState } from "react";
import { HeaderActions } from "@/components/header-actions";
import type { BoardConfig, BoardWorker } from "@/board/types";
import type { ClusterSignal } from "@/lib/cluster-signal";
import { ChartCard } from "@/components/observe/chart-card";
import { FleetOpsHero } from "@/components/observe/fleetops-hero";
import { HostMatrix } from "@/components/observe/host-matrix";
import { StuckDeadReap } from "@/components/observe/stuck-dead-reap";
import { fleetHero, reapList } from "@/components/observe/fleetops-kit";
import { ServiceHealthStrip } from "@/components/observe/service-health-strip";
import { GovernanceModesStrip } from "@/components/observe/governance-modes-strip";
import type {
  ServiceHealthSnapshotView,
  ServiceStatusView,
} from "@/components/observe/service-health-kit";
import {
  isClusterGovernanceSignal,
  type ClusterGovernanceNode,
} from "@/lib/governance-model";

/** A zero-capacity board config stand-in for first paint (before /api/board lands)
 *  — renders an honest 0/0 rather than NaN. */
const EMPTY_CONFIG: BoardConfig = {
  maxParallel: 0,
  inFlight: 0,
  freeSlots: 0,
  active: 0,
  working: 0,
  stuck: 0,
  dead: 0,
};

/** Fixed NOW refresh cadence (the matrix is NOW-pinned; no range atom). */
const REFRESH_MS = 15_000;

export function FleetOpsSurface() {
  // null until the first /api/cluster lands; stays null on fetch failure → the hero
  // renders HOST STATUS UNAVAILABLE rather than fabricating "all live".
  const [cluster, setCluster] = useState<ClusterSignal | null>(null);
  const [clusterReachable, setClusterReachable] = useState<boolean>(true);
  const [config, setConfig] = useState<BoardConfig>(EMPTY_CONFIG);
  const [workers, setWorkers] = useState<BoardWorker[]>([]);
  const [boardGeneratedAt, setBoardGeneratedAt] = useState<string | null>(null);
  // CTL-1050: the service-health registry snapshot for the SERVICES strip. null
  // until the first /api/health/services lands; `servicesUnavailable` flips on a
  // fetch failure so the strip renders the honest grey line (never green).
  const [services, setServices] = useState<ServiceStatusView[] | null>(null);
  const [servicesUnavailable, setServicesUnavailable] = useState<boolean>(false);
  // CTL-1104: per-host governance snapshot for the GOVERNANCE strip. null until
  // the first /api/cluster/governance lands; `governanceUnavailable` flips on
  // failure so the strip renders the honest grey line (never fabricates green).
  const [governanceNodes, setGovernanceNodes] = useState<ClusterGovernanceNode[] | null>(null);
  const [governanceUnavailable, setGovernanceUnavailable] = useState<boolean>(false);
  // Ticks every refresh so the board-freshness (broker) cell + reap idle ages
  // recompute against a current `now` without a per-cell timer.
  const [now, setNow] = useState<number>(() => Date.now());

  // Cluster + board, NOW-pinned 15s interval. NO OTEL probe — this is what makes
  // FleetOps survive a telemetry outage (it issues zero prom/loki fetches).
  useEffect(() => {
    let alive = true;

    async function loadCluster() {
      try {
        const resp = await fetch("/api/cluster");
        if (!resp.ok || !alive) {
          if (alive) setClusterReachable(false);
          return;
        }
        const body = (await resp.json()) as ClusterSignal;
        setCluster(body);
        setClusterReachable(true);
      } catch {
        // cluster unreachable → hero goes UNAVAILABLE (never "all live").
        if (alive) setClusterReachable(false);
      }
    }

    async function loadBoard() {
      try {
        const resp = await fetch("/api/board");
        if (!resp.ok || !alive) return;
        const board = (await resp.json()) as {
          config: BoardConfig;
          workers: BoardWorker[];
          generatedAt: string;
        };
        setConfig(board.config);
        setWorkers(board.workers ?? []);
        setBoardGeneratedAt(board.generatedAt ?? null);
      } catch {
        /* board unavailable → keep the last-good config/workers */
      }
    }

    // CTL-1050: the SERVICES strip reads ONLY the monitor's own registry endpoint
    // (Fleet Ops stays Prometheus/Loki-FREE — the strip never probes the patient).
    async function loadServices() {
      try {
        const resp = await fetch("/api/health/services");
        if (!resp.ok || !alive) {
          if (alive) setServicesUnavailable(true);
          return;
        }
        const body = (await resp.json()) as ServiceHealthSnapshotView;
        setServices(body.services ?? []);
        setServicesUnavailable(false);
      } catch {
        if (alive) setServicesUnavailable(true);
      }
    }

    // CTL-1104: per-host governance snapshot from the heartbeat event log.
    async function loadGovernance() {
      try {
        const resp = await fetch("/api/cluster/governance");
        if (!resp.ok || !alive) {
          if (alive) setGovernanceUnavailable(true);
          return;
        }
        const body = await resp.json();
        if (alive && isClusterGovernanceSignal(body)) {
          setGovernanceNodes(body.nodes);
          setGovernanceUnavailable(false);
        } else if (alive) {
          setGovernanceUnavailable(true);
        }
      } catch {
        if (alive) setGovernanceUnavailable(true);
      }
    }

    void loadCluster();
    void loadBoard();
    void loadServices();
    void loadGovernance();
    const id = setInterval(() => {
      setNow(Date.now());
      void loadCluster();
      void loadBoard();
      void loadServices();
      void loadGovernance();
    }, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // ── derivations (all PURE, board + cluster only) ────────────────────────────
  // When the cluster fetch has failed, pass null nodes so the hero/matrix render
  // the honest unavailable state instead of a stale/empty roster.
  const nodes = clusterReachable ? (cluster?.nodes ?? null) : null;

  const hero = useMemo(
    () => fleetHero(nodes, config.stuck, config.dead ?? 0),
    [nodes, config.stuck, config.dead],
  );

  const reapRows = useMemo(() => reapList(workers, now), [workers, now]);

  const boardAgeMs = useMemo(() => {
    if (!boardGeneratedAt) return null;
    const t = Date.parse(boardGeneratedAt);
    return Number.isFinite(t) ? Math.max(0, now - t) : null;
  }, [boardGeneratedAt, now]);

  return (
    <div className="cat-overlay-scroll flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-surface-1 p-5 text-fg">
      {/* CTL-1018: surface header folded into the SINGLE breadcrumb row (OBSERVE
          › Fleet Ops). Subtitle + the pinned-NOW chip move up. One per surface. */}
      <HeaderActions>
        <span className="hidden text-[12px] text-muted-foreground lg:inline">
          Is my hardware healthy and do I need to intervene?
        </span>
        {/* Time is pinned NOW (a stateful matrix, not a time series) — a static
            chip, NOT a ToggleGroup. */}
        <span className="rounded-md border border-border bg-surface-1 px-2.5 py-1 font-mono text-[11px] tracking-wide text-muted">
          📌 NOW
        </span>
      </HeaderActions>

      {/* HERO — full-width shrink-0, the ONE answer, before any scroll. Live =
          the calm green ALL SYSTEMS GO line (the success case, not empty). */}
      <FleetOpsHero hero={hero} />

      {/* CTL-1050 SERVICES STRIP — full-width shrink-0 block BETWEEN the hero and
          the host matrix (respects the ChartCard flex-collapse rule — never a
          shrinkable flex child). One quiet dot row of the eight stack services. */}
      <ServiceHealthStrip
        services={services}
        unavailable={servicesUnavailable}
        now={now}
      />

      {/* CTL-1104 GOVERNANCE STRIP — full-width shrink-0 block (not inside the
          grid wrapper — ChartCard flex-collapse rule). One row per roster host:
          host name + mode chips + age label + stale marker. */}
      <GovernanceModesStrip
        nodes={governanceNodes}
        unavailable={governanceUnavailable}
        now={now}
      />

      {/* P1 HOST MATRIX — full-width shrink-0 sibling ABOVE the grid wrapper (the
          collapse-bug rule). Rows = hosts; LIVE columns left, deferred dimmed right. */}
      <HostMatrix
        nodes={nodes}
        workers={workers}
        maxParallel={config.maxParallel}
        boardAgeMs={boardAgeMs}
      />

      {/* GRID — the flex-1 wrapper (NOT shrink-0 cards in the scroll column) so the
          ChartCards keep their fixed min-h footprint. P2 spans both rows on lg
          (it's the action panel — it gets the height). 8px gap (Principle 7). */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 lg:grid-cols-2">
        {/* P2 STUCK/DEAD + REAP HINTS — FIRST SCREEN, left column, full height.
            Board-backed → never gates on OTEL health. Live = 0 → the honest calm
            "no stuck or dead workers — reap path clear" empty state. */}
        <StuckDeadReap rows={reapRows} className="lg:row-span-3 lg:col-span-1" />

        {/* P3 RECONCILE HEALTH [events] — LOCKED (OBS-15). reconcile-health-reader.ts
            exists but /api/reconcile-health is 404 (curl-verified); the reader runs
            over the event log → needs OBS-15 plumbing. Will be a status badge +
            nonzero-error count (page amber on nonzero — the silent-team-starvation
            failure mode). Until then: a dashed dimmed locked card, no fetch, no fake. */}
        <ChartCard
          title="Reconcile health"
          dataSource="[events]"
          health={null}
          locked={{ reason: "needs event-log reader", ticket: "OBS-15" }}
          bodyClassName="min-h-[120px] p-3"
        />

        {/* P4 EVENT-LOG & PIPELINE HYGIENE [events] — LOCKED (OBS-15). JSONL size +
            growth/day, broker lag, orphaned signal-file count — all need the OBS-15
            fs-stats endpoint. Never a fake "184MB · broker lag 0.4s". */}
        <ChartCard
          title="Event-log hygiene"
          dataSource="[events]"
          health={null}
          locked={{ reason: "needs event-log reader", ticket: "OBS-15" }}
          bodyClassName="min-h-[120px] p-3"
        />

        {/* P5 VERSION SKEW [events] — LOCKED (OBS-15). daemon/broker/monitor/plugin
            versions per host from boot events (cross-version churn is a known failure
            class). Needs the OBS-15 reader. */}
        <ChartCard
          title="Version skew"
          dataSource="[events]"
          health={null}
          locked={{ reason: "needs event-log reader", ticket: "OBS-15" }}
          bodyClassName="min-h-[120px] p-3"
        />
      </div>
    </div>
  );
}
