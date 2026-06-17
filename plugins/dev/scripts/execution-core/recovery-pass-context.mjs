#!/usr/bin/env bun
// recovery-pass-context.mjs — read-only mode/context resolver for the
// recovery-pass skill (CTL-1176 rung 3). The skill runs this FIRST, then reads
// its banner to decide which path to take. It makes NO direct Linear API calls —
// it reads only local on-disk state (worker signals, the unified event log, and
// the webhook-fed Linear cache in filter-state.db).
//
// MODE=dispatched  → a single ticket is named (--ticket or $CATALYST_TICKET).
//                    Print the recovery-pass.json brief (the eyes+hands output).
//                    If the brief is missing, fall through to a ticket-scoped
//                    sweep so the agent still has something to act on.
// MODE=sweep       → no ticket. Enumerate the stuck set from THREE local sources,
//                    dedupe by ticket key, and print. HRW is a SOFT owner-signal
//                    here, NOT a hard filter: items are KEPT and ANNOTATED YOURS
//                    (you own it — act) vs CONTEXT (another host owns it — awareness
//                    only; a sibling you don't own may explain your conflict). At
//                    N=1 every item is YOURS (identity).
//
// The three sweep sources (union, dedupe by ticket key):
//   1. Worker signals    — ${ORCH_DIR}/workers/*/phase-*.json, status ∈
//                          {needs-human, failed, stalled}.
//   2. Unified event log  — recovery.escalated / recovery.would-escalate lines.
//   3. The local Linear cache (filter-state.db ticket_state) — tickets whose
//      cached labels intersect the stuck-label set, or whose linearState is a
//      non-terminal stuck-ish state. NO direct Linear API — getAllTicketDescriptors
//      is a pure read of the webhook-fed cache. Fail-open to empty if the db is
//      absent/unreadable (e.g. run under node where bun:sqlite is unavailable).
//
// Run under bun (broker-state uses bun:sqlite). Under node, source 3 degrades to
// "(linear cache unavailable under this runtime)" and the other two still run.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { ownerForTicket } from "./hrw.mjs";
import { getClusterHosts, getHostName } from "./config.mjs";

// ── arg parsing ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { ticket: "", orchDir: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ticket") out.ticket = argv[++i] || "";
    else if (a === "--orch-dir") out.orchDir = argv[++i] || "";
  }
  return out;
}

const STUCK_SIGNAL_STATUSES = new Set(["needs-human", "failed", "stalled"]);

// Cached Linear labels that mean "a human is needed / this is parked".
const STUCK_LABELS = new Set(["needs-human", "blocked", "waiting", "escalated", "stuck"]);

// Cached non-terminal Linear states that read as stuck-ish. Terminal states
// (Done/Canceled/Merged/Released) and the normal in-flight states are excluded.
const STUCK_LINEAR_STATES = new Set([
  "needs-human",
  "blocked",
  "waiting",
  "escalated",
  "stuck",
  "on hold",
  "paused",
]);

// ── JSON helpers (never throw — context-gather must always produce a banner) ──
function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ── source 1: worker signals ─────────────────────────────────────────────────
function collectWorkerSignals(orchDir) {
  const items = [];
  const workersDir = join(orchDir, "workers");
  let entries;
  try {
    entries = readdirSync(workersDir, { withFileTypes: true });
  } catch {
    return items; // no workers dir → nothing to enumerate
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = join(workersDir, ent.name);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/^phase-.*\.json$/.test(f)) continue;
      const sig = readJsonSafe(join(dir, f));
      if (!sig || typeof sig !== "object") continue;
      const status = sig.status;
      if (!STUCK_SIGNAL_STATUSES.has(status)) continue;
      const ticket = sig.ticket || ent.name;
      items.push({
        ticket,
        source: "signals",
        signalStatus: status,
        signalPath: join(dir, f),
        reason: sig.failureReason || "-",
      });
    }
  }
  return items;
}

// ── source 2: unified event log (recovery escalations) ───────────────────────
function eventLogPath() {
  const eventsDir =
    process.env.CATALYST_EVENTS_DIR ||
    join(process.env.CATALYST_DIR || join(process.env.HOME || "", "catalyst"), "events");
  const ym = new Date().toISOString().slice(0, 7); // YYYY-MM
  return join(eventsDir, `${ym}.jsonl`);
}

