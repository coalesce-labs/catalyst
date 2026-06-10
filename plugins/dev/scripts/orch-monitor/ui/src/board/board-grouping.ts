// board-grouping.ts — the PURE row-swimlane grouping engine for the tickets/workers
// board (BOARD3 / CTL-907). The tickets-board SIBLING of worker-grouping.ts (SURF1,
// node columns for the Workers grid) and queue-grouping.ts (SURF2, node grouping for
// the Queue): same React-/DOM-free discipline, same host.id dedup, same single-host
// identity no-op. Unit-tested under `bun test` (board-grouping.test.ts).
//
// The board's only row-grouping today is repo lanes (the `swimlane === "repo"`
// branch). BOARD3 generalizes that single boolean axis into a real grouping engine
// over the persisted BOARD2 `Swimlane` union (none | repo | team | project | host),
// each lane carrying a header + count, with the column board preserved INSIDE every
// lane and single-group rendering as an exact identity no-op (one lane, zero added
// chrome) — exactly how `queueHostMode === "single"` and `isMultiHost === false`
// collapse the two sibling surfaces.
//
// SINGLE-HOST: with one node every entity's `host` is the same single ref (or null
// when un-stamped today) → one distinct key → buildLanes returns one lane. The
// caller (SwimlaneBoard/BoardList) consults showLaneChrome — an explicit axis renders
// that one labeled lane WITH header. Same structural code path as multi-host.
import type { BoardHostRef } from "./types";
// The grouping axes are exactly the persisted BOARD2 Swimlane union — there is ONE
// definition (prefs-store.ts) the popover writes and this engine groups by, so a
// new axis cannot drift between the control and the renderer.
import type { Swimlane as GroupBy } from "./prefs-store";

export type { GroupBy };

/** The minimal structural shape buildLanes needs from a board entity — the REAL
 *  shipped fields. Both BoardTicket and BoardWorker satisfy it (CTL-930: grouping
 *  is generic over entities, so the future Workers lens reuses it unchanged).
 *  `host` is the {name,id} ref BFF10/CTL-922 already stamps; `project` is null on
 *  BoardWorker today (a small additive BFF item, not a BOARD3 blocker). Liveness
 *  is NOT here — it is an injected overlay (see HostLiveness). */
export interface GroupableEntity {
  team?: string | null;
  project?: string | null;
  repo?: string | null;
  host?: BoardHostRef | null;
}

/** Optional liveness overlay (deferred BFF item): host.id maps to a state. Absent
 *  means no liveness dot. NOT shipped on the payload yet — the host axis groups
 *  correctly without it; the dot lights once the BFF stamps the map. */
export type HostLiveness = Record<string, "live" | "degraded" | "offline">;

/** Sentinel lane key for entities missing the grouping attribute (and the synthetic
 *  single lane the "none" axis emits). A bracketed reserved token so it can never
 *  collide with a real team/project/repo/host value (none of which are this
 *  bracketed reserved word). Plain ASCII — no control bytes (a NUL would make git
 *  treat this source as binary). */
export const UNASSIGNED = "__catalyst_unassigned__";

/** A resolved lane: a stable key, a human label, the entities in it, and (host axis
 *  only) a liveness flag for the header dot. */
export interface Lane<T> {
  key: string;
  label: string;
  /** null = no dot (non-host axis, the fallback lane, or no overlay supplied). */
  live: "live" | "degraded" | "offline" | null;
  items: T[];
}

/** The catch-all lane's label per axis (entities missing that axis's attribute). */
const LANE_FALLBACK_LABEL: Record<GroupBy, string> = {
  none: "",
  repo: "Unassigned",
  team: "No team",
  // Gherkin: tickets with no project fall into an "Unassigned" lane. host parity
  // with queue-grouping's UNATTRIBUTED_HOST_LABEL = "Unassigned".
  project: "Unassigned",
  host: "Unassigned",
};

/** Resolve the grouping key for one entity under an axis. Missing/empty → UNASSIGNED.
 *  Host keys by `host.id` (deduped exactly as queue-grouping.ts:hostKey and the
 *  read-model's groupByHost: the same node under two names is ONE lane). */
export function groupKeyFor(e: GroupableEntity, by: GroupBy): string {
  if (by === "none") return UNASSIGNED;
  const raw =
    by === "team" ? e.team
    : by === "project" ? e.project
    : by === "repo" ? e.repo
    : e.host?.id;
  return raw == null || raw === "" ? UNASSIGNED : raw;
}

/** The display LABEL for a lane from its first member: host uses host.name (keyed by
 *  id, labeled by name — the queue-grouping rule); other axes use the value itself;
 *  the catch-all lane uses the axis fallback. */
function laneLabelFor<T extends GroupableEntity>(first: T, by: GroupBy, key: string): string {
  if (key === UNASSIGNED) return LANE_FALLBACK_LABEL[by];
  if (by === "host") return first.host?.name ?? key;
  return key;
}

