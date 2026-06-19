// cache-reconcile.mjs — periodic broker-side reconcile of the board cache
// (filter-state.db ticket_state) against LIVE Linear, for the fields the board
// derives from: linear_state + labels (CTL-1277).
//
// WHY: ticket_state is webhook-fed (foldLinearIssueDescriptor). A single missed
// linear.issue.* webhook leaves a row's state/labels wrong indefinitely — the
// board then lies (proven: CTL-764 live=Implement but cache=Todo). Nothing
// periodically re-syncs it. This generalizes the CTL-1031 label backfill from a
// one-shot CLI into a periodic state+labels reconcile over the working set.
//
// This is the INTERIM bridge. The durable fix is the Pillar-1 cloud read-mirror;
// its reconciler reuses exactly this delta-fetch+diff shape (the design doc
// flags this as a port, not throwaway). RELATIONS are a separate ticket
// (CTL-1278) — they need a full-poll-and-diff with delete-absent and have no
// existing fetch path.
//
// The broker is the SOLE ticket_state writer (execution-core opens it read-only
// via gateway-read). This module only ever writes via upsertTicketDescriptor's
// KEY-PRESENCE contract: it passes ONLY the reconciled fields, so every other
// column (assignee, priority, estimate, relations, fence projection) is left
// untouched.

import { spawnSync } from "node:child_process";
import {
  getAllTicketDescriptors,
  upsertTicketDescriptor,
} from "./broker-state.mjs";
import { extractLabelNames } from "./backfill-ticket-labels.mjs";

// Mode knob: env CATALYST_CACHE_RECONCILE overrides Layer-2 config; operators
// opt in via =shadow (log would-write, touch nothing) then =enforce (write).
// Default OFF — zero behaviour change until explicitly enabled.
export function readCacheReconcileConfig(env = process.env) {
  const raw = String(env.CATALYST_CACHE_RECONCILE ?? "off").toLowerCase();
  const mode = raw === "shadow" || raw === "enforce" ? raw : "off";
  const intervalMs = positiveIntOr(
    env.CATALYST_CACHE_RECONCILE_INTERVAL_MS,
    10 * 60_000, // 10 min — gentle on the per-host Linear key (self-constraint)
  );
  const perPassCap = positiveIntOr(env.CATALYST_CACHE_RECONCILE_CAP, 250);
  return { mode, intervalMs, perPassCap };
}

