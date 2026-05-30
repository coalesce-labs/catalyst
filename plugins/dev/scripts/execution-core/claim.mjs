#!/usr/bin/env node
// claim.mjs — atomic single-flight phase claim + fencing generation (CTL-736 Phase 1).
//
// The death-decision guard stack (busy short-circuit, idle-confirm streak,
// revive-grace window, MAX_REVIVES, storm-breaker, the phase-skill bg_job_id
// bow-out heuristics) all exist to dampen the SAME failure: a wrong "is this
// worker dead?" guess spawns a SECOND worker for one (ticket, phase). This file
// makes that duplicate structurally impossible.
//
//   • claimPhase(orchDir, ticket, phase, generation) — open(O_CREAT|O_EXCL) of
//     ${orchDir}/workers/<ticket>/<phase>.claim.<generation>. Exactly one
//     caller wins per generation; concurrent same-generation callers collide.
//   • The generation is a monotonic FENCING TOKEN. A fresh dispatch claims
//     gen=currentGeneration+1 (1 when nothing is held); a revive (sequential,
//     post-death) claims the next generation — a NEW filename, so O_EXCL
//     succeeds for it regardless of whether the dead generation's claim file is
//     still on disk.
//   • The signal carries `generation`; the worker receives CATALYST_GENERATION
//     in its env and asserts isCurrentGeneration(signal, mine) before emitting
//     any outcome (the structural replacement for the bg_job_id orphan-bow-out).
//
// PURE filesystem primitives — no event log, no spawn. Both a library (imported
// by recovery.mjs / tests) and a CLI (shelled into by phase-agent-dispatch and
// phase-agent-emit-complete, which are bash).

