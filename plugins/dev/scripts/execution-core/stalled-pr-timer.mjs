// stalled-pr-timer.mjs — CTL-1608 periodic stalled-PR detection sweep.
// Pattern-twin of stale-pr-rescue-timer.mjs: injectable seams, fake-clock
// tests, {stop} handle, unref'd interval, per-tick try/catch.
//
// Each tick the timer walks workers/*/ for open-PR tickets (NOT gated on
// anyPhaseJobAlive — the whole point is to see stalls behind a live worker),
// runs a live gh probe, and updates workers/<T>/stalled-pr.json stamps:
//   • CI: isFailingState check → stamp ciFirstFailedAt if unset; else clear.
//     Plus (CTL-2181) a four-valued `ciState` from lib/verified-checks.mjs's
//     classifyCheckRollup — passing/pending/failing/none/unknown. The boolean
//     above cannot express "no CI run at all", which reads identically to green.
//   • Review: reviewDecision=REVIEW_REQUIRED → stamp reviewRequestedAt if unset; else clear.
//   • No-push: headRefOid change → re-stamp lastPushAt. On FIRST sight the anchor
//     comes from the earliest check `startedAt` when one is usable (CTL-2181) —
//     initialising to `now` made a PR that had already been quiet for a day read
//     as 0 h old, deferring detection by a whole quiet window. `pushAnchor` says
//     which anchor was used so a reader can decline rather than trust an
//     invented age.
//   • Draft (CTL-2181): `isDraft`, the input the finished-draft classifier needs.
// This timer only WRITES its own state files — never labels, dispatches, or emits.
// `finished-draft-timer.mjs` reads these stamps (CTL-2181); board-health, the
// original actuator named here, was deleted in CTL-2141.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { isFailingState } from "./pr-block-probe.mjs";
import { classifyCheckRollup } from "../lib/verified-checks.mjs";
import { log } from "./config.mjs";

export const DEFAULTS = {
  // 15 min — read-only probe; longer than the rescue timer's 600s since
  // staleness thresholds are in days.
  intervalSeconds: 900,
};

// readStalledPrSweepConfig — read catalyst.orchestration.stalledPrSweep.*
// from .catalyst/config.json. Returns {} for missing/unreadable/absent key.
export function readStalledPrSweepConfig(configPath) {
  if (!configPath) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { configPath, err: err.message },
        "stalled-pr-timer: config unreadable; using defaults"
      );
    }
    return {};
  }
  return parsed?.catalyst?.orchestration?.stalledPrSweep ?? {};
}

