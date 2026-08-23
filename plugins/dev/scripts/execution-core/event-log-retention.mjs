// event-log-retention.mjs — CTL-2189. Prune the unified event log on a STATED
// policy, so a constrained host stops counting down to a full disk.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PROPERTY THAT MATTERS: THE WINDOW IS DERIVED, NOT DECLARED
// ─────────────────────────────────────────────────────────────────────────────
// Several readers are TIME-addressed over this log (they must prove N hours of
// coverage). Deleting a partition one of them still reads converts a reader that
// currently THROWS ("cannot prove the window") into one that answers WRONG —
// strictly worse, because the throw is visible and the wrong answer is not.
//
// The obvious implementation — pick a retention window, and separately trust
// that no reader needs more — is the shape this repo has already paid for three
// times (CTL-2180, CTL-2182, CTL-2193): two numbers in two files, related only
// by an assumption nobody asserts. So the window here is COMPUTED from the
// readers' own stated requirements:
//
//     retention window = max(coverage requirements) + RETENTION_MARGIN_MS
//
// and each requirement is sourced from the live constant the reader itself uses,
// never re-typed. A reader that starts needing a longer history therefore raises
// the retention window with it — automatically, at import time — instead of
// silently reading a truncated log. `assertRequirementsResolvable` turns the
// remaining failure mode (a requirement nobody stated) into a loud throw.
//
// ⛔ THE DISK-PRESSURE PATH MAY NOT OVERRIDE THIS. See planRetention: under
// pressure the job reclaims only already-outside-window partitions and otherwise
// reports that it cannot help. A retention job that gets MORE aggressive exactly
// when the host is least healthy is precisely how the failure above happens.

import { HEARTBEAT_TAIL_WINDOW_MS } from "./config.mjs";

const DAY_MS = 24 * 60 * 60_000;

// ─── Coverage requirements ───────────────────────────────────────────────────
//
// Every entry is attributed to the reader that HOLDS the requirement, so the
// registry reads as a list of obligations rather than a list of numbers. `ms`
// must come from the reader's own live constant wherever one exists — a re-typed
// literal is exactly the drift this module exists to prevent.
//
// To add a reader: add an entry. If you cannot state its number, add it with
// `ms: null` — assertRequirementsResolvable will then refuse to compute a window
// at all, which is the correct outcome. An unstated requirement must never be
// silently treated as zero.
export const COVERAGE_REQUIREMENTS = Object.freeze([
  Object.freeze({
    reader: "execution-core/recovery.mjs (bounded heartbeat tail)",
    ticket: "CTL-1529",
    ms: HEARTBEAT_TAIL_WINDOW_MS,
    why:
      "Must span the present-but-stale band or a host that stopped heartbeating " +
      "hours ago collapses from 'seen, but stale' (⇒ reclaimable) to 'absent' " +
      "(⇒ work strands forever). Derived from HEARTBEAT_GRACE_MS, so an operator " +
      "raising the grace raises this with it.",
  }),
  Object.freeze({
    reader: "orch-monitor/lib/cluster-governance.mjs",
    ticket: "CTL-1529",
    ms: HEARTBEAT_TAIL_WINDOW_MS,
    why:
      "Mirrors execution-core's heartbeat tail window so the two governance " +
      "readers agree; it is the same obligation seen from the monitor side.",
  }),
  Object.freeze({
    reader: "orch-monitor/lib/fleet-alerts.mjs",
    ticket: "CTL-2178 AC5",
    ms: 31 * DAY_MS,
    why:
      "Alert state is RECONSTRUCTED by folding the log, so a raise must stay " +
      "readable for as long as the alert can stay up. The month partition is the " +
      "horizon the fold already assumes (getEventLogPath is current-month-only), " +
      "so 31 days is the requirement it is written against — not a guess. If " +
      "CTL-2178 gives this reader an explicit window constant, import it here.",
  }),
]);

