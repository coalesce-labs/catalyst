#!/usr/bin/env bun
// backfill-ticket-labels.mjs — one-shot, idempotent repair for the
// ticket_state.labels gap (CTL-1031).
//
// The webhook label-parse bug (linear-webhook-events.ts parseLabelNames only
// accepting the GraphQL `{nodes}` shape, never the webhook's flat array) meant
// every label-change webhook folded to toLabels:null, so the broker NEVER wrote
// a ticket's label set into ticket_state (router.mjs:1035 treats null as
// unknown-keep). Live evidence on mini: 1/759 rows had labels, 0 had held_since.
//
// Fixing the parser only repairs FUTURE webhooks. This script repairs the
// already-stale cache: for each non-terminal ticket in ticket_state (or the
// tickets passed as args) it fetches the CURRENT label set from Linear via the
// `linearis` CLI, writes it into ticket_state.labels, and — when a held label
// (blocked/waiting) is present and held_since is empty — stamps held_since so
// the dashboard's hold-duration clock starts.
//
// Idempotent: re-running writes the same labels and never overwrites an
// existing held_since (setTicketHeldSince is COALESCE-sticky). DRY-RUN by
// default; pass --yes to actually write.
//
// Usage:
//   bun backfill-ticket-labels.mjs                 # dry-run, all non-terminal
//   bun backfill-ticket-labels.mjs --yes           # write, all non-terminal
//   bun backfill-ticket-labels.mjs CTL-1031 CTL-42 # dry-run, just these
//   bun backfill-ticket-labels.mjs --yes CTL-1031  # write, just these
//   bun backfill-ticket-labels.mjs --db /path/to/filter-state.db --yes
//
// The pure decision helpers (extractLabelNames, decideLabelBackfill,
// HELD_LABELS, hasHeldLabel) are exported for unit testing; the CLI spawn and
// DB writes are exercised only at runtime.

import { spawnSync } from "node:child_process";

// HELD_LABELS / hasHeldLabel — mirror router.mjs's held-label predicate
// (router.mjs:979-981). A ticket is "held" (its dispatch clock paused) when its
// label set contains blocked or waiting. Kept in sync deliberately: the
// backfill must stamp held_since for exactly the tickets the live fold would.
export const HELD_LABELS = ["blocked", "waiting"];

export function hasHeldLabel(labels) {
  return Array.isArray(labels) && labels.some((l) => HELD_LABELS.includes(l));
}

