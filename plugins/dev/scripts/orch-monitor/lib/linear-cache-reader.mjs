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
// not store). `estimate` lives in neither durable cache, so it degrades to null
// rather than being re-fetched — the read-model never fabricates a value and
// never re-opens the live path (CTL-883: cache-only, breaker-safe by design).
//
// The Linear circuit breaker (execution-core/linear-breaker.mjs) is honored by
// construction: this module spawns NOTHING, so an OPEN breaker cannot be tripped
// here and a cache read is served unconditionally. `breakerOpen` is accepted so
// the assembling read-model can record/telemeter degraded mode without this
// module ever blocking on a refresh.

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const DEFAULT_DB_PATH = join(HOME, "catalyst", "filter-state.db");
const DEFAULT_ELIGIBLE_DIR = join(HOME, "catalyst", "execution-core", "eligible");

// broker-state.mjs carries a top-level `import { Database } from "bun:sqlite"`.
// We reach it ONLY through the lazy `import()` in readTicketStateById, but the
// specifier MUST be computed (not a string literal) — see the long note there.
// Kept as a module constant so the path lives in one place and reads cleanly.
const BROKER_STATE_MODULE = ["..", "..", "broker", "broker-state.mjs"].join("/");

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
        // estimate is NOT in the durable cache — honest null, never refetched.
        estimate: null,
        project: null, // ticket_state has no project column; eligible fills it.
        labels: Array.isArray(d.labels) ? d.labels.filter(Boolean) : [],
        relations: d.relations ?? null,
        assignee: d.assignee ?? null,
        linearState: d.state ?? null,
      };
    }
    return byId;
  } catch {
    return {};
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
            project:
              t.project?.name ||
              (typeof t.project === "string" ? t.project : null) ||
              null,
            relations: t.relations ?? null,
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
//   assignee, linearState } }
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
      // estimate: absent from both durable caches → honest null (no live refetch)
      estimate: ts?.estimate ?? null,
      // project: ticket_state has no project column, so eligible owns it
      project: ts?.project ?? el?.project ?? null,
      labels: ts?.labels ?? [],
      relations: ts?.relations ?? el?.relations ?? null,
      assignee: ts?.assignee ?? null,
      linearState: ts?.linearState ?? null,
    };
  }
  // breakerOpen is intentionally not consulted to alter output — it cannot block
  // a cache read. Touch it so the contract (and the linter) stay honest.
  void breakerOpen;
  return byId;
}