// RETENTION_MARGIN_MS — the ONLY tunable number in this file, and it lives
// beside the thing it protects.
//
// It buys two things the requirements above do not: (1) a reader whose window is
// stated in wall-clock still needs its OLDEST partition to be whole, not
// truncated at the cutoff instant, and (2) a host that is down over a rollover
// must not come back to find the partition it was mid-read of already gone.
// 7 days is one full weekly partition — the coarsest unit the layout can delete,
// so anything smaller cannot change what is removed anyway.
export const RETENTION_MARGIN_MS = 7 * DAY_MS;

// assertRequirementsResolvable — every requirement must state a finite, positive
// number of milliseconds. A `null` (reader registered, window not yet stated)
// throws rather than being skipped: skipping it would silently compute a window
// as if that reader needed nothing.
export function assertRequirementsResolvable(requirements = COVERAGE_REQUIREMENTS) {
  const unresolved = requirements.filter((r) => !Number.isFinite(r?.ms) || r.ms <= 0);
  if (unresolved.length > 0) {
    const names = unresolved.map((r) => r?.reader ?? "<unnamed>").join(", ");
    throw new Error(
      `ctl-2189: coverage requirement not stated for: ${names}. ` +
        "Retention cannot be computed until every registered reader states the window it needs."
    );
  }
  return true;
}

// maxCoverageRequirementMs — the binding obligation across all readers.
export function maxCoverageRequirementMs(requirements = COVERAGE_REQUIREMENTS) {
  assertRequirementsResolvable(requirements);
  return requirements.reduce((max, r) => (r.ms > max ? r.ms : max), 0);
}

// retentionWindowMs — the derived policy. Nothing else in this file, and nothing
// outside it, may pick a retention window by hand.
export function retentionWindowMs({
  requirements = COVERAGE_REQUIREMENTS,
  marginMs = RETENTION_MARGIN_MS,
} = {}) {
  if (!Number.isFinite(marginMs) || marginMs < 0) {
    throw new Error(`ctl-2189: retention margin must be a non-negative number, got ${marginMs}`);
  }
  return maxCoverageRequirementMs(requirements) + marginMs;
}

// DEFAULT_MIN_FREE_BYTES — the headroom below which a host is reported as under
// pressure. 20 GiB, sized for the CONSTRAINED host (mini-2: 228 GiB volume, 18
// GiB free when CTL-2189 was filed), not the roomy one — a threshold comfortable
// on a 926 GiB disk tells the host that is actually running out nothing.
export const DEFAULT_MIN_FREE_BYTES = 20 * 1024 * 1024 * 1024;

