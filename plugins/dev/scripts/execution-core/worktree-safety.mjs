// worktree-safety.mjs — CTL-791. Evidence-gated worktree removal (data-loss
// hardening).
//
// A live incident (2026-06-06) lost an interactive/agent worktree's uncommitted
// work + worktree-local design docs/handoffs because the daemon's removal paths
// treated "no live session right now" OR "Linear=Done" OR "PR=merged" as
// sufficient and ran `git worktree remove --force`. This module is the single
// gate every automated removal must pass: a worktree is removed ONLY with
// positive, fail-closed evidence that it is GitHub-merged + clean (modulo known
// machine-local noise) + has zero live sessions of ANY kind + was
// orchestrator-created — and its worktree-local docs are archived first.
// Anything else is FLAGGED into an out-of-tree queue (never deleted), which the
// scheduler's terminal sweep re-evaluates on later ticks (no leak: once the
// blockers clear, the next tick removes it).
//
// Scope (CTL-791 core): the predicate, the gated remover, the out-of-tree defer
// path, the worktree-path archive, the lsof backstop, and registry-derived
// provenance. The `worktrees safe/archive` CLI verbs, the orphan-sweep.sh gating,
// the periodic deferred-queue drain, and the orch-monitor surface are the
// CTL-792 fast-follow.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  statSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { emitReapIntent } from "./reap-intent.mjs";
import { log } from "./config.mjs";
import { parseWorktreeForBranch } from "./worktree.mjs";
import { listClaudeAgentsResult } from "./claude-agents.mjs";

// MACHINE_LOCAL_NOISE — porcelain entries that are machine-local drift, not real
// work. Every real orchestrator worktree carries at least ` M .catalyst/config.json`
// (create-worktree.sh copies .catalyst, the daemon then mutates it), so a raw
// "porcelain empty" clean-check would defer every tree forever.
export const MACHINE_LOCAL_NOISE = Object.freeze([
  ".catalyst/config.json",
  ".catalyst/.workflow-context.json",
  ".catalyst/.workflow-context.json.bak",
  ".catalyst/worktree-provenance.json",
  ".needs-cleanup",
  ".trunk",
  ".orphaned_at",
]);

const DEFAULT_QUEUE_DIR = join(homedir(), "catalyst", "wt-cleanup-queue");
const DEFAULT_ARCHIVE_DIR = join(homedir(), "catalyst", "archives", "worktree-docs");
const DEFAULT_RUNS_ROOT = join(homedir(), "catalyst", "runs");

// listOrchDirs — the orchestrator run dirs under ~/catalyst/runs. Each holds a
// workers/<ticket>/ dir for every ticket that orchestrator dispatched — the
// registry-derived provenance signal (hasOrchProvenance). Never throws.
export function listOrchDirs(runsRoot = DEFAULT_RUNS_ROOT) {
  try {
    return readdirSync(runsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(runsRoot, d.name));
  } catch {
    return [];
  }
}

function stripTrailingSlash(p) {
  return typeof p === "string" ? p.replace(/\/+$/, "") : p;
}

// cwdUnder — true when `cwd` is the worktree root or nested beneath it. Exact
// path-segment match so /a/CTL-7 never matches /a/CTL-70.
function cwdUnder(cwd, root) {
  if (!cwd || !root) return false;
  const c = stripTrailingSlash(cwd);
  const r = stripTrailingSlash(root);
  return c === r || c.startsWith(r + "/");
}

function sha1(s) {
  return createHash("sha1").update(String(s)).digest("hex");
}

// porcelainPath — extract the path from a `git status --porcelain` line,
// handling the `XY <path>` and rename `XY <old> -> <new>` shapes.
function porcelainPath(line) {
  const body = line.slice(3); // strip the 2 status chars + space
  const arrow = body.lastIndexOf(" -> ");
  return (arrow >= 0 ? body.slice(arrow + 4) : body).replace(/^"|"$/g, "").trim();
}

function matchesNoise(path, noise) {
  return noise.some((n) => path === n || path.startsWith(n + "/") || path.startsWith(n));
}

// cleanPorcelain — the porcelain lines that represent REAL work (anything not in
// the machine-local ignore-set). Empty array ⇒ clean. Operates on untracked
// (`??`) entries too, which `git status -- :(exclude)` cannot.
export function cleanPorcelain(porcelain, noise = MACHINE_LOCAL_NOISE) {
  return (porcelain ?? "")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .filter((l) => !matchesNoise(porcelainPath(l), noise));
}

