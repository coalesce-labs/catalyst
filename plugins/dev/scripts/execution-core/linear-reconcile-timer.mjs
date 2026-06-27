// linear-reconcile-timer.mjs — CTL-1371 in-daemon completion-declaration drain.
// Pattern-twin of orphan-pr-sweep-timer.mjs: injectable seams, fake-clock tests,
// {stop} handle, unref'd interval, per-tick try/catch.
//
// Each tick drains PENDING completion declarations (the lightweight "this is done"
// signals the model/pipeline/human dropped, via linear-reconcile-store) and makes
// Linear reflect them through the canonical linear-write.mjs primitive — retrying
// any write that previously failed (rate-limit / daemon down / breaker). Linear is
// NEVER moved by inferring from PR/merge state. Runs on the daemon event loop,
// fully SEPARATE from schedulerTick (cannot trip the CTL-671 runaway guards).
//
// Mode (catalyst.orchestration.reconcile.mode):
//   'off'    → timer never starts (also the default when the key is absent).
//   'notify' → compute + emit drift events + persist a summary; NEVER writes.
//   'write'  → additionally write the declared state via the primitive.

import { readFileSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { log, getEventLogPath } from "./config.mjs";
import { DEFAULTS, reconcileDeclarations, orderedStatesForMap } from "./linear-reconcile.mjs";
import { listDeclarations, markReconciled } from "./linear-reconcile-store.mjs";
import { applyTerminalDone, applyPhaseStatus } from "./linear-write.mjs";

// readLinearReconcileConfig — catalyst.orchestration.reconcile.* from a config
// file. Returns {} for missing/unreadable/absent key.
export function readLinearReconcileConfig(configPath) {
  if (!configPath) return {};
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return parsed?.catalyst?.orchestration?.reconcile ?? {};
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { configPath, err: err.message },
        "linear-reconcile: config unreadable; using defaults"
      );
    }
    return {};
  }
}

function readFullCatalystConfig(configPath) {
  if (!configPath) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) ?? {};
  } catch {
    return {};
  }
}

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
    now: () => Date.now(),
  };
}

// defaultReadStateFactory — current Linear state from the webhook-synced cache
// (~/catalyst/filter-state.db). Zero network, no rate limit. Null on miss.
function defaultReadStateFactory() {
  let opened = false;
  return async (ticket) => {
    try {
      if (!opened) {
        openBrokerStateDb();
        opened = true;
      }
      return getTicketDescriptor(ticket)?.state ?? null;
    } catch {
      return null;
    }
  };
}
// Lazy bun:sqlite imports (daemon runs under bun, like scheduler.mjs).
let openBrokerStateDb = null;
let getTicketDescriptor = null;
async function ensureCacheReader() {
  if (openBrokerStateDb) return;
  const mod = await import("../broker/broker-state.mjs");
  openBrokerStateDb = mod.openBrokerStateDb;
  getTicketDescriptor = mod.getTicketDescriptor;
}

// makeApplyCorrection — build the write seam from the two linear-write primitives
// (injectable so a test can assert routing). 'done' → applyTerminalDone (exempt
// from the backward guard); any other key → applyPhaseStatus (guarded).
export function makeApplyCorrection({ applyTerminalDone: done, applyPhaseStatus: phase } = {}) {
  const toDone = done ?? applyTerminalDone;
  const toPhase = phase ?? applyPhaseStatus;
  return ({ ticket, kind }) =>
    kind === "done"
      ? toDone({ ticket })
      : toPhase({ ticket, phase: kind === "inReview" ? "pr" : kind });
}

const defaultApplyCorrection = makeApplyCorrection();

// defaultEmit — append a bare event envelope (best-effort). Suffix is a
// non-terminal-status word so it never matches PHASE_EVENT_PATTERN (CTL-1142).
function defaultEmit(name, payload) {
  try {
    appendFileSync(
      getEventLogPath(),
      JSON.stringify({ name, ...payload, ts: new Date().toISOString() }) + "\n"
    );
  } catch {
    /* best-effort */
  }
}