const LIVE_RANK = { live: 0, degraded: 1, offline: 2 } as const;

/**
 * Build the ordered, labeled lane list for a flat entity array under an axis.
 *
 * Ordering contract:
 *   - axis === "none": exactly one lane (UNASSIGNED, empty label), so the caller
 *     renders the flat board with no chrome. Identity no-op.
 *   - real lanes: sorted case-insensitively by label (stable, deterministic — a
 *     reload never reshuffles), with the catch-all ("Unassigned" / "No team")
 *     lane ALWAYS sorted LAST so it sinks to the bottom.
 *   - host axis WITH an overlay: live band, then degraded, then offline; alpha
 *     within each band; catch-all last. WITHOUT an overlay: alpha, catch-all last.
 *
 * Empty-lane handling: buildLanes only emits lanes that HAVE entities (it groups
 * the entities it is given). "Show empty columns" is a *column*-level concern owned
 * by Column/board-display.ts — orthogonal to swimlanes. There is no empty swimlane.
 *
 * Single-lane policy (CTL-930 Phase 3): an explicit axis always renders chrome for
 * any lane count ≥ 1 via showLaneChrome. A single lane shows a header + singleLaneHint.
 * `axis="none"` keeps the classic identity no-op (bare board, no chrome).
 */
// ── Phase 3 — showLaneChrome + singleLaneHint ────────────────────────────────

/**
 * Shared lane-chrome policy: headers render when the operator explicitly
 * selected an axis AND at least one lane exists. axis="none" → no chrome.
 * Zero lanes (empty entity set on a real axis) → no chrome.
 *
 * THE regression lock: an explicit axis (team/project/repo/host) ALWAYS renders
 * lane chrome even for a single lane — swimlane=repo + single-repo scope collapses
 * naturally to ONE labeled lane WITH header, never silently flattens.
 */
export function showLaneChrome(by: GroupBy, laneCount: number): boolean {
  return by !== "none" && laneCount > 0;
}

/**
 * Single-lane hint text, rendered inline after the count chip when laneCount === 1.
 * null for axis="none" (no chrome at all). Uses singular/plural based on count.
 */
export function singleLaneHint(
  by: GroupBy,
  lane: Lane<unknown>,
  noun: "ticket" | "worker",
): string | null {
  if (by === "none") return null;
  const count = lane.items.length;
  const isUnassigned = lane.key === UNASSIGNED;
  const plural = count !== 1;
  const subj = plural ? `All ${count} ${noun}s` : `The only ${noun} here`;
  const predSuffix = plural ? "s" : "";

  if (by === "team") {
    return isUnassigned
      ? `${subj} have no team`
      : `${subj} ${plural ? "are" : "is"} in team ${lane.label}`;
  }
  if (by === "project") {
    return isUnassigned
      ? `${subj} have no project`
      : `${subj} ${plural ? "are" : "is"} in project ${lane.label}`;
  }
  if (by === "repo") {
    return isUnassigned
      ? `${subj} have no repo`
      : `${subj} ${plural ? "are" : "is"} in repo ${lane.label}`;
  }
  if (by === "host") {
    return isUnassigned
      ? `${subj} aren't attributed to a host yet`
      : `${subj} ${plural ? "are" : "is"} on host ${lane.label}`;
  }
  return null;
}

export function buildLanes<T extends GroupableEntity>(
  items: T[],
  by: GroupBy,
  liveness?: HostLiveness,
): Lane<T>[] {
  if (by === "none") {
    return [{ key: UNASSIGNED, label: "", live: null, items }];
  }
  // Each bucket carries its `first` member alongside its items, captured when the
  // bucket is created — so labeling never has to index `items[0]` (no out-of-range
  // concern, no cast, no non-null assertion; honest under noUncheckedIndexedAccess).
  const byKey = new Map<string, { first: T; items: T[] }>();
  for (const e of items) {
    const k = groupKeyFor(e, by);
    const bucket = byKey.get(k);
    if (bucket) bucket.items.push(e);
    else byKey.set(k, { first: e, items: [e] });
  }
  const isHost = by === "host";
  const lanes: Lane<T>[] = [...byKey.entries()].map(([key, { first, items: laneItems }]) => ({
    key,
    label: laneLabelFor(first, by, key),
    // liveness only on the host axis, only when an overlay was supplied, and only
    // for a real (attributed) host lane. Otherwise no dot.
    live: isHost && liveness && key !== UNASSIGNED ? (liveness[key] ?? null) : null,
    items: laneItems,
  }));
  lanes.sort((a, b) => {
    const af = a.key === UNASSIGNED ? 1 : 0;
    const bf = b.key === UNASSIGNED ? 1 : 0;
    if (af !== bf) return af - bf; // catch-all lane always last
    if (isHost && a.live && b.live && a.live !== b.live) {
      return LIVE_RANK[a.live] - LIVE_RANK[b.live]; // live -> degraded -> offline
    }
    return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  });
  return lanes;
}