// lsofCwdUnder — inventory-independent liveness: true when ANY OS process has its
// cwd or an open handle under `path`, even one `claude agents --json` never
// listed (the incident's actual surface — a detached agent/workflow). Fail-closed:
// if the probe itself cannot run, return true (treat as live, refuse removal).
export function lsofCwdUnder(path, { exec = spawnSync } = {}) {
  if (!path) return true;
  const wt = stripTrailingSlash(path);
  try {
    const res = exec("lsof", ["-nP", "+D", wt], { encoding: "utf8", timeout: 10_000 });
    // lsof rc: 0 = matches found (live), 1 = none found (clear). Any other
    // status (binary missing → ENOENT surfaces as res.error) → fail-closed.
    if (res.error) return true;
    if ((res.status ?? 1) === 0 && (res.stdout ?? "").trim().length > 0) return true;
    if ((res.status ?? 1) === 1) return false; // definitively nothing under the tree
    return (res.stdout ?? "").trim().length > 0; // ambiguous → trust any output
  } catch {
    return true; // cannot probe → fail-closed
  }
}

// hasOrchProvenance — true iff the orchestrator created this worktree, evidenced
// by a `workers/<ticket>/` dir under any registered orchDir. Registry-derived
// (NOT a worktree-local marker, which would self-dirty the tree and vanish on
// removal). An unknown/interactive worktree has no such dir ⇒ false ⇒ never
// removed. Never throws.
export function hasOrchProvenance(ticket, { orchDirs = listOrchDirs() } = {}) {
  if (!ticket) return false;
  for (const dir of orchDirs) {
    try {
      if (existsSync(join(dir, "workers", ticket))) return true;
    } catch {
      /* unreadable orchDir → not evidence */
    }
  }
  return false;
}

// isSafeToRemoveWorktree — the PURE gate. `ctx` carries caller-supplied evidence
// (terminal, prMerged, orchProvenance, branch); `deps` carries the resolved live
// state (agentsList/agentsOk, procLive) + git/clock seams. Returns
// { safe, reasons } with ALL failures collected (no short-circuit) so the defer
// marker records the full picture. `safe === true` only when every gate passes.
export function isSafeToRemoveWorktree(worktreePath, ctx = {}, deps = {}) {
  const {
    runGit = (args) =>
      spawnSync("git", ["-C", ctx.repoRoot, ...args], { encoding: "utf8" }),
    agentsList = [],
    agentsOk = false,
    procLive = false,
    noiseGlobs = MACHINE_LOCAL_NOISE,
  } = deps;
  const reasons = [];

  // (a) terminal — required but not sufficient.
  if (ctx.terminal !== true) reasons.push("not-terminal");

  // (b) GitHub-merged (squash-safe: this repo squash-merges, so a local
  // `rev-list origin/main..branch` is NEVER 0 for a merged branch — the merged
  // signal MUST come from the GitHub PR state the caller passes). Plus a
  // committed-unpushed guard for the no-PR case (only when an upstream resolves;
  // absence of an upstream is NOT unpushed evidence).
  if (ctx.prMerged !== true) reasons.push("not-merged");
  try {
    const up = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if ((up.status ?? 1) === 0 && (up.stdout ?? "").trim()) {
      const ahead = runGit(["rev-list", "--count", "@{u}..HEAD"]);
      if ((ahead.status ?? 1) === 0 && Number((ahead.stdout ?? "0").trim()) > 0) {
        reasons.push("unpushed-commits");
      }
    }
  } catch {
    /* upstream probe failed → not treated as unpushed evidence */
  }

  // (c) clean tree, machine-local noise excluded.
  try {
    const st = runGit(["status", "--porcelain"]);
    if ((st.status ?? 1) !== 0) reasons.push("status-unreadable");
    else if (cleanPorcelain(st.stdout ?? "", noiseGlobs).length > 0) reasons.push("dirty-worktree");
  } catch {
    reasons.push("status-unreadable");
  }

  // (d) no live session of ANY kind (interactive/background/idle/active), via the
  // agents snapshot AND the inventory-independent lsof backstop AND a recency
  // proxy. Fail-closed if the agents read could not be trusted.
  if (!agentsOk) {
    reasons.push("agents-stale");
  } else if (agentsList.some((a) => a?.cwd && cwdUnder(a.cwd, worktreePath))) {
    reasons.push("live-session");
  }
  // Inventory-independent backstop: a real process under the tree that
  // `claude agents` never listed (the incident's actual surface).
  if (procLive === true) reasons.push("proc-live");

  // (e) orchestrator provenance — never touch an interactive/unknown worktree.
  if (ctx.orchProvenance !== true) reasons.push("unknown-provenance");

  return { safe: reasons.length === 0, reasons };
}