// defaultPersist — atomic write of the last-run summary to ${orchDir}/linear-reconcile.json.
function defaultPersist(orchDir, state) {
  const final = join(orchDir, "linear-reconcile.json");
  const tmp = join(orchDir, `linear-reconcile.json.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, final);
}

// runReconcileDrain — one tick. All seams injected; exported for tests.
export async function runReconcileDrain({
  stateMap,
  terminalStates,
  mode,
  listPending,
  readState,
  applyCorrection,
  markReconciledFn,
  persist,
  emit,
  nowMs,
}) {
  const dryRun = mode !== "write";
  const pending = listPending();
  if (!pending.length) {
    persist({ ts: new Date(nowMs).toISOString(), mode, summary: { tickets: 0 }, rows: [] });
    return { summary: { tickets: 0 }, rows: [] };
  }

  const { rows, summary } = await reconcileDeclarations({
    declarations: pending,
    stateMap,
    terminalStates,
    orderedStates: orderedStatesForMap(stateMap),
    readState,
    applyCorrection,
    dryRun,
  });

  for (const r of rows) {
    // A declaration is RECONCILED once Linear reflects the declared state —
    // whether we just wrote it (correct+applied) or it was already there
    // (in-sync). Both clear it from pending; the in-sync clear is pure local
    // bookkeeping (no Linear write), safe even in notify mode.
    const satisfied = r.decision === "in-sync" || (r.decision === "correct" && r.applied);
    if (satisfied) markReconciledFn(r.ticket, r.to_state ?? r.target ?? r.currentState);
    if (r.decision !== "correct") continue;
    if (
      !dryRun &&
      r.applied &&
      (r.writeAction === "transitioned" ||
        (r.from_state && r.to_state && r.from_state !== r.to_state))
    ) {
      emit(`ticket.completion.reconciled.${r.ticket}`, {
        ticket: r.ticket,
        kind: r.kind,
        from: r.from_state ?? r.currentState,
        to: r.to_state ?? r.target,
      });
    } else if (dryRun && r.currentState != null) {
      emit(`ticket.completion.drift.${r.ticket}`, {
        ticket: r.ticket,
        kind: r.kind,
        from: r.currentState,
        to: r.target,
      });
    }
  }

  const actionable = rows.filter((r) => r.decision === "correct" || r.error);
  persist({ ts: new Date(nowMs).toISOString(), mode, summary, rows: actionable });
  return { summary, rows };
}

/**
 * startLinearReconcileTimer — start the periodic declaration-drain timer.
 * Returns a { stop } handle. No-op when disabled / mode 'off'.
 */
export function startLinearReconcileTimer({
  enabled = true,
  mode = "notify",
  intervalSeconds = DEFAULTS.intervalSeconds,
  orchDir,
  configPath,
  config = {},
  // injectable seams
  listPending,
  readState,
  applyCorrection = defaultApplyCorrection,
  markReconciledFn = (t, s, dir) => markReconciled(t, s, { dir }),
  persist: persistFn = (od, s) => defaultPersist(od, s),
  emit = defaultEmit,
  readFullConfig = readFullCatalystConfig,
  clock = realClock(),
} = {}) {
  if (!enabled || mode === "off" || !orchDir) return { stop: () => {} };

  const ms = Math.max(1, intervalSeconds) * 1_000;
  const declsDir = config.declarationsDir;

  const handle = clock.setInterval(async () => {
    try {
      const full = readFullConfig(configPath);
      const stateMap = full?.catalyst?.linear?.stateMap ?? {};
      const terminalStates = [
        ...new Set(
          [stateMap.done, stateMap.canceled, "Done", "Canceled", "Duplicate"].filter(Boolean)
        ),
      ];
      let read = readState;
      if (!read) {
        await ensureCacheReader();
        read = defaultReadStateFactory();
      }
      await runReconcileDrain({
        stateMap,
        terminalStates,
        mode,
        listPending: listPending ?? (() => listDeclarations({ dir: declsDir, pendingOnly: true })),
        readState: read,
        applyCorrection,
        markReconciledFn: (t, s) => markReconciledFn(t, s, declsDir),
        persist: (s) => persistFn(orchDir, s),
        emit,
        nowMs: clock.now(),
      });
    } catch (err) {
      log.warn({ err }, "linear-reconcile: tick error");
    }
  }, ms);

  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle) };
}
