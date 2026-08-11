// stale-pr-rescue-timer.mjs — CTL-782 periodic orphaned-PR rescue.
// Pattern-twin of worktree-refresh-timer.mjs: injectable seams, fake-clock
// tests, {stop} handle, unref'd interval, per-tick try/catch.
//
// On each tick the timer walks workers/*/phase-{pr,monitor-merge}.json to
// find tickets with an open PR but no live worker, then calls decideRescue
// and executes the action (wait → stamp; dispatch → rebase worker; escalate
// → labelOnce + event). Bookkeeping lives in workers/<T>/rescue.json;
// phase-*.json files are NEVER written by this timer.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jobLifecycle } from "./recovery.mjs";
import { routeStuckTicketToDelegate } from "./delegate-first.mjs"; // CTL-1609
import { appendDelegateEvent as defaultAppendDelegateEvent } from "./delegate-event.mjs"; // CTL-1774
import { fenceGuard } from "./fence-guard.mjs";
import {
  appendFenceStandoffEvent,
  clearFenceStandoff,
  evaluateStandoff,
  markBreakGlass,
  recordFenceSuppression,
  resolveStandoffCap,
  resolveStandoffMinAgeMs,
} from "./fence-standoff.mjs";
import { recordDurableEscalation } from "./durable-escalation.mjs";
import { appendFileSync } from "node:fs";
// CTL-1785: `tickMultiHost` below is a TOPOLOGY fact that arms the fence
// zombie-guard — the fenceGuard `!multiHost` disarm must stay EXISTENCE-derived so
// entitlement shedding can never re-enable an N=1 disarm (CTL-1781 defect class).
// `off` mode: getExistenceHosts() === getClusterHosts().
import { log, getEventLogPath, getExistenceHosts, readStewardEscalationConfig } from "./config.mjs";
import { buildCanonicalEventLine } from "./lib/canonical-event.mjs"; // CTL-1817
import { DEFAULTS, classifyMergeTree, decideRescue } from "./stale-pr-rescue.mjs";
// CTL-2000: the escalation-ladder chokepoint. resolveStewardCore returns null
// today (free-text scopes) and lights up when CTL-1974 populates scopeKeys —
// wired here so no call-site edit is needed then. listRoles/readManifest are
// node:*-only leaves (agent-liveness/state/paths), safe under bun.
import { nextEscalationTarget, resolveSteward as resolveStewardCore, TARGET } from "./escalation-router.mjs";
import { listRoles } from "../role-supervisor/doctor.mjs";
import { readManifest } from "../role-supervisor/state.mjs";
// Default Linear transport for the escalation path. The daemon does not thread
// a writer (scheduler.mjs threads its own), so without this default every
// escalation reason would silently degrade to a log line and the ticket would
// never reach the needs-human queue (verify finding, CTL-782).
import * as linearWriteDefault from "./linear-write.mjs";
import { YIELDED_STATUS, classifyYield } from "../lib/phase-yield.mjs"; // CTL-1854

// defaultLinearWrite — exported so tests can assert the module-level default
// is the real linear-write transport (not null).
export const defaultLinearWrite = linearWriteDefault;

const ORCHESTRATE_REBASE_BIN = fileURLToPath(new URL("../orchestrate-rebase", import.meta.url));
// Templates live at plugins/dev/templates/ (orchestrate-rebase resolves them as
// PLUGIN_ROOT/templates), which from execution-core/ is TWO levels up. `../templates/`
// pointed at scripts/templates/ — a directory that has never existed — so every rescue
// dispatch died in awk. Masked by the CTL-1612 401 outage until 2026-08-02 (CTL-1620).
const RESCUE_PROMPT_TEMPLATE = fileURLToPath(
  new URL("../../templates/rescue-rebase-prompt.md", import.meta.url)
);

// readStalePrRescueConfig — read catalyst.orchestration.stalePrRescue.*
// from .catalyst/config.json. Returns {} for missing/unreadable/absent key.
export function readStalePrRescueConfig(configPath) {
  if (!configPath) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn(
        { configPath, err: err.message },
        "stale-pr-rescue: config unreadable; using defaults"
      );
    }
    return {};
  }
  return parsed?.catalyst?.orchestration?.stalePrRescue ?? {};
}

function realClock() {
  return {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    now: () => Date.now(),
  };
}

// parseRepoSlug — extract "org/repo" from a GitHub PR URL.
// "https://github.com/org/repo/pull/N" → "org/repo"
function parseRepoSlug(url) {
  if (!url) return null;
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\/|\.git|$)/.exec(url);
  return m ? m[1].replace(/\.git$/, "") : null;
}

