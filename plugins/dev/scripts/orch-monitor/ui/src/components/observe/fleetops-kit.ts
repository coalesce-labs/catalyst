// fleetops-kit.ts — the PURE decision logic behind the OBSERVE FleetOps surface
// (OBS-18). Lifted into its own React-free module (the same pattern
// utilization-kit.ts / hero-state.ts follow) so the load-bearing derivations —
// the worst-state-first hero roll-up, the stuck/dead reap list, the per-host
// worker count, and the `claude stop <shortId>` command formatting — are
// unit-tested in isolation, without a DOM or a live board.
//
// "Is my hardware healthy and do I need to intervene?" The surface answers with
// ONE worst-state-first sentence (the hero) and ONE inline action (the reap
// command). Both read board + /api/cluster ONLY — deliberately NO Prometheus /
// Loki (design §3.4: the diagnostic surface must not depend on the patient).

import type { ClusterNodeStatus, ClusterSignalNode } from "@/lib/cluster-signal";
import type { BoardActiveState } from "@/board/types";

// ── HERO — worst-state-first roll-up ─────────────────────────────────────────
// The surface's ONE answer. The dot/tone/label reflect the SINGLE most-degraded
// signal across {host liveness, stuck workers, dead workers}. First match wins
// (most-degraded first), so a red OFFLINE/stuck state always beats an amber
// degraded/dead state, which always beats the calm green ALL-SYSTEMS-GO.

/** The hero's three tones — the worst observed fleet state. "unavailable" is the
 *  honest degraded source when /api/cluster can't be reached (never "all live"). */
export type FleetTone = "go" | "warn" | "alert" | "unavailable";

export interface FleetHero {
  /** The worst-state tone — drives the dot color + label. */
  tone: FleetTone;
  /** The bold lead label (e.g. "ALL SYSTEMS GO", "1 HOST DEGRADED"). */
  label: string;
  /** The muted tabular-nums detail run (e.g. "1/1 hosts live · 0 stuck · 0 dead"). */
  detail: string;
  /** Live host count (status === "live"). */
  liveHosts: number;
  /** Total host count in the roster. */
  totalHosts: number;
}

/**
 * Compose the worst-state-first hero from the cluster roster + the board's
 * stuck/dead counters. Decision order (first match wins, most-degraded first):
 *
 *   1. nodes === null            → "unavailable" (cluster signal unreachable —
 *      NEVER fabricate "all live"; an honest grey ◌ HOST STATUS UNAVAILABLE).
 *   2. any node offline OR stuck>0 → "alert" (red): something needs intervention now.
 *   3. any node degraded OR dead>0 → "warn" (amber): degraded / a worker to reap.
 *   4. otherwise                  → "go" (green): all live, nothing stuck/dead.
 *
 * Negative counters are clamped to 0 so a bad board counter never mis-classifies.
 * PURE + exported for the kit test.
 */
export function fleetHero(
  nodes: readonly ClusterSignalNode[] | null,
  stuck: number,
  dead: number,
): FleetHero {
  const s = Math.max(0, Math.floor(Number.isFinite(stuck) ? stuck : 0));
  const d = Math.max(0, Math.floor(Number.isFinite(dead) ? dead : 0));

  // 1. cluster signal unreachable → honest unavailable, never "all live".
  if (nodes === null) {
    return {
      tone: "unavailable",
      label: "HOST STATUS UNAVAILABLE",
      detail: "cluster signal unreachable",
      liveHosts: 0,
      totalHosts: 0,
    };
  }

  const total = nodes.length;
  const live = nodes.filter((n) => n.status === "live").length;
  const anyOffline = nodes.some((n) => n.status === "offline");
  const anyDegraded = nodes.some((n) => n.status === "degraded");
  const offlineCount = nodes.filter((n) => n.status === "offline").length;
  const degradedCount = nodes.filter((n) => n.status === "degraded").length;

  const reapDetail = `${live}/${total} hosts live · ${s} stuck · ${d} dead`;

  // 2. ALERT — any offline host or any stuck worker. Needs intervention now.
  if (anyOffline || s > 0) {
    const parts: string[] = [];
    if (offlineCount > 0) {
      parts.push(`${offlineCount} HOST${offlineCount === 1 ? "" : "S"} OFFLINE`);
    } else {
      // stuck-only alert: lead with the stuck count.
      parts.push(`${s} STUCK WORKER${s === 1 ? "" : "S"}`);
    }
    return {
      tone: "alert",
      label: reapLabel(parts[0]!, s, d),
      detail: reapDetail,
      liveHosts: live,
      totalHosts: total,
    };
  }

  // 3. WARN — any degraded host or any dead worker. Degraded / a worker to reap.
  if (anyDegraded || d > 0) {
    const lead =
      degradedCount > 0
        ? `${degradedCount} HOST${degradedCount === 1 ? "" : "S"} DEGRADED`
        : `${d} DEAD WORKER${d === 1 ? "" : "S"}`;
    return {
      tone: "warn",
      label: reapLabel(lead, s, d),
      detail: reapDetail,
      liveHosts: live,
      totalHosts: total,
    };
  }

  // 4. GO — all hosts live, nothing stuck/dead. The calm, correct success state.
  return {
    tone: "go",
    label: "ALL SYSTEMS GO",
    detail: reapDetail,
    liveHosts: live,
    totalHosts: total,
  };
}