function collectEventLog() {
  const items = [];
  const path = eventLogPath();
  if (!existsSync(path)) return items;
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return items;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const evt = (() => {
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    })();
    if (!evt) continue;
    const name = evt?.attributes?.["event.name"] || "";
    if (!/^recovery\.(escalated|would-escalate)$/.test(name)) continue;
    const ticket = evt?.body?.payload?.ticket || evt?.attributes?.["event.label"] || "";
    if (!ticket) continue;
    items.push({
      ticket,
      source: "log",
      eventName: name,
      reason: evt?.body?.payload?.reason || "-",
    });
  }
  return items;
}

// ── source 3: the webhook-fed Linear cache (NO direct Linear API) ─────────────
async function collectLinearCache() {
  // getAllTicketDescriptors imports bun:sqlite. Under node that import throws;
  // catch it and signal cache-unavailable rather than aborting the whole gather.
  let getAll;
  try {
    ({ getAllTicketDescriptors: getAll } = await importBrokerState());
  } catch {
    return { unavailable: true, items: [] };
  }
  let rows;
  try {
    rows = getAll({ includeRemoved: false });
  } catch {
    // db absent/unreadable → fail-open to empty (still "available", just nothing)
    return { unavailable: false, items: [] };
  }
  const items = [];
  for (const row of rows || []) {
    const ticket = row?.ticket;
    if (!ticket) continue;
    const state = row?.state ?? row?.linearState ?? null;
    const labels = Array.isArray(row?.labels) ? row.labels : [];
    const labelHit = labels.some(
      (l) => typeof l === "string" && STUCK_LABELS.has(l.toLowerCase())
    );
    const stateHit = typeof state === "string" && STUCK_LINEAR_STATES.has(state.toLowerCase());
    if (!labelHit && !stateHit) continue;
    items.push({
      ticket,
      source: "cache",
      linearState: state || "-",
      labels,
      reason: stateHit ? `linear-state=${state}` : `labels=${labels.join(",")}`,
    });
  }
  return { unavailable: false, items };
}

// Indirect (non-literal) dynamic import so esbuild/Node never statically follow
// the bun:sqlite-bearing module graph at analysis time (the vite.config bun:sqlite
// trap, PR #1561). The specifier is computed, so it is resolved purely at runtime.
async function importBrokerState() {
  const spec = ["..", "broker", "broker-state.mjs"].join("/");
  return import(new URL(spec, import.meta.url).href);
}

// ── union + dedupe + HRW filter ──────────────────────────────────────────────
function unionDedupe(...lists) {
  const byTicket = new Map();
  for (const list of lists) {
    for (const item of list) {
      const key = item.ticket;
      if (!byTicket.has(key)) {
        byTicket.set(key, { ...item, sources: new Set([item.source]) });
      } else {
        const merged = byTicket.get(key);
        merged.sources.add(item.source);
        // Prefer a concrete signal status / reason when one source has it.
        if (!merged.signalStatus && item.signalStatus) merged.signalStatus = item.signalStatus;
        if (!merged.signalPath && item.signalPath) merged.signalPath = item.signalPath;
        if (!merged.linearState && item.linearState) merged.linearState = item.linearState;
        if (!merged.labels && item.labels) merged.labels = item.labels;
        if (!merged.eventName && item.eventName) merged.eventName = item.eventName;
        if ((!merged.reason || merged.reason === "-") && item.reason && item.reason !== "-")
          merged.reason = item.reason;
      }
    }
  }
  return [...byTicket.values()];
}

// ── output formatting ─────────────────────────────────────────────────────────
// `tag` is "YOURS" (act on it) or "CONTEXT" (another host owns it — awareness
// only). For CONTEXT items the owning host is annotated. Plain "STUCK …" (no
// tag) is used in the ticket-scoped fall-through where ownership is moot.
function formatSweepItem(item, tag) {
  const parts = [];
  if (item.signalStatus) parts.push(`signal-status=${item.signalStatus}`);
  if (item.linearState && item.linearState !== "-") parts.push(`linear-state=${item.linearState}`);
  if (item.labels && item.labels.length) parts.push(`labels=${item.labels.join(",")}`);
  if (tag === "CONTEXT" && item.owner) parts.push(`owner=${item.owner}`);
  parts.push(`source=${[...item.sources].sort().join("/")}`);
  const prefix = tag ? `STUCK ${tag}` : "STUCK";
  return `${prefix} ${item.ticket} [${parts.join(" | ")}] reason=${item.reason || "-"}`;
}