// deferWorktreeCleanup — the single FLAG path. Emits worktree.cleanup-deferred and
// writes an OUT-OF-TREE marker (so it survives the worktree's own removal and
// never self-dirties the tree). Idempotent. Never throws.
export function deferWorktreeCleanup(
  worktreePath,
  { ticket, branch, reasons } = {},
  { emit = emitReapIntent, queueDir = DEFAULT_QUEUE_DIR } = {},
) {
  const reasonStr = Array.isArray(reasons) ? reasons.join(",") : String(reasons ?? "unspecified");
  try {
    // Fire-and-forget: emitReapIntent does its work synchronously (appendFileSync)
    // but returns a promise; never block the synchronous teardown path on it.
    Promise.resolve(
      emit("worktree.cleanup-deferred", { ticket, worktreePath, branch, reason: reasonStr }),
    ).catch(() => {});
  } catch (err) {
    log.warn({ err: err?.message, worktreePath }, "worktree-safety: defer emit failed");
  }
  try {
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(
      join(queueDir, `${sha1(stripTrailingSlash(worktreePath))}.json`),
      JSON.stringify({
        ts: new Date().toISOString(),
        ticket: ticket ?? null,
        branch: branch ?? null,
        worktreePath,
        reasons: Array.isArray(reasons) ? reasons : [reasonStr],
      }),
    );
  } catch (err) {
    log.warn({ err: err?.message, worktreePath }, "worktree-safety: defer marker write failed");
  }
  log.info({ ticket, worktreePath, reasons }, "worktree: cleanup deferred (flagged, NOT removed)");
  return { removed: false, deferred: true, reasons: Array.isArray(reasons) ? reasons : [reasonStr] };
}

function clearDeferMarker(worktreePath, queueDir) {
  try {
    rmSync(join(queueDir, `${sha1(stripTrailingSlash(worktreePath))}.json`), { force: true });
  } catch {
    /* best-effort */
  }
}

// archiveWorktreeArtifacts — durability net for worktree-local docs/thoughts the
// incident lost (gitignored thoughts/ is invisible to the clean-check, so a
// "clean" tree can still hold unsynced design docs/handoffs). Worktree-path
// based (NOT orchId-based — the incident worktree had no run dir). Fail-closed:
// returns ok only when the thoughts sync AND the loose-doc copy both succeed.
export function archiveWorktreeArtifacts(
  worktreePath,
  { ticket } = {},
  { exec = spawnSync, archiveDir = DEFAULT_ARCHIVE_DIR } = {},
) {
  // (1) sync thoughts/ to the shared store. "nothing to sync" (empty/absent
  // thoughts/) counts as success; a non-empty thoughts/ that fails to sync (or a
  // missing humanlayer) is FAIL-CLOSED.
  const thoughtsDir = join(worktreePath, "thoughts");
  let thoughtsHasContent = false;
  try {
    thoughtsHasContent = existsSync(thoughtsDir) && readdirSync(thoughtsDir).length > 0;
  } catch {
    thoughtsHasContent = false;
  }
  if (thoughtsHasContent) {
    try {
      const res = exec("humanlayer", ["thoughts", "sync"], {
        cwd: worktreePath,
        encoding: "utf8",
        timeout: 120_000,
      });
      if (res.error || (res.status ?? 1) !== 0) {
        return { ok: false, error: `thoughts sync failed: ${res.error?.message ?? res.stderr ?? "rc=" + res.status}` };
      }
    } catch (err) {
      return { ok: false, error: `thoughts sync threw: ${err?.message}` };
    }
  }

  // (2) copy loose worktree-local docs (top-level *.md not under thoughts/) into
  // the archive, content-hash idempotent, post-copy stat-verified.
  const dest = join(archiveDir, ticket || sha1(stripTrailingSlash(worktreePath)));
  try {
    let docs = [];
    try {
      docs = readdirSync(worktreePath).filter((f) => f.toLowerCase().endsWith(".md"));
    } catch {
      docs = [];
    }
    if (docs.length > 0) mkdirSync(dest, { recursive: true });
    for (const f of docs) {
      const src = join(worktreePath, f);
      try {
        if (!statSync(src).isFile()) continue;
      } catch {
        continue;
      }
      let out = join(dest, f);
      if (existsSync(out)) {
        const same = sha1(readFileSafe(src)) === sha1(readFileSafe(out));
        if (!same) out = join(dest, `${basename(f, ".md")}-${Date.now()}.md`);
        else continue; // identical already archived
      }
      copyFileSync(src, out);
      if (!existsSync(out)) return { ok: false, error: `archive copy unverified: ${f}` };
    }
  } catch (err) {
    return { ok: false, error: `loose-doc archive failed: ${err?.message}` };
  }
  return { ok: true };
}

function readFileSafe(p) {
  try {
    return statSync(p).size > 0 ? readFileSync(p) : Buffer.alloc(0);
  } catch {
    return Buffer.alloc(0);
  }
}