/** Append the "· S stuck · D dead to reap" suffix to a hero lead when there is
 *  anything to reap, so the loud label names the intervention (design §3.4:
 *  "N HOST DEGRADED · 0 stuck · 1 dead worker to reap"). */
function reapLabel(lead: string, stuck: number, dead: number): string {
  const toReap = stuck + dead;
  if (toReap === 0) return lead;
  const bits: string[] = [];
  if (stuck > 0) bits.push(`${stuck} stuck`);
  if (dead > 0) bits.push(`${dead} dead`);
  return `${lead} · ${bits.join(" · ")} to reap`;
}

/** The hero tone → CSS-var color. These ARE status colors (Principle 3): green =
 *  go, amber = warn, red = alert, muted = unavailable. No hardcoded hex. */
export const FLEET_TONE_VAR: Record<FleetTone, string> = {
  go: "var(--chart-2)",
  warn: "var(--chart-3)",
  alert: "var(--chart-4)",
  unavailable: "var(--color-muted)",
};

// ── shortId — the reap command target ────────────────────────────────────────
// `claude stop` rejects full UUIDs (CTL-649): it needs the 8-char hex short id.
// This is a throw-free UI mirror of execution-core/claude-ids.mjs
// shortIdFromSessionId — reimplemented here rather than imported because the
// execution-core module lives in the parent package (and reaching across the
// package boundary risks the bun:sqlite build trap). Returns null on bad input
// so the caller OMITS the command rather than rendering a fabricated target.

const HEX8 = /^[0-9a-f]{8}$/;
const HEX8_PREFIX = /^([0-9a-f]{8})-/;

/**
 * Convert a full CC-UUID sessionId (or an already-short id) into the 8-char hex
 * short id `claude stop` needs. Returns null for empty/malformed input (the
 * caller then omits the reap command — never a fabricated id). PURE + exported.
 */
export function shortIdFromSessionId(input: string | null | undefined): string | null {
  if (input == null || input === "") return null;
  const s = String(input).toLowerCase();
  if (HEX8.test(s)) return s;
  const m = s.match(HEX8_PREFIX);
  return m ? m[1]! : null;
}

/** The exact `claude stop <shortId>` command string for a worker, or null when no
 *  honest shortId can be derived (caller omits the inline reap hint). PURE. */
export function reapCommand(sessionId: string | null | undefined): string | null {
  const short = shortIdFromSessionId(sessionId);
  return short ? `claude stop ${short}` : null;
}

// ── P2 reap list — stuck / dead workers ──────────────────────────────────────
// The FIRST-SCREEN action panel. A worker is reapable when it is DEAD, STUCK, or
// running-with-silence (the board says it's working but it has gone quiet past a
// stall threshold). Surfacing this list — with the inline `claude stop` command —
// IS the observability: the reap path is historically broken (memory #11), so the
// command itself is the fix's surfaced affordance. Live = [] → the honest "no
// stuck/dead workers" empty state (0 dead is the GOOD state, never alarming).

/** The minimal board-worker shape the reap derivation needs. */
export interface ReapWorkerInput {
  name: string;
  ticket: string;
  phase: string;
  activeState: BoardActiveState;
  /** false ⇒ the worker has gone quiet (board `working` flag). */
  working: boolean;
  /** ms since the worker was last active — the stall/age anchor. null when unknown. */
  lastActiveMs: number | null;
  /** The host owning this worker (short name rendered in the row). null when unnamed. */
  host?: { name: string; id: string } | null;
  /** CC-UUID sessionId — the source of the `claude stop <shortId>` reap command. */
  sessionId?: string;
}

/** One row in the P2 stuck/dead reap list. */
export interface ReapRow {
  name: string;
  ticket: string;
  phase: string;
  /** The reason this row is reapable — drives the state badge + its tone. */
  reason: "dead" | "stuck" | "silent";
  /** ms since last activity (the "age" column). null → rendered "—", never faked. */
  lastActiveMs: number | null;
  /** Short host name for the row (".rozich" stripped), or null when unnamed. */
  host: string | null;
  /** The exact reap command string, or null when no honest shortId exists. */
  reapCommand: string | null;
}

/** A worker that is `working === false` but has been quiet longer than this is
 *  treated as running-with-silence (a stall signal — design §3.4 P2 / Telemetry
 *  P5 silence). 10 min biases hard against a false stuck flag on a slow phase. */
export const SILENCE_STALL_MS = 10 * 60_000;