// extractLabelNames — pull the label-name list out of a `linearis issues read`
// JSON object. linearis returns the GraphQL relation shape
// `labels: { nodes: [{ id, name }] }`. Returns:
//   • string[] (possibly empty) when labels is a well-formed {nodes:[…]} object
//   • null when labels is absent / malformed (so the caller treats it as
//     "unknown — do not touch the stored set", matching the parser's [] vs null
//     contract)
// Names are de-duplicated and order-preserved; blank/non-string names dropped.
export function extractLabelNames(readJson) {
  if (readJson === null || typeof readJson !== "object") return null;
  const labels = readJson.labels;
  if (labels === null || typeof labels !== "object" || Array.isArray(labels)) return null;
  const nodes = labels.nodes;
  if (!Array.isArray(nodes)) return null;
  const seen = new Set();
  const names = [];
  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    const name = node.name;
    if (typeof name !== "string" || name.length === 0) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

// arraysEqualAsSets — order-insensitive equality for two label-name arrays.
function arraysEqualAsSets(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

// decideLabelBackfill — pure decision for one ticket. Given the ticket's
// current cached descriptor (or null) and the freshly fetched label names (or
// null when the fetch was unusable), decide what to write.
//
// Returns:
//   {
//     writeLabels: boolean,   // upsert ticket_state.labels = fetched?
//     labels: string[]|null,  // the value to write (when writeLabels)
//     stampHeldSince: boolean // call setTicketHeldSince (sticky)?
//     clearHeldSince: boolean // call clearTicketHeldSince?
//     reason: string          // human-readable explanation for the report
//   }
//
// Rules:
//   • fetched === null  → unknown; touch nothing (writeLabels:false).
//   • fetched matches stored labels exactly (as a set) → no label write needed,
//     but STILL reconcile held_since (the original bug left held_since empty
//     even when labels happened to be right).
//   • otherwise write the fetched set.
//   • held_since: stamp when a held label is present AND held_since is empty
//     (sticky — never overwrite an existing start). Clear when no held label is
//     present but held_since is currently set.
export function decideLabelBackfill({ current, fetched }) {
  if (fetched === null) {
    return {
      writeLabels: false,
      labels: null,
      stampHeldSince: false,
      clearHeldSince: false,
      reason: "fetch-unusable (labels absent/malformed) — left untouched",
    };
  }
  const storedLabels = current && Array.isArray(current.labels) ? current.labels : null;
  const storedHeldSince = current ? (current.heldSince ?? null) : null;

  const labelsMatch = storedLabels !== null && arraysEqualAsSets(storedLabels, fetched);
  const writeLabels = !labelsMatch;

  const held = hasHeldLabel(fetched);
  const stampHeldSince = held && !storedHeldSince;
  const clearHeldSince = !held && !!storedHeldSince;

  let reason;
  if (writeLabels) {
    reason = `labels ${JSON.stringify(storedLabels)} → ${JSON.stringify(fetched)}`;
  } else {
    reason = "labels already current";
  }
  if (stampHeldSince) reason += "; stamp held_since (held label present)";
  if (clearHeldSince) reason += "; clear held_since (no held label)";

  return { writeLabels, labels: fetched, stampHeldSince, clearHeldSince, reason };
}

// TERMINAL_STATES — Linear states whose tickets we skip (no live label fold
// matters once a ticket is Done/Canceled/Duplicate). Matched case-insensitively
// against the cached linear_state name.
const TERMINAL_STATES = new Set(["done", "canceled", "cancelled", "duplicate"]);

function isTerminal(descriptor) {
  const s = descriptor && typeof descriptor.state === "string" ? descriptor.state.toLowerCase() : "";
  return TERMINAL_STATES.has(s);
}

// fetchLabelNames — spawn `linearis issues read <ticket>` and parse its JSON.
// linearis emits JSON by default (NO --json flag) and EATS STDIN in loops, so
// we pass stdin: "ignore" (the </dev/null equivalent). Returns string[]|null.
function fetchLabelNames(ticket) {
  const res = spawnSync("linearis", ["issues", "read", ticket], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.status !== 0 || !res.stdout) {
    return { names: null, error: (res.stderr || "").trim() || `exit ${res.status}` };
  }
  let json;
  try {
    json = JSON.parse(res.stdout);
  } catch (e) {
    return { names: null, error: `unparseable JSON: ${String(e)}` };
  }
  return { names: extractLabelNames(json), error: null };
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--yes");
  let dbPath = null;
  const tickets = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes" || a === "--dry-run") continue;
    if (a === "--db") {
      dbPath = argv[++i] ?? null;
      continue;
    }
    if (a.startsWith("--")) continue;
    tickets.push(a);
  }

  // Lazy import so the pure helpers above can be unit-tested without bun:sqlite.
  const state = await import("./broker-state.mjs");
  state.openBrokerStateDb(dbPath ?? undefined);

  let candidates;
  if (tickets.length > 0) {
    candidates = tickets.map((t) => state.getTicketDescriptor(t) ?? { ticket: t, state: null, labels: null, heldSince: null });
  } else {
    candidates = state.getAllTicketDescriptors().filter((d) => !isTerminal(d));
  }

  const mode = write ? "WRITE" : "DRY-RUN";
  process.stdout.write(`backfill-ticket-labels [${mode}] — ${candidates.length} candidate ticket(s)\n`);

  let touched = 0;
  let skipped = 0;
  let failed = 0;
  for (const descriptor of candidates) {
    const ticket = descriptor.ticket;
    const { names, error } = fetchLabelNames(ticket);
    if (error) {
      failed++;
      process.stdout.write(`  ✗ ${ticket}: fetch failed (${error})\n`);
      continue;
    }
    const decision = decideLabelBackfill({ current: descriptor, fetched: names });
    if (!decision.writeLabels && !decision.stampHeldSince && !decision.clearHeldSince) {
      skipped++;
      continue;
    }
    touched++;
    process.stdout.write(`  ${write ? "→" : "·"} ${ticket}: ${decision.reason}\n`);
    if (write) {
      if (decision.writeLabels) {
        state.upsertTicketDescriptor({ ticket, labels: decision.labels });
      }
      if (decision.stampHeldSince) {
        state.setTicketHeldSince(ticket, null);
      } else if (decision.clearHeldSince) {
        state.clearTicketHeldSince(ticket);
      }
    }
  }

  process.stdout.write(
    `\n${mode} complete — ${touched} ${write ? "written" : "would change"}, ${skipped} already-current, ${failed} fetch-failed\n`
  );
  if (!write && touched > 0) {
    process.stdout.write(`Re-run with --yes to apply.\n`);
  }
  state.closeBrokerStateDb();
}

// Only run the CLI when invoked directly (not when imported by the unit test).
if (import.meta.main) {
  main().catch((e) => {
    process.stderr.write(`backfill-ticket-labels failed: ${String(e?.stack || e)}\n`);
    process.exit(1);
  });
}