function printDispatchedBrief(ticket, orchDir) {
  console.log(`MODE=dispatched ticket=${ticket}`);
  const briefPath = join(orchDir, "workers", ticket, "recovery-pass.json");
  const brief = existsSync(briefPath) ? readJsonSafe(briefPath) : null;
  if (!brief) {
    console.log(`(no brief at ${briefPath} — reconstruct the diagnosis yourself)`);
    console.log("--- falling through to a ticket-scoped sweep ---");
    return false; // caller does the scoped sweep
  }
  console.log(`brief=${briefPath}`);
  console.log("--- failure reason ---");
  console.log(brief.failureReason || "(none)");
  console.log("--- diagnosis (eyes) ---");
  console.log(brief?.diagnosis?.reason || "(none)");
  console.log("--- deterministic seams already tried (hands — do NOT redo) ---");
  const seams = Array.isArray(brief.deterministicSeamsTried) ? brief.deterministicSeamsTried : [];
  if (seams.length === 0) {
    console.log("(none recorded)");
  } else {
    for (const s of seams) {
      console.log(`- ${s.category}: ${s.outcome}${s.marker ? ` (${s.marker})` : ""}`);
    }
  }
  console.log("--- guidance ---");
  console.log(brief.guidance || "(none)");
  console.log("--- recent log buffer (tail 40) ---");
  const logs = brief?.diagnosis?.logsOutput || "(no logs captured)";
  const tail = String(logs).split("\n").slice(-40).join("\n");
  console.log(tail);
  return true;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ticket = args.ticket || process.env.CATALYST_TICKET || "";
  const orchDir =
    args.orchDir ||
    process.env.CATALYST_ORCHESTRATOR_DIR ||
    join(process.env.HOME || "", "catalyst", "execution-core");

  // HRW context (identity no-op at N=1).
  let roster, self, multiHost;
  try {
    roster = getClusterHosts();
    self = getHostName();
    multiHost = Array.isArray(roster) && roster.length > 1;
  } catch {
    roster = [];
    self = "";
    multiHost = false;
  }

  if (ticket) {
    const hadBrief = printDispatchedBrief(ticket, orchDir);
    if (hadBrief) return;
    // Brief missing → ticket-scoped sweep so the agent still has the stuck context.
    const all = unionDedupe(
      collectWorkerSignals(orchDir),
      collectEventLog(),
      (await collectLinearCache()).items
    ).filter((it) => it.ticket === ticket);
    console.log("--- ticket-scoped stuck context ---");
    for (const it of all) console.log(formatSweepItem(it));
    console.log(`TOTAL: ${all.length} items (ticket-scoped)`);
    return;
  }

  // ── MODE=sweep ──────────────────────────────────────────────────────────────
  console.log("MODE=sweep");
  const signals = collectWorkerSignals(orchDir);
  const events = collectEventLog();
  const cache = await collectLinearCache();
  if (cache.unavailable) {
    console.log("(linear cache unavailable under this runtime)");
  }

  const union = unionDedupe(signals, events, cache.items);

  // HRW is a SOFT owner-signal, NOT a hard filter (a sibling ticket you don't own
  // may explain YOUR conflict). KEEP the whole stuck set; ANNOTATE each item with
  // its owner + whether it's mine. At N=1 every item is mine (identity).
  for (const it of union) {
    it.owner = ownerForTicket(it.ticket, roster);
    it.mine = !multiHost || it.owner === self;
  }
  union.sort((a, b) => a.ticket.localeCompare(b.ticket));

  const yours = union.filter((it) => it.mine);
  const context = union.filter((it) => !it.mine);

  // YOURS first — these are the items to act on.
  for (const it of yours) console.log(formatSweepItem(it, "YOURS"));

  // CONTEXT group — only when multiHost and there are non-owned items. Awareness
  // only; another host owns these. Do NOT act on them (avoid cross-host
  // double-action) — they may explain a conflict or dependency in YOUR items.
  if (multiHost && context.length > 0) {
    console.log(
      `--- CONTEXT (owned by another host — awareness only, do NOT act; roster=${roster.join(",")} self=${self}) ---`
    );
    for (const it of context) console.log(formatSweepItem(it, "CONTEXT"));
  }

  console.log(`TOTAL: ${union.length} items (${yours.length} yours, ${context.length} context)`);
}

main().catch((err) => {
  // Never crash the context gather — print a degraded banner and exit 0 so the
  // skill still proceeds (it can reconstruct from logs/gh directly).
  console.log("MODE=sweep");
  console.log(`(context-gather error: ${err?.message || err}; proceed manually)`);
  console.log("TOTAL: 0 items (0 yours, 0 context)");
});