/**
 * Derive the stuck/dead reap rows from the board workers. A worker is reapable
 * when its activeState is "dead" or "stuck", OR it is running-with-silence
 * (working === false AND quiet past SILENCE_STALL_MS). Dead beats stuck beats
 * silent for the row reason. Sorted worst-first: dead, then stuck, then silent,
 * each by longest idle. Live → [] (the honest empty state). PURE + exported.
 */
export function reapList(
  workers: readonly ReapWorkerInput[],
  _now: number = Date.now(),
): ReapRow[] {
  const rows: ReapRow[] = [];
  for (const w of workers) {
    let reason: ReapRow["reason"] | null = null;
    if (w.activeState === "dead") reason = "dead";
    else if (w.activeState === "stuck") reason = "stuck";
    else if (
      w.working === false &&
      w.lastActiveMs != null &&
      Number.isFinite(w.lastActiveMs) &&
      w.lastActiveMs >= SILENCE_STALL_MS
    ) {
      reason = "silent";
    }
    if (reason === null) continue;
    rows.push({
      name: w.name,
      ticket: w.ticket,
      phase: w.phase,
      reason,
      lastActiveMs: w.lastActiveMs,
      host: w.host ? shortHostName(w.host.name) : null,
      reapCommand: reapCommand(w.sessionId),
    });
  }
  // Worst-first: dead > stuck > silent; within a reason, longest-idle first.
  const order: Record<ReapRow["reason"], number> = { dead: 0, stuck: 1, silent: 2 };
  rows.sort((a, b) => {
    if (order[a.reason] !== order[b.reason]) return order[a.reason] - order[b.reason];
    return (b.lastActiveMs ?? -1) - (a.lastActiveMs ?? -1);
  });
  return rows;
}

// ── P1 host matrix — per-host worker count ───────────────────────────────────

/** Strip the trailing `.rozich` (and any longer suffix) so the matrix renders the
 *  short hostname (e.g. "RyansMini250233" from "RyansMini250233.rozich"). */
export function shortHostName(host: string): string {
  const dot = host.indexOf(".");
  return dot === -1 ? host : host.slice(0, dot);
}

/** The minimal worker shape the per-host count needs. */
export interface HostWorkerInput {
  activeState: BoardActiveState;
  host?: { name: string; id: string } | null;
}

/**
 * Count the BUSY workers on a host: workers whose `host.name` matches AND whose
 * activeState is not "dead" (a dead worker consumes no live slot — CTL-928). The
 * host name is matched on the raw value (not the short form) so the matrix's
 * per-host filter agrees with the board's host attribution. PURE + exported.
 */
export function hostWorkerCount(
  workers: readonly HostWorkerInput[],
  host: string,
): number {
  let n = 0;
  for (const w of workers) {
    if (w.host?.name !== host) continue;
    if (w.activeState === "dead") continue;
    n += 1;
  }
  return n;
}

/** Map a cluster node status → the matrix daemon cell tone (status color var).
 *  live → green/fg, degraded → amber, offline → red. PURE + exported. */
export function nodeStatusVar(status: ClusterNodeStatus): string {
  if (status === "live") return "var(--chart-2)";
  if (status === "degraded") return "var(--chart-3)";
  return "var(--chart-4)";
}

/** The rendered FleetOps "Daemon" cell for a node. */
export interface DaemonCell {
  /** The cell word: "live" | "degraded" | "OFFLINE" | "holding" | "holding (<reason>)". */
  label: string;
  /** The status-color CSS var for the label. */
  color: string;
  /** Hover title spelling out a hold reason, else undefined. */
  title?: string;
}

/**
 * The FleetOps "Daemon" cell for a node (CTL-1322). Normally the liveness word,
 * BUT a LIVE node that is NOT accepting new work (admission `accepting === false`)
 * is the exact FleetOps blind spot — it would otherwise read "live" while the
 * new-work gate is shut. Such a node renders "holding (<reason>)" in AMBER (warn),
 * never red — a drain / liveness-cold hold is operator-intent or transient, not a
 * failure. Precedence: the liveness word wins when the node is degraded or offline
 * (a shaky/dead daemon's holding sub-state is less actionable than its liveness) —
 * matching the footer tooltip's offline/degraded-first ordering, so the two surfaces
 * agree. The check is STRICT `=== false`, so an ABSENT `accepting` (remote peer /
 * unknown) falls through to the plain liveness word — never a fabricated hold.
 * PURE + exported.
 */
export function daemonCell(
  node: Pick<ClusterSignalNode, "status" | "accepting" | "holdReason">,
): DaemonCell {
  const { status } = node;
  if (status === "live" && node.accepting === false) {
    const reason = node.holdReason ?? null;
    return {
      label: reason ? `holding (${reason})` : "holding",
      color: "var(--chart-3)", // amber/warn — operator-intent hold, not a failure
      title: `not accepting new work${reason ? ` — ${reason}` : ""}`,
    };
  }
  const label = status === "live" ? "live" : status === "degraded" ? "degraded" : "OFFLINE";
  return { label, color: nodeStatusVar(status) };
}
