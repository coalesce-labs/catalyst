// linear-cache-reader.mjs — durable-cache Linear enrichment for the read-model
// (CTL-883).
//
// This REPLACES board-data.mjs::linearInfo()'s live `linearis issues list
// --team` call (the old 60s `_linearCache` that counted against the 2500/hr
// quota). It reads enrichment fields EXCLUSIVELY from durable caches the broker
// already maintains, so no request path ever triggers a synchronous Linear API
// call:
//
//   • filter-state.db → ticket_state (CTL-821 descriptor: linear_state, labels,
//     priority, relations, assignee, uuid) — the broker's webhook write-through.
//   • ~/catalyst/execution-core/eligible/{CTL,ADV,OTL}.json — the scheduler's
//     per-team eligible projection (priority/project/relations for tickets that
//     are queued but not yet a worker-dir; ticket_state may not carry priority
//     or project for those rows yet).
//
// ticket_state takes precedence (it is the freshest Linear-truth descriptor);
// the eligible projection fills gaps (notably `project`, which ticket_state does
// not store). `estimate` is projected into ticket_state from Linear webhooks
// (CTL-957) — it is a real numeric value when the broker has received an
// estimate-carrying event, or honest null otherwise. No live refetch is ever
// performed (CTL-883: cache-only, breaker-safe by design).
//
// The Linear circuit breaker (execution-core/linear-breaker.mjs) is honored by
// construction: this module spawns NOTHING, so an OPEN breaker cannot be tripped
// here and a cache read is served unconditionally. `breakerOpen` is accepted so
// the assembling read-model can record/telemeter degraded mode without this
// module ever blocking on a refresh.

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const DEFAULT_DB_PATH = join(HOME, "catalyst", "filter-state.db");
const DEFAULT_ELIGIBLE_DIR = join(HOME, "catalyst", "execution-core", "eligible");
// CTL-1372: the CTC replica (catalyst-replica.db) — the SDK's live Linear mirror,
// the only durable source that carries every ticket's title. CATALYST_REPLICA_DB
// overrides; otherwise default to $CATALYST_DIR/catalyst-replica.db.
// CTL-1378 (#2421 edge): resolve this PER CALL and honor CATALYST_DIR so it EXACTLY
// mirrors execution-core/config.mjs::getReplicaDbPath. The old frozen `join(HOME,
// "catalyst", …)` const ignored CATALYST_DIR, so a node configured with CATALYST_DIR
// set (but CATALYST_REPLICA_DB unset) had its real replica silently ignored and
// readReplicaTitles() returned {} — disabling the title tier.
function defaultReplicaDbPath() {
  return join(process.env.CATALYST_DIR || join(HOME, "catalyst"), "catalyst-replica.db");
}

// broker-state.mjs carries a top-level `import { Database } from "bun:sqlite"`.
// We reach it ONLY through the lazy `import()` in readTicketStateById, but the
// specifier MUST be computed (not a string literal) — see the long note there.
// Kept as a module constant so the path lives in one place and reads cleanly.
const BROKER_STATE_MODULE = ["..", "..", "broker", "broker-state.mjs"].join("/");

// CTL-1372: execution-core/replica-read.mjs ALSO carries a top-level
// `import { Database } from "bun:sqlite"`, so it is reached ONLY through the same
// computed-specifier lazy `import()` (never a string literal) for the exact reason
// BROKER_STATE_MODULE is — board-data.mjs statically imports THIS module, and
// ui/vite.config.ts statically imports board-data.mjs; a literal
// `import("../../execution-core/replica-read.mjs")` would let esbuild follow the
// relative graph and pull bun:sqlite into the Node-evaluated vite config bundle,
// which throws ERR_UNSUPPORTED_ESM_URL_SCHEME on `bun:` and breaks `vite build`
// (the monitor's deploy path; the CTL-1561 trap). The computed specifier stays an
// opaque runtime `import()` esbuild can't follow. DO NOT inline this to a literal.
const REPLICA_READ_MODULE = ["..", "..", "execution-core", "replica-read.mjs"].join("/");