import { openSync, writeSync, closeSync, unlinkSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// claimPath — the per-generation claim file. One file per generation so the
// next generation is ALWAYS a fresh exclusive create (the revive never has to
// wait on a release of the dead generation's claim).
export function claimPath(orchDir, ticket, phase, generation) {
  return join(orchDir, "workers", ticket, `${phase}.claim.${generation}`);
}

// claimPhase — atomic compare-and-set. open(…, "wx") is the Node spelling of
// O_CREAT|O_EXCL: it creates the file or fails with EEXIST, never truncates an
// existing one. Returns {won:true} for the single winner, {won:false} for every
// loser at that generation. Any non-EEXIST error (e.g. ENOENT on a missing
// worker dir) propagates — that is a real misconfiguration, not a lost race.
export function claimPhase(orchDir, ticket, phase, generation) {
  const path = claimPath(orchDir, ticket, phase, generation);
  try {
    const fd = openSync(path, "wx");
    try {
      writeSync(fd, JSON.stringify({ generation, claimedAt: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    return { won: true, generation };
  } catch (e) {
    if (e.code === "EEXIST") return { won: false, generation };
    throw e;
  }
}

// releaseClaim — unlink a generation's claim file (hygiene: teardown, or a
// terminal phase whose claims will never be re-claimed). NOT required for the
// revive path to win the next generation — that is guaranteed by the
// per-generation filename. Returns true if a file was removed, false if absent.
export function releaseClaim(orchDir, ticket, phase, generation) {
  try {
    unlinkSync(claimPath(orchDir, ticket, phase, generation));
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}

// currentGeneration — the high-water generation held for (ticket, phase): the
// max `.claim.<n>` suffix in the worker dir, or 0 if none. A spawn-path
// dispatcher claims this + 1, which unifies fresh (0→1) and revive (N→N+1) and
// survives a deleted-signal worktree recreate (a stale claim tombstone still
// advances the high-water mark, so the recreate's re-dispatch claims a fresh
// generation instead of colliding on gen 1).
export function currentGeneration(orchDir, ticket, phase) {
  let names;
  try {
    names = readdirSync(join(orchDir, "workers", ticket));
  } catch {
    return 0; // worker dir absent → nothing claimed yet
  }
  const prefix = `${phase}.claim.`;
  let max = 0;
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const n = Number.parseInt(name.slice(prefix.length), 10);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

// isCurrentGeneration — the fencing predicate. true ⇒ this worker is current
// (proceed); false ⇒ the signal generation has advanced past it (a duplicate
// took over) so it must bow out. Conservative on missing data: a legacy signal
// with no `generation`, or a worker with no generation, returns true so the
// pre-CTL-736 bow-out heuristics still cover the migration window.
export function isCurrentGeneration(signal, myGeneration) {
  const sig = Number(signal?.generation);
  if (!Number.isFinite(sig)) return true; // legacy signal — nothing to fence against
  const mine = Number(myGeneration);
  if (myGeneration === "" || myGeneration === undefined || !Number.isFinite(mine)) {
    return true; // worker has no generation (legacy spawn) — don't bow out
  }
  return mine >= sig; // stale (mine < sig) ⇒ bow out
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
//
// Subcommands (all stdout is one JSON line unless noted):
//   dispatch-claim <orchDir> <ticket> <phase>
//       compute gen = currentGeneration+1, claim it → {won, generation}. exit 0.
//   claim <orchDir> <ticket> <phase> <generation>
//       claim an explicit generation → {won, generation}. exit 0 even on loss
//       (a lost race is a normal outcome the caller reads from .won).
//   current-generation <orchDir> <ticket> <phase>
//       print the high-water generation integer.
//   release <orchDir> <ticket> <phase> <generation>
//       unlink the claim → {released}. exit 0.
//   fence-check <orchDir> <ticket> <phase>
//       compare $CATALYST_GENERATION against signal.generation →
//       {current, signalGeneration, myGeneration}. exit 0 when current
//       (proceed), exit FENCE_STALE_EXIT (10) when stale (bow out).

const FENCE_STALE_EXIT = 10;

function isMain() {
  // True when run as `node claim.mjs …`, false when imported.
  return (
    process.argv[1] &&
    (process.argv[1].endsWith("/claim.mjs") || process.argv[1].endsWith("claim.mjs"))
  );
}

function readSignal(orchDir, ticket, phase) {
  const p = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function cli(argv) {
  const [cmd, orchDir, ticket, phase, gen] = argv;
  switch (cmd) {
    case "dispatch-claim": {
      const generation = currentGeneration(orchDir, ticket, phase) + 1;
      const res = claimPhase(orchDir, ticket, phase, generation);
      process.stdout.write(JSON.stringify(res) + "\n");
      return 0;
    }
    case "claim": {
      const res = claimPhase(orchDir, ticket, phase, Number(gen));
      process.stdout.write(JSON.stringify(res) + "\n");
      return 0;
    }
    case "current-generation": {
      process.stdout.write(String(currentGeneration(orchDir, ticket, phase)) + "\n");
      return 0;
    }
    case "release": {
      const released = releaseClaim(orchDir, ticket, phase, Number(gen));
      process.stdout.write(JSON.stringify({ released }) + "\n");
      return 0;
    }
    case "fence-check": {
      const signal = readSignal(orchDir, ticket, phase);
      const myGeneration = process.env.CATALYST_GENERATION;
      const current = isCurrentGeneration(signal, myGeneration);
      process.stdout.write(
        JSON.stringify({
          current,
          signalGeneration: signal?.generation ?? null,
          myGeneration: myGeneration ?? null,
        }) + "\n",
      );
      return current ? 0 : FENCE_STALE_EXIT;
    }
    default:
      process.stderr.write(
        `claim.mjs: unknown subcommand: ${cmd ?? "(none)"}\n` +
          "usage: claim.mjs <dispatch-claim|claim|current-generation|release|fence-check> …\n",
      );
      return 1;
  }
}

if (isMain()) {
  process.exit(cli(process.argv.slice(2)));
}