// safeTeardownWorktree — the gated remover ALL terminal callers funnel through.
// Resolves path + provenance + live state, runs the predicate, archives, then
// removes (NEVER --force) — or flags. Re-checks liveness immediately before the
// remove to shrink the TOCTOU window. Returns one of:
//   { removed:true } | { removed:true, alreadyAbsent:true }
//   { removed:false, deferred:true, reasons } | { removed:false, error }
export function safeTeardownWorktree(
  { repoRoot, ticket, worktreePath, terminal, prMerged, branch } = {},
  deps = {},
) {
  const {
    runGit = (args) => spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }),
    // Fail-closed by default: a failed `claude agents` read returns ok:false, so
    // the gate refuses removal rather than treating an unreadable fleet as empty.
    agents = () => {
      const r = listClaudeAgentsResult();
      return { list: r.agents, ok: r.ok };
    },
    procLive = (p) => lsofCwdUnder(p),
    archive = archiveWorktreeArtifacts,
    removeWorktree = (p) => spawnSync("git", ["-C", repoRoot, "worktree", "remove", p], { encoding: "utf8" }),
    emit = emitReapIntent,
    queueDir = DEFAULT_QUEUE_DIR,
    orchDirs = listOrchDirs(),
    noiseGlobs = MACHINE_LOCAL_NOISE,
  } = deps;

  // 1. Resolve the worktree path (from the caller, or by branch refs/heads/<ticket>).
  let path = worktreePath ? stripTrailingSlash(worktreePath) : null;
  if (!path && ticket) {
    const list = runGit(["worktree", "list", "--porcelain"]);
    if ((list.status ?? 1) === 0) path = parseWorktreeForBranch(list.stdout ?? "", ticket);
  }
  if (!path) return { removed: true, alreadyAbsent: true };

  // 2. Resolve live state once for the predicate.
  let agentsList = [];
  let agentsOk = false;
  try {
    const a = agents();
    if (a && Array.isArray(a.list)) {
      agentsList = a.list;
      agentsOk = a.ok === true;
    } else if (Array.isArray(a)) {
      agentsList = a;
      agentsOk = true;
    }
  } catch {
    agentsOk = false;
  }
  const ctx = {
    ticket,
    repoRoot,
    branch,
    terminal: terminal === true,
    prMerged: prMerged === true,
    orchProvenance: hasOrchProvenance(ticket, { orchDirs }),
  };
  const verdict = isSafeToRemoveWorktree(path, ctx, {
    runGit,
    agentsList,
    agentsOk,
    procLive: procLive(path) === true,
    noiseGlobs,
  });
  if (!verdict.safe) {
    return deferWorktreeCleanup(path, { ticket, branch, reasons: verdict.reasons }, { emit, queueDir });
  }

  // 3. Archive worktree-local docs/thoughts BEFORE any removal. Fail → defer.
  const arch = archive(path, { ticket });
  if (!arch.ok) {
    return deferWorktreeCleanup(path, { ticket, branch, reasons: ["archive-failed", arch.error] }, { emit, queueDir });
  }

  // 4. Re-check liveness inside the same flow, immediately before remove (TOCTOU:
  // a human/agent opening a session between the gate and the remove).
  if (procLive(path) === true) {
    return deferWorktreeCleanup(path, { ticket, branch, reasons: ["live-session-late"] }, { emit, queueDir });
  }

  // 5. Remove — NEVER --force. A refusal (e.g. an unexpected lock) → defer, never
  // escalate to a destructive force in any automated path.
  const rm = removeWorktree(path);
  if (rm.error || (rm.status ?? 1) !== 0) {
    return deferWorktreeCleanup(path, { ticket, branch, reasons: ["git-remove-failed", rm.error?.message ?? rm.stderr?.trim()] }, { emit, queueDir });
  }
  clearDeferMarker(path, queueDir);
  log.info({ ticket, worktreePath: path }, "worktree: removed (evidence-gated)");
  return { removed: true };
}

// gatedTeardownWorktree — boolean-returning adapter matching the legacy
// teardownWorktree({repoRoot, ticket}) seam, routed through the evidence gate. The
// scheduler's terminal-Done sweep wires this as its default (terminal:true): the
// worktree is removed ONLY when safe, else flagged (returns false → no
// .worktree-removed marker → re-evaluated next tick). The abort path wires it with
// terminal:false so it ALWAYS defers (abort is never terminal). prMerged defaults
// true because the only terminal:true caller is the Done sweep, where the pipeline
// already confirmed the merge; the clean-tree + no-unpushed gates are the
// load-bearing data-loss guards regardless.
export function gatedTeardownWorktree({ repoRoot, ticket, terminal = true, prMerged = true } = {}, deps = {}) {
  return safeTeardownWorktree({ repoRoot, ticket, terminal, prMerged }, deps).removed === true;
}