function positiveIntOr(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Linear states whose tickets we skip — once a ticket is terminal its board
// state/labels no longer drive dispatch, and reading them every pass is wasted
// API budget. (Terminal needs-human reap is a separate concern — CTL-1242.)
const TERMINAL_STATES = new Set(["done", "canceled", "cancelled", "duplicate"]);

function isTerminal(state) {
  return TERMINAL_STATES.has(String(state ?? "").toLowerCase());
}

// extractState — pull the state NAME out of a `linearis issues read` JSON object.
// linearis returns `state: { id, name }`. Returns the name string, or null when
// state is absent/malformed (caller treats null as "unknown — do not touch").
export function extractState(readJson) {
  if (readJson === null || typeof readJson !== "object") return null;
  const state = readJson.state;
  if (state === null || typeof state !== "object" || Array.isArray(state)) return null;
  const name = state.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function arraysEqualAsSets(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

// decideReconcile — pure per-ticket decision. Given the cached descriptor (or
// null) and the freshly-fetched live state/labels (each null when the fetch was
// unusable for that field), decide which fields drifted and must be written.
// KEY-PRESENCE: only fields with writeX:true are sent to upsert — never the rest.
export function decideReconcile({ current, fetchedState, fetchedLabels }) {
  const storedState = current && typeof current.state === "string" ? current.state : null;
  const storedLabels = current && Array.isArray(current.labels) ? current.labels : null;

  // null fetch → unknown → leave untouched. A case-insensitive state match is
  // "no drift" (Linear "Implement" vs a cache "implement" is the same column).
  const writeState =
    fetchedState !== null &&
    (storedState === null ||
      storedState.toLowerCase() !== fetchedState.toLowerCase());

  const writeLabels =
    fetchedLabels !== null &&
    !(storedLabels !== null && arraysEqualAsSets(storedLabels, fetchedLabels));

  const reasons = [];
  if (writeState) reasons.push(`state ${JSON.stringify(storedState)} → ${JSON.stringify(fetchedState)}`);
  if (writeLabels) reasons.push(`labels ${JSON.stringify(storedLabels)} → ${JSON.stringify(fetchedLabels)}`);

  return {
    writeState,
    state: writeState ? fetchedState : undefined,
    writeLabels,
    labels: writeLabels ? fetchedLabels : undefined,
    changed: writeState || writeLabels,
    reason: reasons.length ? reasons.join("; ") : "already current",
  };
}

// fetchLive — spawn `linearis issues read <ticket>` and parse its JSON.
// linearis emits JSON by default (NO --json flag) and EATS STDIN in loops, so
// we pass stdin "ignore". Returns { state, labels, error }: state/labels null on
// any failure (fail-soft — leave the row for the next pass).
function fetchLive(ticket) {
  let res;
  try {
    res = spawnSync("linearis", ["issues", "read", ticket], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 30_000,
    });
  } catch (e) {
    return { state: null, labels: null, error: String(e?.message ?? e) };
  }
  if (res.status !== 0 || !res.stdout) {
    return { state: null, labels: null, error: (res.stderr || "").trim() || `exit ${res.status}` };
  }
  let json;
  try {
    json = JSON.parse(res.stdout);
  } catch (e) {
    return { state: null, labels: null, error: `unparseable JSON: ${String(e)}` };
  }
  return { state: extractState(json), labels: extractLabelNames(json), error: null };
}

// reconcileCacheState — one full pass over the working set. Injectable deps keep
// it unit-testable with no spawn / no DB. Returns a summary {mode,scanned,changed,
// failed,tickets[]} for the audit emit. NEVER throws — a per-ticket failure is
// counted and skipped (fail-soft).
export function reconcileCacheState({
  mode = "off",
  perPassCap = 250,
  getAll = getAllTicketDescriptors,
  fetch = fetchLive,
  upsert = upsertTicketDescriptor,
  log = () => {},
} = {}) {
  if (mode === "off") return { mode, scanned: 0, changed: 0, failed: 0, tickets: [] };

  let descriptors;
  try {
    descriptors = getAll({ includeRemoved: false }) || [];
  } catch (e) {
    log("warn", { err: String(e?.message ?? e) }, "cache-reconcile: getAll failed — skipping pass");
    return { mode, scanned: 0, changed: 0, failed: 0, tickets: [] };
  }

  const working = descriptors.filter((d) => d && d.ticket && !isTerminal(d.state)).slice(0, perPassCap);

  let scanned = 0;
  let changed = 0;
  let failed = 0;
  const tickets = [];

  for (const current of working) {
    const ticket = current.ticket;
    scanned += 1;
    let live;
    try {
      live = fetch(ticket);
    } catch (e) {
      live = { state: null, labels: null, error: String(e?.message ?? e) };
    }
    if (live.error || (live.state === null && live.labels === null)) {
      failed += 1;
      log("debug", { ticket, err: live.error }, "cache-reconcile: fetch unusable — left for next pass");
      continue;
    }

    const decision = decideReconcile({
      current,
      fetchedState: live.state,
      fetchedLabels: live.labels,
    });
    if (!decision.changed) continue;

    changed += 1;
    tickets.push({ ticket, reason: decision.reason });

    if (mode === "shadow") {
      log("info", { ticket, reason: decision.reason }, "ctl-1277 cache-reconcile [shadow] WOULD write");
      continue;
    }

    // enforce: write ONLY the drifted fields (key-presence).
    const patch = { ticket };
    if (decision.writeState) patch.state = decision.state;
    if (decision.writeLabels) patch.labels = decision.labels;
    try {
      upsert(patch);
      log("info", { ticket, reason: decision.reason }, "ctl-1277 cache-reconcile wrote");
    } catch (e) {
      failed += 1;
      changed -= 1;
      tickets.pop();
      log("warn", { ticket, err: String(e?.message ?? e) }, "cache-reconcile: upsert failed — left for next pass");
    }
  }

  return { mode, scanned, changed, failed, tickets };
}

// startCacheReconcileTimer — wire the periodic pass into the broker. Returns the
// interval id (caller clears it on shutdown), or null when mode=off (no timer).
// `emit` records one audit event per pass; `log` is the broker logger.
export function startCacheReconcileTimer({
  config = readCacheReconcileConfig(),
  reconcile = reconcileCacheState,
  emit = () => {},
  log = () => {},
  setTimer = setInterval,
} = {}) {
  const { mode, intervalMs, perPassCap } = config;
  if (mode === "off") {
    log("info", { mode }, "ctl-1277 cache-reconcile: disabled (CATALYST_CACHE_RECONCILE=off)");
    return null;
  }
  log("info", { mode, intervalMs, perPassCap }, "ctl-1277 cache-reconcile: enabled");

  const runPass = () => {
    let summary;
    try {
      summary = reconcile({ mode, perPassCap, log });
    } catch (e) {
      log("warn", { err: String(e?.message ?? e) }, "cache-reconcile: pass threw — caught (fail-soft)");
      return;
    }
    try {
      emit({
        kind: "cache.reconcile",
        mode: summary.mode,
        scanned: summary.scanned,
        changed: summary.changed,
        failed: summary.failed,
      });
    } catch {
      // emit is best-effort — never let telemetry break the pass.
    }
    if (summary.changed > 0 || summary.failed > 0) {
      log("info", summary, "ctl-1277 cache-reconcile: pass complete");
    }
  };

  return setTimer(runPass, intervalMs);
}