// Normalize a stored ticket_state descriptor priority to the 0..4 Linear scale.
// ticket_state stores it as an INTEGER (0 = no priority, 1 = urgent .. 4 = low);
// a null/NaN means "cache has no priority for this ticket" → defer to eligible.
function normPriority(p) {
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

// Read every ticket_state descriptor in one query, via the broker's own helper
// (no hand-written SQL against the broker's table). Returns a `byId` map of the
// enrichment fields board-data consumes. Tolerant of an absent/locked DB: any
// failure yields {} so enrichment simply degrades to defaults (never throws,
// never blocks the assemble).
async function readTicketStateById(dbPath) {
  try {
    // bun:sqlite + the broker-state helpers are only available under Bun (the
    // orch-monitor server + vite middleware both run under Bun). Import lazily
    // so a non-Bun import of this module (e.g. a node-run tooling pass) fails
    // soft to {} instead of crashing at module load.
    //
    // CTL-883: the specifier is the COMPUTED `BROKER_STATE_MODULE` constant, NOT
    // a string literal — and that is load-bearing, not stylistic. board-data.mjs
    // (which statically imports this module) is itself statically imported by
    // ui/vite.config.ts. When Vite loads that config it esbuild-bundles the
    // config + its RELATIVE import graph, and esbuild follows relative dynamic
    // imports too — but ONLY when the argument is a plain string literal. A
    // literal `import("../../broker/broker-state.mjs")` would pull broker-state
    // (and its top-level `bun:sqlite`) into the Node-evaluated config bundle,
    // and Node throws ERR_UNSUPPORTED_ESM_URL_SCHEME on `bun:`, breaking
    // `vite build` (the monitor's deploy path). A computed specifier stays an
    // opaque runtime `import()` esbuild can't follow, so bun:sqlite never enters
    // the config graph. Under Bun at runtime the string resolves identically.
    // DO NOT inline this back to a literal.
    const [{ openBrokerStateDb, getAllTicketDescriptors }] = await Promise.all([
      import(BROKER_STATE_MODULE),
    ]);
    openBrokerStateDb(dbPath);
    const byId = {};
    for (const d of getAllTicketDescriptors()) {
      byId[d.ticket] = {
        priority: normPriority(d.priority),
        // CTL-957: estimate is NOW in ticket_state (projected from Linear webhooks).
        // null when the broker has not yet received an estimate-carrying event for
        // this ticket (older rows, or a ticket never touched by the webhook path).
        estimate: typeof d.estimate === "number" ? d.estimate : null,
        project: null, // ticket_state has no project column; eligible fills it.
        labels: Array.isArray(d.labels) ? d.labels.filter(Boolean) : [],
        relations: d.relations ?? null,
        assignee: d.assignee ?? null,
        linearState: d.state ?? null,
        // CTL-922 (BFF10) + CTL-884 (BFF2): the durable fence projection (BFF11 /
        // CTL-923 — the broker projects the catalyst://fence/<TICKET> attachment
        // into ticket_state). board-data stamps host:{name,id} + generation onto
        // every entity from this, so the node-aware surfaces and the fence-aware
        // web mutations read it from the cache, NEVER a live per-request
        // attachment fetch. owner_host is the host NAME; the {name,id} ref is
        // derived in board-data via the canonical sha256(name)[:16] id. The
        // cluster view (BFF2) groups by owner_host and also reads the companion
        // fence phase / claimed-at / held-since for node attribution + hold
        // duration. All null when no fence/held label has been observed.
        ownerHost: typeof d.ownerHost === "string" ? d.ownerHost : null,
        generation: typeof d.generation === "number" ? d.generation : null,
        fencePhase: d.fencePhase ?? null,
        claimedAt: d.claimedAt ?? null,
        heldSince: d.heldSince ?? null,
      };
    }
    return byId;
  } catch {
    return {};
  }
}

// ── parked needs-human tickets (off-board attention) ─────────────────────────
// The board's ticket set is built from LIVE worker dirs (liveTickets +
// betweenPhases + recentDone + queued + orphan-PR synthetics). A needs-human /
// needs-input ticket whose worker dir was torn down (the PARKED case — most
// parked tickets) is in NONE of those sets, so it never enters payload.tickets
// and never reaches the inbox — even though deriveAttention already supports the
// label. This reader is the cache source for that missing set: it mirrors
// router.mjs::countNeedsHumanTickets EXACTLY — SAME accessor
// (getAllTicketDescriptors → filter-state.db) and SAME predicate (non-removed,
// non-terminal, carries a needs-human/needs-input label) — so the inbox surfaces
// precisely the set the broker's pile-up signal counts.
//
// Labels + the Linear terminal set are mirrored LOCALLY (from
// broker/alert-emit.mjs NEEDS_HUMAN_LABELS + execution-core/terminal-state.mjs)
// so this cache reader pulls in nothing from the broker beyond the descriptor
// accessor — keeping the vite config graph free of bun:sqlite (see the long note
// in readTicketStateById).
const NEEDS_HUMAN_LABELS = ["needs-human", "needs-input"];
const TERMINAL_LINEAR_STATES = new Set(["Done", "Canceled"]);

// readAllTicketDescriptors — the SAME bulk descriptor accessor readTicketStateById
// uses, via the SAME computed-specifier lazy import (BROKER_STATE_MODULE — never a
// string literal, see that note). Returns the full descriptor rows (incl.
// updatedAt + removed) the parked filter below needs.
async function readAllTicketDescriptors(dbPath) {
  const { openBrokerStateDb, getAllTicketDescriptors } = await import(BROKER_STATE_MODULE);
  openBrokerStateDb(dbPath);
  return getAllTicketDescriptors();
}

// readParkedNeedsHumanTickets — the cache-sourced parked needs-human set. Returns
// minimal descriptors { ticket, labels, linearState, priority, updatedAt } for
// every non-removed, non-terminal ticket carrying a needs-human/needs-input label.
// Fail-OPEN: any read error degrades to [] — the inbox keeps its current
// worker-dir-sourced behavior and never throws out of the assemble (CTL-883
// posture, consistent with countNeedsHumanTickets returning 0 on a db error).
// `descriptorReader` is injectable so unit tests drive the predicate without a DB.
export async function readParkedNeedsHumanTickets({
  dbPath = DEFAULT_DB_PATH,
  descriptorReader = readAllTicketDescriptors,
} = {}) {
  let descriptors;
  try {
    descriptors = await descriptorReader(dbPath);
  } catch {
    return []; // db locked/absent → no parked cards (degrade to current behavior)
  }
  if (!Array.isArray(descriptors)) return [];
  const out = [];
  for (const d of descriptors) {
    if (!d || !d.ticket) continue;
    if (d.removed) continue; // tombstoned (getAllTicketDescriptors excludes these by default)
    if (d.state && TERMINAL_LINEAR_STATES.has(d.state)) continue; // Done/Canceled
    const labels = Array.isArray(d.labels) ? d.labels.filter(Boolean) : [];
    if (!labels.some((l) => NEEDS_HUMAN_LABELS.includes(l))) continue;
    out.push({
      ticket: d.ticket,
      labels,
      linearState: typeof d.state === "string" ? d.state : null,
      priority: normPriority(d.priority),
      // The freshest cache stamp on the descriptor — the honest "how long parked"
      // anchor for the inbox attention row. null when the row carried none.
      updatedAt: typeof d.updatedAt === "string" ? d.updatedAt : null,
    });
  }
  return out;
}

// ── CTC replica titles (CTL-1372) ───────────────────────────────────────────
// readReplicaTitles — the board's authoritative TITLE source. filter-state.db
// ticket_state has NO title column, and a PARKED ticket (worker dir torn down, no
// eligible row) has no other durable title source — so its board card otherwise
// renders as the bare id (e.g. "CTL-1214" instead of "Slim .catalyst/config.json…").
// The CTC replica (catalyst-replica.db) is the SDK's live Linear mirror and carries
// every title, so one BATCHED read over the board's ids resolves them all.
//
// GATING + FAIL-OPEN (board posture, NOT the dispatch path): the board is a
// read-only display, so this gates on FILE PRESENCE only — it does NOT consult the
// dispatch-side catalyst.linearReplica.mode flag (that flag governs the daemon's
// hot terminal-check, a correctness path; a display read has no such risk). When the
// replica is present it is used; ANY failure (absent file, unreadable, bad schema,
// lock) returns {} so the existing title chain (triage.title → linfo/eligible →
// on-demand fetch → id) is preserved EXACTLY. The board must never break or hang on
// the replica.
//
// The replica module (execution-core/replica-read.mjs) carries a top-level
// bun:sqlite import and is reached ONLY through the computed REPLICA_READ_MODULE
// specifier — same vite-graph trap-avoidance as readTicketStateById's
// BROKER_STATE_MODULE. `readerFactory` is injectable so unit tests drive the
// {id→title} contract offline (no real DB); when injected, the file-presence gate
// is skipped (the fake reader IS the DB).
//
// Returns { [identifier]: title } of HITS only (a miss is simply absent → caller
// falls through). Never throws.
export async function readReplicaTitles({
  ids = [],
  dbPath = process.env.CATALYST_REPLICA_DB || defaultReplicaDbPath(),
  readerFactory = null,
} = {}) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
  if (wanted.length === 0) return {};
  // File-presence gate (skipped when a test injects a reader). When the replica
  // isn't on this node, go straight to the existing chain — never open/throw.
  if (!readerFactory) {
    try {
      if (!existsSync(dbPath)) return {};
    } catch {
      return {};
    }
  }
  let reader = null;
  try {
    let factory = readerFactory;
    if (!factory) {
      ({ createReplicaReader: factory } = await import(REPLICA_READ_MODULE));
    }
    reader = factory({ dbPath });
    const titles = reader.titles(wanted);
    return titles && typeof titles === "object" ? titles : {};
  } catch {
    return {}; // any failure → fail-open to the existing title chain
  } finally {
    try {
      reader?.close?.();
    } catch {
      /* already closed */
    }
  }
}

