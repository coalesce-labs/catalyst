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

import { readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { scanEventsSince } from "./event-tail.mjs"; // CTL-1529: bounded event-log scan
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

// CTL-1529: bounded. This ran once per recovery-pass worker launch and
// materialized the entire monthly log (883 MB on mini) plus a ~1.4M-element split
// array, to find recent escalations. A sweep only cares about RECENT ones, so the
// natural bound is a time window: ESCALATION_LOOKBACK_MS back from now, capped in
// bytes by scanEventsSince. The pre-existing failure mode was silent — the catch
// dropped source 2 entirely and the sweep looked plausible but incomplete.
export const ESCALATION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ESCALATION_TAIL_MAX_BYTES — CTL-1529 (Codex P2). The ADVERTISED window above and
// the ACTUALLY SCANNED window have to agree, and under the shared 64 MiB
// DEFAULT_TAIL_MAX_BYTES they did not: at the ~34 MB/day this ticket measured on
// the fleet's busiest host, 64 MiB is exhausted after ~1.9 days, so escalations
// from the remaining ~5 days were dropped while the code still called itself a
// 7-day lookback. Silent truncation of a lookback the caller trusts is the exact
// class of bug this ticket exists to remove.
//
// DERIVATION: 7 days x 34 MB/day = 238 MB; round up to 256 MiB for ~8 % headroom.
// Affordable HERE and nowhere else in this PR: this runs ONCE per recovery-pass
// worker launch (not per scheduler tick, not per HTTP request), the `recovery.`
// lineFilter means the scan JSON.parses only a handful of lines out of the window,
// and peak RESIDENT memory is one 1 MiB chunk regardless of the cap — the cap
// bounds WORK, not memory. It is still a hard ceiling: past it the read stops
// growing with the file and `covered:false` is SURFACED (see collectEventLog's
// return + the sweep banner) rather than swallowed.
export const ESCALATION_TAIL_MAX_BYTES = 256 * 1024 * 1024;

// Returns { items, covered, windowMs, oldestTs, maxBytes }. `covered:false` means
// the byte cap was hit before `windowMs` was spanned, so `items` is an UNDER-count
// — the caller must say so out loud rather than present a short window as the full
// one. `maxBytes` is echoed back so the banner reports the cap that ACTUALLY
// applied rather than re-deriving it (and so a test can pin the default).
export function collectEventLog({
  nowMs = Date.now(),
  windowMs = ESCALATION_LOOKBACK_MS,
  maxBytes = ESCALATION_TAIL_MAX_BYTES,
  logPath = null, // test seam; production resolves the current month's log
  chunkSize = undefined,
  initialWindow = undefined,
} = {}) {
  const items = [];
  const path = logPath ?? eventLogPath();
  if (!existsSync(path)) return { items, covered: true, windowMs, oldestTs: null, maxBytes };
  try {
    const res = scanEventsSince({
      path,
      targetSinceMs: nowMs - windowMs,
      maxBytes,
      ...(chunkSize === undefined ? {} : { chunkSize }),
      ...(initialWindow === undefined ? {} : { initialWindow }),
      lineFilter: (line) => line.includes("recovery."),
      onEvent: (evt) => {
        const name = evt?.attributes?.["event.name"] || "";
        if (!/^recovery\.(escalated|would-escalate)$/.test(name)) return;
        const ticket = evt?.body?.payload?.ticket || evt?.attributes?.["event.label"] || "";
        if (!ticket) return;
        items.push({
          ticket,
          source: "log",
          eventName: name,
          reason: evt?.body?.payload?.reason || "-",
        });
      },
    });
    return {
      items,
      covered: res.covered !== false,
      windowMs,
      oldestTs: res.oldestTs ?? null,
      maxBytes,
    };
  } catch {
    // An I/O failure means source 2 produced nothing AND we learned nothing —
    // report it as uncovered so the banner does not imply a clean 7-day sweep.
    return { items, covered: false, windowMs, oldestTs: null, maxBytes };
  }
}

// formatEscalationCoverage — the loud line for a truncated source-2 window. Null
// when the advertised window was fully covered (the normal case).
export function formatEscalationCoverage({ covered, windowMs, oldestTs, maxBytes }) {
  if (covered) return null;
  const days = (windowMs / (24 * 60 * 60 * 1000)).toFixed(1);
  return (
    `(WARNING: event-log escalation window TRUNCATED — asked for ${days}d, the bounded tail only ` +
    `reached back to ${oldestTs ?? "an unknown point"} (byte cap ${maxBytes ?? ESCALATION_TAIL_MAX_BYTES}B). ` +
    `Source 2 (recovery.escalated / recovery.would-escalate) is INCOMPLETE; older escalations are ` +
    `missing from this sweep.)`
  );
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
  // CTL-1290: the whole-board, read-only snapshot (recovery-pass-brief/v2). Gives
  // the delegate the context the per-item brief never had — slots, queue depth,
  // which OTHER workers are stuck, which nodes are stranded — so it acts on the
  // board, not just this one ticket.
  if (brief.boardContext) {
    console.log("--- board context (whole-board, read-only) ---");
    const bc = brief.boardContext;
    console.log(`slots: ${bc.slots?.inUse}/${bc.slots?.capacity} (${bc.slots?.free} free)`);
    console.log(`eligible queue depth: ${bc.eligibleQueue?.depth ?? 0}`);
    if (bc.stuckWorkers?.length) {
      console.log(
        `stuck workers: ${bc.stuckWorkers.map((w) => `${w.ticket}(${w.phase},${w.ageSeconds}s)`).join(", ")}`,
      );
    }
    if (bc.strandedNodes?.length) {
      console.log(`stranded nodes: ${bc.strandedNodes.map((n) => n.host).join(", ")}`);
    }
    const ghq = bc.githubQuota;
    if (ghq?.state === "low" || ghq?.state === "exhausted") {
      console.log(`GitHub core quota: ${ghq.remaining}/${ghq.limit} remaining; resets ${ghq.resetAt ?? "unknown"}`);
    }
    // CTL-1644 (Codex P1 → P2 round 3): surface the per-ticket classified revival
    // routes so the delegate can enumerate this cohort and distinguish
    // pr-not-merged / resume-from-remote / restart-fresh. The recovery-pass skill
    // treats injected board context as AUTHORITATIVE and acts on every surfaced
    // anomaly — it has no route-aware hold transition — so we must NOT surface a
    // non-dispatchable route (adopt / unknown-salvage) here even when an UNRELATED
    // anomaly anchored the dispatch: doing so would let the worker touch a route
    // the classifier marked unsafe. Held routes are deliberately kept out of the
    // worker's actionable context; they remain observable via the board-scan event
    // (strandedRoutes / strandedHeldCount) for the HUD / monitor / event-log.
    const smp = bc.strandedMidPipeline ?? {};
    const actionable = Object.entries(smp).filter(([, r]) => r?.dispatchable !== false);
    const heldCount = Object.values(smp).filter((r) => r?.dispatchable === false).length;
    if (actionable.length) {
      console.log(
        `stranded mid-pipeline (actionable): ${actionable
          .map(([t, r]) => `${t}→${r?.route ?? "?"}`)
          .join(", ")}`,
      );
    }
    if (heldCount) {
      // Count only — NOT an action directive. Awaiting Phase-3 salvage evidence
      // or an operator; the worker must not act on these.
      console.log(`stranded mid-pipeline (held, do NOT act): ${heldCount}`);
    }
    // CAT-11 (Codex P1 round 1): RUBRIC FOUR's trigger is literally
    // `boardContext.unownedInFlightDetail`, but this renderer emitted slots, queue
    // depth, workers, nodes, quota and stranded routes only — never that field. A
    // router-dispatched delegate following the skill therefore could not see or
    // enumerate the orphaned-branch entries at all, and would have had to guess that
    // it must reopen and parse the JSON brief. Print the actionable entries so the
    // rubric's trigger is satisfiable from the context the delegate is actually given.
    // Only DISPATCHABLE entries are listed, matching the held-route discipline above;
    // held ones are surfaced as a count so they stay observable but not actionable.
    const uid = Array.isArray(bc.unownedInFlightDetail) ? bc.unownedInFlightDetail : [];
    const uidActionable = uid.filter((e) => e?.dispatchable !== false);
    const uidHeld = uid.length - uidActionable.length;
    if (uidActionable.length) {
      console.log(
        `unowned in-flight (orphaned work, RUBRIC FOUR): ${uidActionable
          .map((e) => `${e.ticket}→${e.route ?? "?"}`
            + ` [branch ${e.branchName ?? "?"}, +${e.commitsAhead ?? "?"} commits]`)
          .join(", ")}`,
      );
    }
    if (uidHeld) {
      console.log(`unowned in-flight (held, do NOT act): ${uidHeld}`);
    }
  }
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
    const log = collectEventLog();
    const all = unionDedupe(
      collectWorkerSignals(orchDir),
      log.items,
      (await collectLinearCache()).items
    ).filter((it) => it.ticket === ticket);
    console.log("--- ticket-scoped stuck context ---");
    // CTL-1529 (Codex P2): say it out loud when the advertised lookback was not
    // actually covered — a short window must never masquerade as the full one.
    const truncated = formatEscalationCoverage(log);
    if (truncated) console.log(truncated);
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
  // CTL-1529 (Codex P2): source 2's window is bounded. When the cap truncated it,
  // the sweep is incomplete and MUST say so — the failure this replaces was silent.
  const truncated = formatEscalationCoverage(events);
  if (truncated) console.log(truncated);

  const union = unionDedupe(signals, events.items, cache.items);

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

// Portable entrypoint guard (mirrors linear-reconcile-cli.mjs, CTL-578:
// import.meta.main is undefined on Node <22.16). CTL-1529: this used to run
// main() on plain IMPORT, so the module's helpers could not be unit-tested at all
// without executing a whole sweep as a side effect. Behavior when invoked as a
// script is unchanged.
// CTL-1529 (Codex P1): compare REAL paths, not the raw pair. Plugins are surfaced
// through `.claude/` symlinks, and the two sides resolve differently:
// `fileURLToPath(import.meta.url)` yields the symlink TARGET while `process.argv[1]`
// keeps the symlink path the user typed. On Node <22.16 (`import.meta.main`
// undefined) the equality was therefore false whenever this ran through the
// installed symlink — the documented `node "${EXEC_CORE}/recovery-pass-context.mjs"`
// invocation exited 0 having printed NOTHING: no MODE banner, no stuck context. A
// silent no-op is the worst shape here, because the recovery-pass skill treats the
// empty output as "no stuck work" rather than as a failure to look.
const realOrSelf = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p; // unreadable/missing → fall back to the literal path
  }
};
const isEntrypoint =
  import.meta.main === true ||
  (!!process.argv[1] &&
    realOrSelf(fileURLToPath(import.meta.url)) === realOrSelf(process.argv[1]));
if (isEntrypoint) {
  main().catch((err) => {
    // Never crash the context gather — print a degraded banner and exit 0 so the
    // skill still proceeds (it can reconstruct from logs/gh directly).
    console.log("MODE=sweep");
    console.log(`(context-gather error: ${err?.message || err}; proceed manually)`);
    console.log("TOTAL: 0 items (0 yours, 0 context)");
  });
}