// ─── Partition layout ────────────────────────────────────────────────────────
//
// Two shapes exist on live hosts today, plus a `.legacy` suffix left by an older
// migration:
//
//   2026-08.jsonl         monthly  (getEventLogPath, both hosts)
//   2026-W34.jsonl        weekly   (CTL-1216, partially landed — mini-2 only)
//   2026-05.jsonl.legacy  either shape, retired in place
//
// ⛔ Anything else makes the whole run REFUSE (see planRetention). Deletion is
// irreversible, so an unexpected layout must stop the job rather than be
// guessed at — a file this parser does not understand may well be the one file
// somebody cannot afford to lose.
// ⛔ THE ROTATION SUFFIXES ARE DERIVED FROM THE WRITERS, NOT FROM A DIRECTORY.
// Codex found the first version of this parser refusing names that live writers
// actually emit — which, because an unrecognized file refuses the WHOLE run,
// meant the job deleted nothing on any host that had ever rotated a legacy
// month. The fix is to read the two emitters and encode what they produce, not
// to widen a pattern until today's directory happens to pass:
//
//   lib/canonical-event.sh:784-785
//     ${month_file}.legacy.${stamp}.$$          stamp = date -u +%Y%m%dT%H%M%SZ
//     ${month_file}.legacy.${stamp}.$$.${n}     n = 1..50 collision counter
//
//   orch-monitor/lib/event-writer.ts:197
//     ${filePath}.legacy.${stamp}               stamp = toISOString() with [:.] → "-"
//     ${filePath}.legacy.${stamp}.${n}          n = 1..50 collision counter
//
//   plus the historical fixed `.legacy` (still on disk: 2026-05.jsonl.legacy).
//
// A rotated file holds the DATA OF ITS PARTITION, so it inherits that
// partition's time bounds — `2026-05.jsonl.legacy.…` is May data and ages out
// with May. That is why the suffix is stripped rather than making a new kind.
const BASH_ROTATION_STAMP = String.raw`\d{8}T\d{6}Z`;
const TS_ROTATION_STAMP = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z`;
// `{0,2}` covers both shapes at once: bash appends pid (+ optional n), the TS
// writer appends only an optional n.
const ROTATION_SUFFIX_RE = new RegExp(
  String.raw`^\.legacy(?:\.(?:${BASH_ROTATION_STAMP}|${TS_ROTATION_STAMP})(?:\.\d+){0,2})?$`
);

const PARTITION_EXT = ".jsonl";
const MONTH_BASE_RE = /^(\d{4})-(\d{2})$/;
const WEEK_BASE_RE = /^(\d{4})-W(\d{2})$/;

// isoWeekStartMs — the UTC midnight that begins ISO week `week` of `year`.
// ISO-8601: the week containing Jan 4 is week 1, and weeks start on Monday.
function isoWeekStartMs(year, week) {
  const jan4 = Date.UTC(year, 0, 4);
  // getUTCDay() is Sunday-0; ISO wants Monday-0.
  const isoDow = (new Date(jan4).getUTCDay() + 6) % 7;
  const week1Monday = jan4 - isoDow * DAY_MS;
  return week1Monday + (week - 1) * 7 * DAY_MS;
}

// parsePartition — name → {kind, startMs, endMs, legacy} or null when the name
// is not a partition this module understands.
//
// `endMs` is the EXCLUSIVE upper bound: the first instant that can no longer
// appear in the file. Retention compares against `endMs` (not `startMs`) because
// what matters is the NEWEST record a partition can hold — a partition whose end
// is still inside the window holds data a reader may still need, however old its
// first record is.
export function parsePartition(name) {
  const extAt = name.indexOf(PARTITION_EXT);
  if (extAt < 0) return null;
  const base = name.slice(0, extAt);
  const suffix = name.slice(extAt + PARTITION_EXT.length);
  // An empty suffix is the live partition; anything else must be a rotation
  // name one of the writers above can actually produce. `.gz`, `.bak`, a
  // hand-made archive — none of those parse, and they still refuse the run.
  if (suffix !== "" && !ROTATION_SUFFIX_RE.test(suffix)) return null;
  const rotated = suffix !== "";

  const month = MONTH_BASE_RE.exec(base);
  if (month) {
    const year = Number(month[1]);
    const mon = Number(month[2]);
    if (mon < 1 || mon > 12) return null;
    return {
      kind: "month",
      name,
      rotated,
      startMs: Date.UTC(year, mon - 1, 1),
      endMs: Date.UTC(year, mon, 1), // first instant of the next month
    };
  }

  const week = WEEK_BASE_RE.exec(base);
  if (week) {
    const year = Number(week[1]);
    const wk = Number(week[2]);
    if (wk < 1 || wk > 53) return null;
    const startMs = isoWeekStartMs(year, wk);
    return { kind: "week", name, rotated, startMs, endMs: startMs + 7 * DAY_MS };
  }

  return null;
}

// ─── The plan ────────────────────────────────────────────────────────────────

// planRetention — pure. Decides what WOULD be removed; removes nothing.
//
// Inputs:
//   names        — directory listing (file names only)
//   nowMs        — clock
//   windowMs     — derived; defaults to retentionWindowMs()
//   freeBytes    — current free space on the volume, or null when unknown
//   minFreeBytes — the headroom below which the host is under pressure
//
// Returns { cutoffMs, windowMs, remove[], keep[], refused, pressure, cannotHelp }.
//
// `refused` is a REASON string, never a boolean and never collapsed into an
// empty plan: a refusing run and a run with nothing to do must be
// distinguishable by the operator reading the report.
export function planRetention({
  names,
  nowMs = Date.now(),
  windowMs = undefined,
  freeBytes = null,
  minFreeBytes = DEFAULT_MIN_FREE_BYTES,
  isFile = () => true,
} = {}) {
  const effectiveWindowMs = windowMs ?? retentionWindowMs();
  const cutoffMs = nowMs - effectiveWindowMs;

  const unrecognized = [];
  const ignored = [];
  const parsed = [];
  for (const name of names) {
    // ⛔ NOT-A-CANDIDATE vs UNRECOGNIZED — measured against the real directory,
    // where the first dry run refused on `~/catalyst/events/.catalyst` (a state
    // DIRECTORY, not a partition) and would have made the job permanently inert.
    // A subdirectory or a dotfile is not a partition and never will be, so it is
    // IGNORED and reported. Only a plain, non-dot regular file that fails to
    // parse means the layout changed under us, and that still refuses.
    if (name.startsWith(".") || !isFile(name)) {
      ignored.push(name);
      continue;
    }
    const p = parsePartition(name);
    if (p === null) unrecognized.push(name);
    else parsed.push(p);
  }

  const pressure = Number.isFinite(freeBytes) && freeBytes < minFreeBytes;

  if (unrecognized.length > 0) {
    return {
      cutoffMs,
      windowMs: effectiveWindowMs,
      remove: [],
      keep: parsed,
      ignored,
      pressure,
      cannotHelp: pressure,
      refused:
        `unrecognized file(s) in the event-log directory: ${unrecognized.join(", ")}. ` +
        "Refusing the whole run — deletion is irreversible and an unexpected layout may " +
        "mean the partition scheme changed under this job.",
    };
  }

  // ⛔ AC3. A partition survives when ANY part of it lies at or after the cutoff.
  // Note `>` on endMs, not `>=` on startMs: endMs is exclusive, so a partition
  // ending exactly AT the cutoff holds nothing a reader still needs.
  const remove = parsed.filter((p) => p.endMs <= cutoffMs);
  const keep = parsed.filter((p) => p.endMs > cutoffMs);

  return {
    cutoffMs,
    windowMs: effectiveWindowMs,
    remove,
    keep,
    ignored,
    pressure,
    // ⛔ Under pressure with nothing outside the window, the honest answer is
    // "retention cannot help" — NOT "delete something anyway". This is the branch
    // that keeps a wedging host from being traded for silently wrong readers.
    cannotHelp: pressure && remove.length === 0,
    refused: null,
  };
}

// ─── The job ─────────────────────────────────────────────────────────────────

// runRetention — plan, then apply. All I/O is injected so the tests drive the
// real decision path rather than a re-implementation of it.
//
// `apply: false` (the default) is a dry run: it returns exactly the plan the
// applying run would act on, and deletes nothing. Deletion is irreversible, so
// the safe mode is the one you get by forgetting to pass anything.
//
// Reports ONCE per run, never once per tick (AC2): the caller gets a single
// result object naming what was removed and how much was reclaimed, and a
// refusing or cannot-help run says so in that same object.
export function runRetention({
  dir,
  nowMs = Date.now(),
  windowMs = undefined,
  freeBytes = null,
  minFreeBytes = DEFAULT_MIN_FREE_BYTES,
  apply = false,
  readdir,
  sizeOf,
  unlink,
  isFile = () => true,
} = {}) {
  const names = readdir(dir);
  const plan = planRetention({ names, nowMs, windowMs, freeBytes, minFreeBytes, isFile });

  if (plan.refused) {
    return { ...plan, applied: false, removed: [], reclaimedBytes: 0 };
  }

  const removed = [];
  let reclaimedBytes = 0;
  for (const p of plan.remove) {
    // Size BEFORE unlink — a reclaimed-bytes number read after the delete is a
    // number about nothing.
    let bytes = 0;
    try {
      bytes = sizeOf(dir, p.name) ?? 0;
    } catch {
      bytes = 0;
    }
    if (apply) {
      unlink(dir, p.name);
      removed.push(p.name);
      reclaimedBytes += bytes;
    } else {
      removed.push(p.name);
      reclaimedBytes += bytes;
    }
  }

  return { ...plan, applied: apply, removed, reclaimedBytes };
}

// ─── The production binding ──────────────────────────────────────────────────
//
// ⛔ WHY THIS FACTORY EXISTS AT ALL. The first version of this module exported a
// correct, thoroughly tested `runRetention` that NOTHING CALLED. It was present,
// green, and inert — a control that reports success while doing nothing, which
// is the exact defect class this file was written to relieve. Two independent
// reasons for nothing to happen compounded it: no call site, AND `apply: false`
// by default.
//
// So the real filesystem wiring and the `apply: true` decision live HERE, in one
// exported factory, rather than being spelled out at the daemon call site where
// they cannot be tested. daemon.mjs binds this onto the orphan-reaper's existing
// 600 s cadence (no new timer), exactly as the job-dir and worker-dir GCs are
// bound. `event-log-retention-wiring.test.mjs` asserts BOTH halves: that the
// daemon binds it, and that the bound sweep actually unlinks.
import { readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";

// createEventLogRetentionSweep — returns the async seam daemon.mjs schedules.
//
// `apply` defaults to TRUE here, and that is deliberate: this factory IS the
// production path, so a caller that forgets the flag gets the behaviour the
// ticket asks for rather than a silent no-op. The dry run stays available and
// stays the default on the lower-level `runRetention`, where forgetting it is a
// mistake rather than the point.
export function createEventLogRetentionSweep({
  eventsDir,
  apply = true,
  minFreeBytes = DEFAULT_MIN_FREE_BYTES,
  freeBytesOf = null,
  log = null,
  fs = { readdirSync, statSync, unlinkSync, existsSync },
} = {}) {
  return async function eventLogRetentionSweep() {
    if (!eventsDir || !fs.existsSync(eventsDir)) return null;
    let result;
    try {
      result = runRetention({
        dir: eventsDir,
        apply,
        minFreeBytes,
        freeBytes: typeof freeBytesOf === "function" ? freeBytesOf(eventsDir) : null,
        readdir: (d) => fs.readdirSync(d),
        sizeOf: (d, n) => fs.statSync(join(d, n)).size,
        unlink: (d, n) => fs.unlinkSync(join(d, n)),
        isFile: (n) => {
          try {
            return fs.statSync(join(eventsDir, n)).isFile();
          } catch {
            return false;
          }
        },
      });
    } catch (err) {
      // Best-effort, like every other sweep on this cadence: retention must
      // never take the reaper tick down with it.
      log?.error?.({ err: err?.message ?? String(err) }, "ctl-2189: event-log retention failed");
      return null;
    }

    // ONE report per run, not one per tick (AC2). A refusal and a cannot-help
    // are reported at warn because both mean the disk problem is NOT being
    // relieved; a normal run is info and says what it reclaimed.
    if (result.refused) {
      log?.warn?.({ reason: result.refused }, "ctl-2189: event-log retention refused");
    } else if (result.cannotHelp) {
      log?.warn?.(
        { freeBytes: result.pressure, keep: result.keep.length },
        "ctl-2189: host under disk pressure but every partition is inside a reader's coverage window — retention cannot help"
      );
    } else if (result.removed.length > 0) {
      log?.info?.(
        {
          removed: result.removed,
          reclaimedBytes: result.reclaimedBytes,
          cutoff: new Date(result.cutoffMs).toISOString(),
        },
        apply
          ? "ctl-2189: event-log retention removed expired partitions"
          : "ctl-2189: event-log retention DRY RUN — these partitions would be removed"
      );
    }
    return result;
  };
}