// Read the scheduler's eligible projections for priority/project/relations on
// tickets that may not have a ticket_state row yet (queued, not-yet-worked).
async function readEligibleById(eligibleDir) {
  const byId = {};
  let files;
  try {
    files = await readdir(eligibleDir);
  } catch {
    return byId; // dir absent → no eligible enrichment
  }
  await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => {
        let raw;
        try {
          raw = JSON.parse(await readFile(join(eligibleDir, f), "utf8"));
        } catch {
          return; // unreadable/corrupt file → skip this team
        }
        const arr = Array.isArray(raw) ? raw : raw?.tickets || [];
        for (const t of arr) {
          const id = t.identifier || t.id;
          if (!id) continue;
          byId[id] = {
            priority: normPriority(t.priority),
            // CTL-957: estimate from the eligible projection (normalized by
            // linear-query.mjs::normalizeTicket). null when linearis returned
            // no estimate for the ticket (unset in Linear).
            estimate: typeof t.estimate === "number" ? t.estimate : null,
            project:
              t.project?.name ||
              (typeof t.project === "string" ? t.project : null) ||
              null,
            relations: t.relations ?? null,
            // title is only ever in the eligible projection (ticket_state has no
            // title column). BFF9 surfaces it so the cache-backed LinearFetcher
            // can serve /api/linear + /api/briefing without a live `linearis`.
            title: typeof t.title === "string" ? t.title : null,
          };
        }
      }),
  );
  return byId;
}