// readTicketPr — extract PR info from workers/<T>/ signal files.
// Prefers phase-pr.json .pr.url for the slug (monitorMergeProbe precedent).
// Also captures the signal's `.orchestrator` field — in execution-core the
// per-ticket orchestrator id (orchId === ticket convention; scheduler.mjs
// stamps it on every dispatch) — so dispatchRescue can pass a non-empty
// --orch to orchestrate-rebase (verify finding, CTL-782).
// Returns { number, url, slug, worktreePath, orchestrator } or null if no PR info.
function readTicketPr(orchDir, ticket) {
  const dir = join(orchDir, "workers", ticket);
  let prInfo = null;
  let worktreePath = null;
  let orchestrator = null;

  for (const fname of ["phase-pr.json", "phase-monitor-merge.json"]) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, fname), "utf8"));
      if (raw?.pr?.number && !prInfo) prInfo = raw.pr;
      if (raw?.worktreePath && !worktreePath) worktreePath = raw.worktreePath;
      if (raw?.orchestrator && !orchestrator) orchestrator = raw.orchestrator;
    } catch {
      /* absent or unreadable */
    }
  }

  if (!prInfo?.number) return null;
  return {
    number: prInfo.number,
    url: prInfo.url,
    slug: parseRepoSlug(prInfo.url),
    worktreePath,
    orchestrator,
  };
}

// anyPhaseJobAlive — true if any phase-*.json in the ticket dir has a
// non-terminal bg_job_id that jobLifecycle() declares alive.
function anyPhaseJobAlive(orchDir, ticket, jobLifecycleFn) {
  const dir = join(orchDir, "workers", ticket);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }

  for (const name of names) {
    if (!name.startsWith("phase-") || !name.endsWith(".json")) continue;
    if (name.includes("-yield-")) continue;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf8"));
      // ⚠️ CTL-1854: a LIVE yield owns the worktree even though its worker has
      // exited — that exit is the whole point of the state, so the bg_job_id
      // probe below necessarily says "not alive" and the rescue would treat the
      // ticket as orphaned. Dispatching orchestrate-rebase then runs a rebase in a
      // worktree whose background work is still operating, and the default rescue
      // cadence fires well inside the 30-minute yield window. The SIGNAL is the
      // ownership record here, not the job table. An EXPIRED yield deliberately
      // does NOT own it: the tick rewrites it to `failed` within a tick, and the
      // rescue should proceed for a genuinely abandoned ticket.
      if (String(raw?.status) === YIELDED_STATUS && !classifyYield(raw).expired) return true;
      if (raw?.bg_job_id && jobLifecycleFn(raw.bg_job_id) === "alive") return true;
    } catch {
      // ⚠️ FAIL CLOSED on an unreadable/malformed phase file. Skipping treats it as
      // "no owner", and because a yielding worker has intentionally exited, NO
      // background-job probe can recover that ownership later — so a transiently
      // torn signal would let the rescue rebase a worktree whose background work is
      // still running. Claiming ownership on doubt costs a delayed rescue; the
      // other direction costs a second writer in a live worktree.
      return true;
    }
  }
  return false;
}

// readRescueState — read workers/<T>/rescue.json.
// Returns {} when the file is absent (ENOENT — first sighting), but null when
// the file exists and is corrupt/torn (parse error). Conflating the two would
// silently reset rescueAttempts to 0 on a torn read — a budget bypass that
// re-dispatches past maxAttempts (verify finding, CTL-782). Callers must skip
// the ticket this tick on null.
function readRescueState(orchDir, ticket) {
  const path = join(orchDir, "workers", ticket, "rescue.json");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return {};
  } // ENOENT (or unreadable): treat as no prior state
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.warn(
      { ticket, path, err: err.message },
      "stale-pr-rescue: rescue.json corrupt/torn — skipping ticket this tick"
    );
    return null;
  }
}

// writeRescueState — atomic write to workers/<T>/rescue.json via
// writeFileSync(tmp) + renameSync(tmp, final). rename(2) is atomic on POSIX,
// so the concurrent rescue worker (which rewrites the same file) can never
// observe a torn write from this timer.
function writeRescueState(orchDir, ticket, state) {
  const dir = join(orchDir, "workers", ticket);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `rescue.json.tmp.${process.pid}`);
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, join(dir, "rescue.json"));
}

// defaultPrView — call gh REST to get PR state, mergeStateStatus, and refs.
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
      "state,mergeStateStatus,baseRefName,headRefName",
    ],
    { encoding: "utf8", timeout: 15_000 }
  );
  if (res.status !== 0) throw new Error(res.stderr || "gh pr view failed");
  return JSON.parse(res.stdout);
}

// defaultCompareBehind — gh REST compare to count commits behind.
// Throws on non-zero gh exit (consistent with defaultPrView; the per-ticket
// catch logs it and retries next tick) — a transient gh failure must not
// masquerade as "not behind" and silently suppress a legitimate rescue.
async function defaultCompareBehind(slug, base, head) {
  const res = spawnSync(
    "gh",
    ["api", `repos/${slug}/compare/${base}...${head}`, "--jq", ".behind_by"],
    { encoding: "utf8", timeout: 15_000 }
  );
  if (res.status !== 0) {
    throw new Error(res.stderr || `gh api compare failed (exit ${res.status})`);
  }
  const behind = parseInt(res.stdout.trim(), 10);
  if (Number.isNaN(behind)) {
    log.warn(
      { slug, base, head, stdout: res.stdout },
      "stale-pr-rescue: unparsable behind_by — treating as 0"
    );
    return 0;
  }
  return behind;
}