// computeStalledStamps — the pure stamp transition. No IO, no Date.now().
// prev: the existing stalled-pr.json entry (or null on first observation).
// view: the gh pr view result (state, statusCheckRollup, reviewDecision, headRefOid, ...).
// nowMs: epoch-ms timestamp injected by the caller.
// Returns the new stalled-pr.json entry.
export function computeStalledStamps(prev, view, nowMs) {
  const nowIso = new Date(nowMs).toISOString();
  const checks = Array.isArray(view.statusCheckRollup) ? view.statusCheckRollup : [];
  const hasFailing = checks.some((c) => isFailingState(c?.conclusion ?? c?.state ?? ""));
  // CTL-2181: the four-valued rollup verdict, alongside (never replacing) the
  // CTL-1608 boolean above — `hasFailing`'s ciFirstFailedAt contract is pinned by
  // a regression test and must not shift.
  const ciState = classifyCheckRollup(view.statusCheckRollup);

  // CI staleness
  let ciFirstFailedAt;
  if (hasFailing) {
    ciFirstFailedAt = prev?.ciFirstFailedAt ?? nowIso; // stamp on first failure, preserve after
  } else {
    ciFirstFailedAt = null; // CI green / no checks → clear
  }

  // Review staleness
  const reviewDecision = view.reviewDecision ?? null;
  const reviewRequested = reviewDecision === "REVIEW_REQUIRED";
  let reviewRequestedAt;
  if (reviewRequested) {
    reviewRequestedAt = prev?.reviewRequestedAt ?? nowIso;
  } else {
    reviewRequestedAt = null; // review arrived / not required → clear
  }

  // Push staleness — track head OID; stamp when it changes
  const headRefOid = view.headRefOid ?? null;
  const prevOid = prev?.lastKnownHeadOid ?? null;
  let lastPushAt;
  let lastKnownHeadOid;
  let pushAnchor;
  if (prev == null) {
    // First observation (CTL-2181). Initialising to `now` — the original CTL-1608
    // behaviour — makes a PR that has ALREADY been quiet for a day read as 0 h
    // old, which defers every detection built on this stamp by a full quiet
    // window. A check run on the head SHA starts within seconds of the push, so
    // its earliest startedAt is a far better anchor, and it is already in the
    // payload so it costs no extra call. Never anchor into the future: a
    // clock-skewed startedAt must not manufacture age. When no usable startedAt
    // exists we still fall back to `now`, but we SAY so via pushAnchor, so a
    // reader can decline rather than trust an invented age.
    const anchorMs = earliestCheckStart(view.statusCheckRollup);
    const usable = anchorMs !== null && anchorMs <= nowMs;
    lastPushAt = usable ? new Date(anchorMs).toISOString() : nowIso;
    pushAnchor = usable ? "check-started-at" : "first-observation";
    lastKnownHeadOid = headRefOid;
  } else if (headRefOid !== prevOid) {
    // OID changed → a push landed. This is the strongest anchor there is: we
    // watched it happen, so the age is measured rather than inferred.
    lastPushAt = nowIso;
    lastKnownHeadOid = headRefOid;
    pushAnchor = "push-observed";
  } else {
    // Same OID → preserve age AND the provenance of the original anchor. A stamp
    // written before CTL-2181 has no pushAnchor; it degrades to the weakest
    // value, which readers treat as unproven.
    lastPushAt = prev.lastPushAt ?? nowIso;
    lastKnownHeadOid = prevOid;
    pushAnchor = prev.pushAnchor ?? "first-observation";
  }

  return {
    ticket: view.ticket ?? prev?.ticket ?? null,
    prNumber: view.prNumber ?? prev?.prNumber ?? null,
    repo: view.repo ?? prev?.repo ?? null,
    state: view.state ?? "OPEN",
    // CTL-2181: `null` when the view never carried the field, so a stamp written
    // from a pre-CTL-2181 view cannot claim the PR is ready for review.
    isDraft: typeof view.isDraft === "boolean" ? view.isDraft : null,
    ciState,
    observedAt: nowIso,
    ciFirstFailedAt,
    reviewRequestedAt,
    lastPushAt,
    pushAnchor,
    lastKnownHeadOid,
  };
}

// earliestCheckStart — the earliest parsable `startedAt` in a check rollup, or
// null. StatusContext entries carry no startedAt (measured on PR #3884: the
// CheckRun entries all have it, the StatusContext ones do not), so absence is
// the normal case rather than an error.
function earliestCheckStart(rollup) {
  let best = null;
  for (const c of Array.isArray(rollup) ? rollup : []) {
    const ms = Date.parse(c?.startedAt ?? "");
    if (Number.isNaN(ms)) continue;
    if (best === null || ms < best) best = ms;
  }
  return best;
}