// readLinearCache — assemble the enrichment `byId` map the read-model hands to
// board-data, merging the durable ticket_state descriptor (authoritative) with
// the eligible projection (gap-filler). Pure-ish: all sources are injectable so
// the unit tests drive it without a real DB or homedir layout.
//
// Returns: { [ticketId]: { priority, estimate, project, labels, relations,
//   assignee, linearState, title, ownerHost, generation, fencePhase, claimedAt,
//   heldSince } }
export async function readLinearCache({
  dbPath = DEFAULT_DB_PATH,
  eligibleDir = DEFAULT_ELIGIBLE_DIR,
  // injection seams for tests (default to the real durable-cache readers)
  ticketStateReader = readTicketStateById,
  eligibleReader = readEligibleById,
  // The read-model passes the live breaker state purely so this function can
  // record that it is serving cache-only while the breaker is open. There is no
  // refresh path to gate — cache is ALWAYS served — so this is informational.
  breakerOpen = false,
} = {}) {
  // allSettled, not all: a single reader rejecting (e.g. a locked DB handle)
  // must degrade that source to {} rather than throw out of the assemble loop —
  // the read-model NEVER blocks on enrichment (CTL-883).
  const [tsRes, elRes] = await Promise.allSettled([
    ticketStateReader(dbPath),
    eligibleReader(eligibleDir),
  ]);
  const ticketState = tsRes.status === "fulfilled" ? tsRes.value : {};
  const eligible = elRes.status === "fulfilled" ? elRes.value : {};

  const ids = new Set([...Object.keys(ticketState), ...Object.keys(eligible)]);
  const byId = {};
  for (const id of ids) {
    const ts = ticketState[id];
    const el = eligible[id];
    byId[id] = {
      // priority: ticket_state first, else eligible, else 0 (Linear "no priority")
      priority: ts?.priority ?? el?.priority ?? 0,
      // CTL-957: estimate now flows from ticket_state (broker projects it from
      // Linear webhooks) — or from the eligible projection when ticket_state
      // has no row yet (queued ticket, not yet started). Honest null when
      // neither cache has seen an estimate for this ticket.
      estimate: ts?.estimate ?? el?.estimate ?? null,
      // project: ticket_state has no project column, so eligible owns it
      project: ts?.project ?? el?.project ?? null,
      labels: ts?.labels ?? [],
      relations: ts?.relations ?? el?.relations ?? null,
      assignee: ts?.assignee ?? null,
      linearState: ts?.linearState ?? null,
      // title: ticket_state has no title column, so the eligible projection is
      // the only durable source (BFF9). Honest null when neither cache has it.
      title: ts?.title ?? el?.title ?? null,
      // CTL-922 (BFF10) + CTL-884 (BFF2): the owning host NAME + fence companions
      // (generation, phase, claimed-at, held-since), projected into ticket_state
      // by the broker (BFF11). The eligible projection carries no fence data —
      // ticket_state is the sole durable source. board-data uses ownerHost (host
      // fallback) and generation (the value the web mutations pass to
      // isFenceCurrent without a live attachment fetch); the cluster view (BFF2)
      // groups by ownerHost and renders hold duration from heldSince. null when
      // no fence attachment has been observed for the ticket.
      ownerHost: ts?.ownerHost ?? null,
      generation: ts?.generation ?? null,
      fencePhase: ts?.fencePhase ?? null,
      claimedAt: ts?.claimedAt ?? null,
      heldSince: ts?.heldSince ?? null,
    };
  }
  // breakerOpen is intentionally not consulted to alter output — it cannot block
  // a cache read. Touch it so the contract (and the linter) stay honest.
  void breakerOpen;
  return byId;
}