// defaultMergeTree — fetch origin/<base> + origin/<head> then run
// `git merge-tree --write-tree origin/<base> origin/<head>` in the worktree.
// base/head are BRANCH NAMES (the call site passes view.baseRefName /
// view.headRefName) — comparing origin/<base> against the fetched PR head is
// the whole point; the pre-fix code compared origin/<base> against itself,
// which is always clean (verify finding, CTL-782). The fetch lives inside
// this seam (not at the call site) so tests that inject mergeTree never spawn
// git, and the fetch failure path is owned here: a failed fetch throws (the
// per-ticket catch logs + retries next tick) instead of silently classifying
// against a stale origin/<base>.
// Exported for the real-git integration test.
export async function defaultMergeTree(worktreePath, base, head) {
  const fetchRes = spawnSync("git", ["-C", worktreePath, "fetch", "origin", base, head], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (fetchRes.status !== 0) {
    throw new Error(
      `git fetch origin ${base} ${head} failed (exit ${fetchRes.status}): ${fetchRes.stderr ?? ""}`
    );
  }
  const res = spawnSync(
    "git",
    ["-C", worktreePath, "merge-tree", "--write-tree", `origin/${base}`, `origin/${head}`],
    { encoding: "utf8", timeout: 30_000 }
  );
  return { exitCode: res.status ?? 128, output: res.stdout ?? "" };
}

// defaultWorktreeExists — check if the worktree dir is present.
function defaultWorktreeExists(worktreePath) {
  return !!worktreePath && existsSync(worktreePath);
}

// buildRescueDispatchArgs — pure argv builder for the orchestrate-rebase
// dispatch. Exported so a unit test can assert the arg vector carries a
// non-empty --orch (orchestrate-rebase hard-exits on an empty one) without
// spawning anything (verify finding, CTL-782).
export function buildRescueDispatchArgs(
  ticket,
  { prNumber, orchId, orchDir, worktreePath, base, signalFile, headRef }
) {
  const args = [
    ORCHESTRATE_REBASE_BIN,
    ticket,
    "--pr",
    String(prNumber),
    "--orch",
    orchId,
    "--orch-dir",
    orchDir,
    "--worker-dir",
    worktreePath,
    "--base-branch",
    base,
    "--signal-file",
    signalFile,
    "--prompt-template",
    RESCUE_PROMPT_TEMPLATE,
  ];
  // PR head branch: execution-core branches are just <TICKET>, while
  // orchestrate-rebase's legacy default is <orch>-<TICKET> — without this
  // override every rendered fetch/checkout/force-push targets a branch that
  // does not exist (review finding, CTL-782).
  if (headRef) args.push("--branch", headRef);
  args.push("--dispatch");
  return args;
}

// defaultDispatchRescue — invoke orchestrate-rebase --dispatch with rescue flags.
// Returns { ok } so the call site can refuse to burn a rescueAttempt on a
// dispatch that never spawned (verify finding, CTL-782). Guards the empty
// orchId here too: orchestrate-rebase exits 1 on `--orch ""`, so spawning
// would be a guaranteed-failing dispatch.
function defaultDispatchRescue(ticket, opts) {
  if (!opts.orchId) {
    log.warn({ ticket }, "stale-pr-rescue: refusing dispatch with empty orchId");
    return { ok: false, error: "empty_orch_id" };
  }
  const res = spawnSync("bash", buildRescueDispatchArgs(ticket, opts), {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (res.status !== 0) {
    log.warn({ ticket, stderr: res.stderr }, "stale-pr-rescue: dispatch failed");
    return { ok: false, error: res.stderr || `exit ${res.status}` };
  }
  return { ok: true };
}

// defaultEscalate — apply needs-human label once + emit event.
// linearWrite defaults to the real linear-write module at the
// startStalePrRescueTimer boundary; a null here means a caller explicitly
// opted out, which leaves the ticket invisible to humans — say so loudly.
//
// CTL-1609 (Codex P1) — RETURNS a verified outcome so the caller can decide
// whether the escalation is durable enough to latch `rescue.json.escalatedAt`:
//   { confirmed, routed, reason }
// `confirmed: true` ONLY when a needs-human label actually landed. A delegate
// route is a HANDOFF, not a confirmed human escalation — the delegate can still
// fail, and `escalatedAt` permanently skips the ticket in decideRescue, so
// latching on a route would silently strand the PR. Fence-suppressed and
// no-transport paths return confirmed:false too.
// CTL-2000: the default (production) steward resolver. Wired to the router's
// pure resolveSteward with role-supervisor's registry reads, so it returns null
// TODAY (no manifest declares scopeKeys) and activates the steward tier the
// moment CTL-1974 populates them — without touching this call site.
export function defaultResolveSteward(scope) {
  try {
    return resolveStewardCore(scope, { listRoles, readManifest });
  } catch {
    return null;
  }
}

// CTL-2000: page the resolved ladder rung on the shared channel (never a human).
// Honors `target` (from nextEscalationTarget): a STEWARD route is delivered TO
// the resolved steward, not to the concierge — otherwise the emitted event and
// return value claim `routed-to-steward` while the message silently goes to the
// concierge, skipping the mandated steward rung (Codex P2). Falls back to the
// concierge when there is no steward (today's only reachable case until CTL-1974
// populates `scopeKeys`). Fail-open — a failed post must not turn into a silent
// drop; best-effort spawn, short timeout; the returned bool is advisory.
export function defaultPostConciergePage({ ticket, detail, target, env = process.env } = {}) {
  try {
    const channel = env?.CATALYST_CONCIERGE_CHANNEL || "concierge";
    const toSteward = target?.target === TARGET.STEWARD && target?.steward?.role ? String(target.steward.role) : null;
    const to = toSteward ?? env?.CATALYST_CONCIERGE_ID ?? "concierge";
    const rung = toSteward ? `steward (${to})` : "the steward";
    const comms = fileURLToPath(new URL("../catalyst-comms", import.meta.url));
    const body =
      `instrument/stale-pr-rescue: ${ticket} could not be rescued (${detail?.reason ?? "unresolvable conflict"}` +
      `${detail?.prNumber ? `, PR #${detail.prNumber}` : ""}) — ${toSteward ? "your scope" : `page ${rung}`} / decide ask-vs-relaunch.`;
    const res = spawnSync(comms, ["send", channel, body, "--as", "stale-pr-rescue", "--to", to, "--type", "attention"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

export function defaultEscalate(
  ticket,
  detail,
  {
    orchDir,
    linearWrite,
    multiHost = false,
    gateway = undefined,
    self = undefined,
    env = process.env,
    maxParallel = undefined,
    appendDelegateEvent = defaultAppendDelegateEvent,
    // CTL-2000: the escalation-ladder seam. shadow (default) preserves today's
    // exact behavior and only LOGS a would-route-steward event; enforce routes
    // through the router (concierge today; steward when CTL-1974 lands) INSTEAD
    // of applying needs-human. off is byte-identical to shadow minus the log.
    resolveSteward = defaultResolveSteward,
    postConciergePage = defaultPostConciergePage,
    now = () => Date.now(),
    fenceGuardFn = fenceGuard,
    appendStandoffEvent = appendFenceStandoffEvent,
  } = {}
) {
  const stewardMode = readStewardEscalationConfig(env).mode; // off | shadow | enforce (default shadow)

  // ── enforce: route through the ladder INSTEAD of applying needs-human ──────
  // A concierge page is a HANDOFF, not a confirmed human escalation, so
  // confirmed stays false (escalatedAt must NOT latch on it — same rule the
  // delegate-route path already honors). The fence-guard is preserved: a
  // superseded ticket must not page anyone.
  if (stewardMode === "enforce") {
    if (
      !fenceGuard(
        { ticket, orchDir, multiHost, gateway, self },
        { proceedOnMissingGeneration: true }
      )
    ) {
      log.warn({ ticket }, "ctl-863: stale fence — suppressing stale-pr-rescue steward-route (zombie guard)");
      return { confirmed: false, routed: false, reason: "fence-suppressed", escalatedTo: null };
    }
    const rs = typeof resolveSteward === "function" ? resolveSteward : () => null;
    const t = nextEscalationTarget({ scope: ticket, priorPages: 0, instrument: "stale-pr-rescue", resolveSteward: rs });
    const posted = postConciergePage({ ticket, detail, target: t, env });
    // Observable page event on the unified log (queryable by ticket). The `type`
    // discriminator names the ladder rung; the registered delegate.routed name
    // keeps it a valid, non-broker-protected line.
    appendDelegateEvent({
      name: "delegate.routed",
      type: `phase.rescue.routed-to-${t.target}`,
      ticket,
      site: "stale-pr-rescue-steward",
      reason: detail?.reason ?? "unresolvable-conflict",
      orchId: ticket,
    });
    log.warn({ ticket, target: t.target, posted, ...detail }, `stale-pr-rescue: routed to ${t.target} (steward-escalation enforce) — no needs-human label`);
    return { confirmed: false, routed: false, reason: `routed-to-${t.target}`, escalatedTo: t.target };
  }

  // ── shadow (default): log would-route-steward, then TODAY'S EXACT PATH ──────
  if (stewardMode === "shadow") {
    appendDelegateEvent({
      name: "delegate.would-route",
      type: "phase.rescue.would-route-steward",
      ticket,
      site: "stale-pr-rescue-steward",
      reason: detail?.reason ?? "unresolvable-conflict",
      orchId: ticket,
    });
  }

  let routed = false;
  let labelled = false;
  let outcomeReason = "no-transport";
  if (linearWrite) {
    // This is an ESCALATION write (needs-human), so it fails OPEN on a MISSING
    // generation (proceedOnMissingGeneration): a zombie-guard that can't read a
    // generation must LOUDLY proceed with the label rather than silently drop a
    // human escalation. A genuine supersession (readable generation, fresh
    // foreign owner / authoritative read says not-current) still suppresses.
    let fenceVerdict = null;
    if (fenceGuardFn(
      { ticket, orchDir, multiHost, gateway, self },
      {
        proceedOnMissingGeneration: true,
        onSuppress: (verdict) => { fenceVerdict = verdict; },
      },
    )) {
      clearFenceStandoff(orchDir, ticket);
      const r = routeStuckTicketToDelegate(orchDir, ticket, {
        site: "stale-pr-rescue",
        reason: detail?.reason ?? "unresolvable-conflict",
        boardContext: { prNumber: detail?.prNumber },
        applyLabel: linearWrite,
        env,
        log,
        appendEvent: (evt) => appendDelegateEvent({ ...evt, orchId: ticket }), // CTL-1774
        explanation: {
          problem: `stale PR for ${ticket} could not be rescued: ${detail?.reason ?? "unresolvable conflict"}`,
          call_to_action: `resolve the PR conflict for ${ticket} or close the PR`,
        },
        // CTL-1609 (Codex P1): supply the configured ceiling so the enqueue can
        // reach `queue-full` → human instead of resolving to Infinity. Injected
        // from the daemon (which already owns concurrency) rather than importing
        // the scheduler here, which would pull its bun:sqlite graph into this timer.
        deps: { orchDir, ...(maxParallel === undefined ? {} : { maxParallel }) },
      });
      routed = r.routed === true;
      labelled = r.labelled === true;
      outcomeReason = r.reason ?? (labelled ? "labelled" : "not-labelled");
    } else {
      outcomeReason = "fence-suppressed";
      log.warn(
        { ticket, reason: fenceVerdict?.reason ?? null },
        "ctl-863: stale fence — suppressing stale-pr-rescue labelOnce write (zombie guard)"
      );
      try {
        const nowMs = now();
        const rec = recordFenceSuppression({
          orchDir,
          ticket,
          site: "stale-pr-rescue",
          reason: fenceVerdict?.reason ?? "unknown",
          now: nowMs,
        });
        const verdict = evaluateStandoff(rec, {
          now: nowMs,
          cap: resolveStandoffCap(env),
          minAgeMs: resolveStandoffMinAgeMs(env),
        });
        if (verdict.firstBreakGlass) {
          markBreakGlass({ orchDir, ticket, now: nowMs });
          recordDurableEscalation({
            orchDir,
            ticket,
            phase: "pr",
            reason:
              `fence-standoff (${rec.reason}): stale PR #${detail?.prNumber ?? "?"} for ${ticket} ` +
              "needs human attention, but the fence suppressed the Linear label write.",
            labelConfirmed: false,
            source: "fence-standoff",
            now: new Date(nowMs).toISOString(),
          });
          appendStandoffEvent({
            ticket,
            site: "stale-pr-rescue",
            reason: rec.reason,
            count: rec.count,
            ageMs: verdict.ageMs,
          });
          log.warn(
            { ticket, prNumber: detail?.prNumber, reason: rec.reason, count: rec.count, ageMs: verdict.ageMs },
            "cat-173: FENCE STANDOFF — wrote a durable stale-PR escalation without a Linear label",
          );
        }
      } catch (err) {
        log.warn({ ticket, err: err?.message }, "cat-173: stale-pr-rescue standoff bookkeeping failed — continuing");
      }
    }
  } else {
    log.warn(
      { ticket },
      "stale-pr-rescue: no linearWrite transport — needs-human label NOT applied (log-only escalation)"
    );
  }
  log.warn({ ticket, ...detail }, "stale-pr-rescue: escalating to needs-human");
  return { confirmed: labelled, routed, reason: outcomeReason };
}

// recordEscalationOutcome — CTL-1609 (Codex P1): the verified-or-loud latch.
//
// `rescue.json.escalatedAt` is a PERMANENT skip — decideRescue returns
// `already_escalated` for every later tick once it is set. Writing it
// optimistically (before the escalation is confirmed) is therefore the difference
// between "a human was told" and "this PR is silently stuck forever".
//
// Only a CONFIRMED needs-human label counts. A delegate route does not: the
// runner can still fail the intent, and nothing downstream clears escalatedAt or
// re-applies the label, so latching there reintroduces exactly the silent-drop
// this guard exists to prevent. Unconfirmed outcomes leave the state retryable
// (next tick re-evaluates) AND emit a loud event so the gap is observable rather
// than invisible.
//
// Returns true when the escalation was latched (caller should emit the normal
// `phase.rescue.escalated.<ticket>` event), false when it stayed retryable.
function recordEscalationOutcome(orchDir, ticket, rescueState, outcome, nowMs, emit, reason) {
  // Only a seam that actually speaks the outcome contract can withhold the latch.
  // A custom `escalate` injection predating it returns undefined — or something
  // incidental like `array.push(...)`'s new length — and must keep the prior
  // latch-always behavior rather than silently retrying forever. In production
  // `escalate` defaults to defaultEscalate, which always returns the contract, so
  // the strict path is the one that actually runs.
  const hasContract = outcome != null && typeof outcome === "object" && "confirmed" in outcome;
  const confirmed = !hasContract || outcome.confirmed === true;
  if (confirmed) {
    writeRescueState(orchDir, ticket, {
      ...rescueState,
      escalatedAt: new Date(nowMs).toISOString(),
      escalateReason: reason,
    });
    return true;
  }
  writeRescueState(orchDir, ticket, {
    ...rescueState,
    lastEscalationAttemptAt: new Date(nowMs).toISOString(),
    lastEscalationFailure: outcome.reason ?? "unconfirmed",
  });
  log.error(
    { ticket, reason, outcome: outcome.reason ?? "unconfirmed", routed: outcome.routed === true },
    "stale-pr-rescue: escalation NOT confirmed — leaving retryable (escalatedAt withheld)"
  );
  emit(`phase.rescue.escalation-unconfirmed.${ticket}`, {
    ticket,
    reason,
    outcome: outcome.reason ?? "unconfirmed",
    routed: outcome.routed === true,
  });
  return false;
}

// defaultEmit — append a CANONICAL event envelope to the event log.
// Best-effort: never throws.
//
// CTL-1817: this used to write a bare `{ name, ...payload, ts }` line — the "v3" shape.
// otel-forward reads `body.message ?? attributes["event.name"]` for the body and
// `attributes` for the attributes, so a v3 line forwarded off-machine with an EMPTY body
// and EMPTY attributes: 531 `phase.rescue.*` escalations in 2026-08 reached Loki as records
// carrying nothing but a timestamp and a severity. The ticket identifier lived only inside
// the event name, and the name was not on the wire either.
//
// The identifier is now promoted to `linear.issue.identifier` (the same attribute
// fence-event.mjs uses) so the escalation is queryable by ticket, and body.message is
// non-empty by construction. Every rescue payload carries `ticket`; the conditional is
// belt-and-braces for a future caller that does not.
// Exported for unit tests (canonical-event.test.mjs) — the emit seam is injected everywhere
// else, so this adapter was previously the one untested line on the path.
export function defaultEmit(name, payload) {
  try {
    appendFileSync(
      getEventLogPath(),
      buildCanonicalEventLine({
        name,
        payload,
        attributes: payload?.ticket ? { "linear.issue.identifier": payload.ticket } : {},
      }),
    );
  } catch {
    /* best-effort */
  }
}

/**
 * startStalePrRescueTimer — start the periodic stale/conflicting-PR rescue timer.
 * Returns a { stop } handle.
 */
export function startStalePrRescueTimer({
  enabled = true,
  intervalSeconds = DEFAULTS.intervalSeconds,
  orchDir,
  orchId = "",
  config = {},
  // Real Linear transport by default — the daemon call site passes nothing,
  // and a null default made every escalation a silent no-op (verify finding).
  linearWrite = linearWriteDefault,
  // CTL-863: resolve the cluster-size gate LIVE per tick (below), not once at
  // daemon boot. A boot-time snapshot froze `multiHost=false` for the daemon's
  // whole lifetime when the roster grew 1→2 without an exec-core restart (the
  // config.mjs:590 "honored on the next tick, no restart" contract), leaving the
  // fence zombie-guard permanently disarmed on this timer. `undefined` here means
  // "not injected" → resolve fresh each tick; a test may still pass an explicit
  // boolean to pin it. Matches the per-tick `getClusterHosts()` in scheduler/monitor.
  multiHost = undefined,
  // CTL-1609 (Codex P1): the configured delegate ceiling, threaded to
  // enqueueDelegateIntent so `queue-full` → human stays reachable instead of
  // resolving to Infinity. A number or a () => number. Injected by the daemon
  // (which already owns concurrency); importing readMaxParallel here would pull
  // scheduler.mjs's bun:sqlite graph into this timer. undefined → prior behavior.
  maxParallel = undefined,
  // injectable seams
  jobLifecycle: jobLifecycleFn = jobLifecycle,
  prView = defaultPrView,
  compareBehind = defaultCompareBehind,
  mergeTree = defaultMergeTree,
  worktreeExists = defaultWorktreeExists,
  dispatchRescue = defaultDispatchRescue,
  escalate = defaultEscalate,
  emit = defaultEmit,
  clock = realClock(),
} = {}) {
  if (!enabled || !orchDir) return { stop: () => {} };

  const ms = Math.max(1, intervalSeconds) * 1_000;
  const cfg = {
    stableSeconds: config.stableSeconds ?? DEFAULTS.stableSeconds,
    behindThreshold: config.behindThreshold ?? DEFAULTS.behindThreshold,
    maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
    maxConflictFiles: config.maxConflictFiles ?? DEFAULTS.maxConflictFiles,
  };

  const handle = clock.setInterval(async () => {
    try {
      // CTL-863: live per-tick cluster-size gate. Re-read the roster each tick so
      // a 1→2 roster growth arms the fence zombie-guard on the very next tick with
      // no daemon restart. An explicitly-injected `multiHost` (tests) is honored.
      const tickMultiHost = multiHost === undefined ? getExistenceHosts().length > 1 : multiHost;
      await runTick({
        orchDir,
        orchId,
        cfg,
        linearWrite,
        multiHost: tickMultiHost,
        jobLifecycleFn,
        prView,
        compareBehind,
        mergeTree,
        worktreeExists,
        dispatchRescue,
        escalate,
        emit,
        nowMs: clock.now(),
      });
    } catch (err) {
      log.warn({ err }, "stale-pr-rescue: tick error");
    }
  }, ms);

  if (typeof handle?.unref === "function") handle.unref();
  return { stop: () => clock.clearInterval(handle) };
}

async function runTick({
  orchDir,
  orchId,
  cfg,
  linearWrite,
  multiHost,
  maxParallel,
  jobLifecycleFn,
  prView,
  compareBehind,
  mergeTree,
  worktreeExists,
  dispatchRescue,
  escalate,
  emit,
  nowMs,
}) {
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
      await processTicket({
        ticket,
        orchDir,
        orchId,
        cfg,
        linearWrite,
        multiHost,
        maxParallel,
        nowMs,
        jobLifecycleFn,
        prView,
        compareBehind,
        mergeTree,
        worktreeExists,
        dispatchRescue,
        escalate,
        emit,
      });
    } catch (err) {
      log.warn({ ticket, err: err.message }, "stale-pr-rescue: per-ticket error, continuing");
    }
  }
}

async function processTicket({
  ticket,
  orchDir,
  orchId,
  cfg,
  linearWrite,
  multiHost,
  maxParallel,
  nowMs,
  jobLifecycleFn,
  prView,
  compareBehind,
  mergeTree,
  worktreeExists,
  dispatchRescue,
  escalate,
  emit,
}) {
  // 1. Cheap skip: no PR info → nothing to rescue.
  const prInfo = readTicketPr(orchDir, ticket);
  if (!prInfo) return;

  // 2. Cheap skip: any phase job alive → don't interfere.
  if (anyPhaseJobAlive(orchDir, ticket, jobLifecycleFn)) return;

  const rescueState = readRescueState(orchDir, ticket);
  // Corrupt/torn rescue.json (null sentinel): skip the ticket this tick rather
  // than treating it as empty state — that would reset rescueAttempts and
  // bypass the budget gate. readRescueState already logged the warn.
  if (rescueState === null) return;

  // Per-ticket orchestrator id for dispatch/escalate context. In
  // execution-core orchId === ticket (the scheduler stamps `.orchestrator`
  // on every phase signal); the timer-level orchId param and finally the
  // ticket itself are fallbacks — never empty, because orchestrate-rebase
  // hard-exits on `--orch ""` (verify finding, CTL-782).
  const effectiveOrchId = prInfo.orchestrator || orchId || ticket;

  const { slug } = prInfo;

  // 3. Check if rescue worker itself previously stalled. Re-check the PR
  //    state first when possible: a stalled rescue whose PR has since
  //    merged/closed externally needs no human (verify finding). If the
  //    re-check itself fails (gh down), escalate anyway — fail-safe.
  if (rescueState.status === "rescue-stalled") {
    if (slug) {
      let externalState = null;
      try {
        externalState = (await prView(slug, prInfo.number))?.state ?? null;
      } catch {
        /* re-check unavailable — fall through to escalate */
      }
      if (externalState === "MERGED" || externalState === "CLOSED") {
        log.info(
          { ticket, prState: externalState },
          "stale-pr-rescue: stalled rescue's PR resolved externally — not escalating"
        );
        writeRescueState(orchDir, ticket, {
          ...rescueState,
          status: "rescue-stalled-resolved",
          stalledResolvedAt: new Date(nowMs).toISOString(),
        });
        return;
      }
    }
    const stalledOutcome = escalate(
      ticket,
      { reason: "rescue_worker_stalled", ...rescueState },
      { orchDir, orchId: effectiveOrchId, linearWrite, multiHost, maxParallel, now: () => nowMs }
    );
    // CTL-1609 (Codex P1): latch escalatedAt ONLY on a confirmed label write.
    // decideRescue skips forever once escalatedAt exists, so latching on an
    // unconfirmed escalation (delegate route that may still fail, fence
    // suppression, missing transport) would leave the PR neither retried nor
    // surfaced. Unconfirmed → stay retryable AND say so loudly.
    if (
      recordEscalationOutcome(
        orchDir,
        ticket,
        rescueState,
        stalledOutcome,
        nowMs,
        emit,
        "rescue_worker_stalled"
      )
    ) {
      emit(`phase.rescue.escalated.${ticket}`, { ticket, reason: "rescue_worker_stalled" });
    }
    return;
  }

  // 4. Fetch PR view (may throw — caught by per-ticket wrapper).
  if (!slug) return;
  const view = await prView(slug, prInfo.number);

  // BEHIND/DIRTY work below needs the PR head ref. defaultPrView always
  // populates it; a missing one means we cannot compare or classify —
  // substituting the base ref would compare base...base (always clean /
  // 0 behind) and silently suppress the rescue (verify finding). Skip the
  // tick loudly instead.
  const needsHead = view.mergeStateStatus === "BEHIND" || view.mergeStateStatus === "DIRTY";
  if (needsHead && !view.headRefName) {
    log.warn(
      { ticket, mergeStateStatus: view.mergeStateStatus },
      "stale-pr-rescue: PR view missing headRefName — skipping ticket this tick"
    );
    return;
  }

  // 5. Get behindBy if BEHIND.
  let behindBy = 0;
  if (view.mergeStateStatus === "BEHIND") {
    behindBy = await compareBehind(slug, view.baseRefName, view.headRefName);
  }

  // 6. Run merge-tree classification only for stable DIRTY. The seam fetches
  //    origin/<base> + origin/<head> itself and compares base against the PR
  //    HEAD — the pre-fix call site passed origin/<base> as the head, a self-
  //    compare that classified every conflict as resolvable (verify finding).
  let classification = null;
  if (view.mergeStateStatus === "DIRTY" && rescueState.firstSeenAt) {
    const seenMs = new Date(rescueState.firstSeenAt).getTime();
    const elapsedMs = nowMs - seenMs;
    if (elapsedMs >= cfg.stableSeconds * 1_000) {
      const wt = prInfo.worktreePath;
      if (wt && worktreeExists(wt)) {
        const mt = await mergeTree(wt, view.baseRefName ?? "main", view.headRefName);
        classification = classifyMergeTree(mt, { maxConflictFiles: cfg.maxConflictFiles });
      }
    }
  }

  // 7. Decide what to do.
  const decision = decideRescue({
    ticket,
    pr: { number: prInfo.number, url: prInfo.url },
    prState: view.state,
    mergeStateStatus: view.mergeStateStatus,
    behindBy,
    anyJobAlive: false, // already checked above
    worktreeExists: worktreeExists(prInfo.worktreePath),
    rescueState,
    nowMs,
    config: cfg,
    classification,
  });

  // 8. Execute the decision.
  switch (decision.action) {
    case "skip":
      return;

    case "wait": {
      if (decision.detail?.stampFirstSeen) {
        writeRescueState(orchDir, ticket, {
          ...rescueState,
          firstSeenAt: new Date(nowMs).toISOString(),
        });
      }
      return;
    }

    case "dispatch": {
      const signalFile = join(orchDir, "workers", ticket, "rescue.json");
      // Dispatch FIRST, count after: a failed spawn must not burn the
      // single-attempt budget on a rescue that never ran (verify finding,
      // CTL-782). Seam contract: undefined (test stubs / legacy fakes) is
      // success; only an explicit { ok: false } is a failed dispatch.
      const result = await dispatchRescue(ticket, {
        prNumber: prInfo.number,
        orchId: effectiveOrchId,
        orchDir,
        worktreePath: prInfo.worktreePath,
        base: view.baseRefName ?? "main",
        signalFile,
        // The PR's real head branch — execution-core branches are <TICKET>,
        // not orchestrate-rebase's legacy <orch>-<TICKET> default (review
        // finding, CTL-782).
        headRef: view.headRefName,
      });
      if (result?.ok === false) {
        writeRescueState(orchDir, ticket, {
          ...rescueState,
          lastDispatchAt: new Date(nowMs).toISOString(),
          lastDispatchError: result.error ?? "dispatch failed",
        });
        emit(`phase.rescue.dispatch-failed.${ticket}`, {
          ticket,
          error: result.error ?? "dispatch failed",
        });
        return;
      }
      const newAttempts = (rescueState.rescueAttempts ?? 0) + 1;
      writeRescueState(orchDir, ticket, {
        ...rescueState,
        rescueAttempts: newAttempts,
        lastDispatchAt: new Date(nowMs).toISOString(),
        lastDispatchError: undefined,
      });
      emit(`phase.rescue.dispatched.${ticket}`, { ticket, attempt: newAttempts });
      return;
    }

    case "escalate": {
      const outcome = escalate(ticket, decision.detail ?? {}, {
        orchDir,
        orchId: effectiveOrchId,
        linearWrite,
        multiHost,
        maxParallel,
        now: () => nowMs,
      });
      // CTL-1609 (Codex P1): see recordEscalationOutcome — escalatedAt is a
      // permanent skip in decideRescue, so it is written only when the needs-human
      // label is confirmed applied.
      if (
        recordEscalationOutcome(orchDir, ticket, rescueState, outcome, nowMs, emit, decision.reason)
      ) {
        emit(`phase.rescue.escalated.${ticket}`, { ticket, reason: decision.reason });
      }
      return;
    }
  }
}