// readStalledPrState — aggregate workers/*/stalled-pr.json into Map<ticket, entry>.
// Missing dir or corrupt entries are skipped (fail-open, never throw).
export function readStalledPrState(orchDir) {
  const map = new Map();
  let ticketDirs;
  try {
    ticketDirs = readdirSync(join(orchDir, "workers"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return map; // workers/ dir absent → empty Map
  }
  for (const ticket of ticketDirs) {
    const path = join(orchDir, "workers", ticket, "stalled-pr.json");
    let raw;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // file absent → skip
    }
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch (err) {
      log.warn({ ticket, path, err: err.message }, "stalled-pr-timer: stalled-pr.json corrupt — skipping");
      continue;
    }
    map.set(ticket, entry);
  }
  return map;
}

// writeStalledPrState — atomic write via tmp + rename.
function writeStalledPrState(orchDir, ticket, state) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `stalled-pr.json.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, join(dir, "stalled-pr.json"));
}

// defaultPrView — call gh REST to get PR state, statusCheckRollup, reviewDecision, headRefOid.
async function defaultPrView(slug, prNumber) {
  const res = spawnSync(
    "gh",
    [
      "pr",
      "view",
      String(prNumber),
      "--repo",
      slug,
      "--json",
      "number,state,isDraft,statusCheckRollup,reviewDecision,reviewRequests,headRefOid",
    ],
    { encoding: "utf8", timeout: 15_000 }
  );
  if (res.status !== 0) throw new Error(res.stderr || "gh pr view failed");
  return JSON.parse(res.stdout);
}

// parseRepoSlug — extract "org/repo" from a GitHub PR URL.
function parseRepoSlug(url) {
  if (!url) return null;
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\/|\.git|$)/.exec(url);
  return m ? m[1].replace(/\.git$/, "") : null;
}

// readTicketPr — extract PR info from workers/<T>/ signal files.
function readTicketPr(orchDir, ticket) {
  const dir = join(orchDir, "workers", ticket);
  let prInfo = null;
  let repo = null;

  for (const fname of ["phase-pr.json", "phase-monitor-merge.json"]) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, fname), "utf8"));
      if (raw?.pr?.number && !prInfo) {
        prInfo = raw.pr;
        repo = parseRepoSlug(raw.pr?.url);
      }
    } catch {
      /* absent or unreadable */
    }
  }
  if (!prInfo?.number) return null;
  return { number: prInfo.number, url: prInfo.url, repo };
}

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    now: () => Date.now(),
  };
}

// startStalledPrTimer — start the periodic stalled-PR detection sweep.
// Returns a { stop } handle.
// Default posture: enabled only on `enabled === true` (opt-in, unlike the rescue/orphan
// timers which default-on). It makes live gh calls per open PR; enable after shadow validation.
export function startStalledPrTimer({
  enabled = false,
  intervalSeconds = DEFAULTS.intervalSeconds,
  orchDir,
  config = {},
  prView = defaultPrView,
  clock = realClock(),
} = {}) {
  if (!enabled || !orchDir) return { stop: () => {} };

  const ms = Math.max(1, intervalSeconds) * 1_000;

  const handle = clock.setInterval(async () => {
    try {
      await runTick({ orchDir, prView, nowMs: clock.now() });
    } catch (err) {
      log.warn({ err }, "stalled-pr-timer: tick error");
    }
  }, ms);

  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle) };
}

async function runTick({ orchDir, prView, nowMs }) {
  let ticketDirs;
  try {
    ticketDirs = readdirSync(join(orchDir, "workers"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return;
  }

  for (const ticket of ticketDirs) {
    try {
      await processTicket({ ticket, orchDir, prView, nowMs });
    } catch (err) {
      log.warn({ ticket, err: err.message }, "stalled-pr-timer: per-ticket error, continuing");
    }
  }
}

async function processTicket({ ticket, orchDir, prView, nowMs }) {
  const prInfo = readTicketPr(orchDir, ticket);
  if (!prInfo) return; // no PR info → skip

  const { repo } = prInfo;
  if (!repo) return; // no repo slug → can't probe

  const view = await prView(repo, prInfo.number);
  if (!view || String(view.state ?? "").toUpperCase() !== "OPEN") {
    // PR closed/merged → clear the stalled state file if it exists
    try {
      const existing = JSON.parse(readFileSync(join(orchDir, "workers", ticket, "stalled-pr.json"), "utf8"));
      if (existing) {
        writeStalledPrState(orchDir, ticket, { ...existing, state: view?.state ?? "CLOSED", observedAt: new Date(nowMs).toISOString() });
      }
    } catch {
      /* absent → no cleanup needed */
    }
    return;
  }

  // Read previous state for stamp preservation
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(join(orchDir, "workers", ticket, "stalled-pr.json"), "utf8"));
  } catch {
    /* first observation → prev stays null */
  }

  const enrichedView = { ...view, ticket, prNumber: prInfo.number, repo };
  const newState = computeStalledStamps(prev, enrichedView, nowMs);
  writeStalledPrState(orchDir, ticket, newState);
}
