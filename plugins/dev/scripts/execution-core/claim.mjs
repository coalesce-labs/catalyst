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
//   • The generation is a monotonic FENCING TOKEN, derived from the SIGNAL, not
//     from the live claim set: a fresh dispatch (no signal) claims 1; a revive
//     claims signal.generation + 1 — a NEW filename, so O_EXCL succeeds for it
//     regardless of whether the dead generation's claim file is still on disk.
//     Deriving it from the on-disk high-water mark instead re-opens the very
//     double-spawn this file closes; see the CLI note below (CTL-1791).
//   • The signal carries `generation`; the worker receives CATALYST_GENERATION
//     in its env and asserts isCurrentGeneration(signal, mine) before emitting
//     any outcome (the structural replacement for the bg_job_id orphan-bow-out).
//
// PURE filesystem primitives — no event log, no spawn.
//
// CONSUMER STATUS (verified CTL-1791): nothing in the production tree imports
// this module or shells into its CLI. `phase-agent-dispatch` reimplements the
// claim in pure bash (`set -o noclobber`) and only keeps the claim-file FORMAT
// in sync; `phase-agent-emit-complete` reimplements isCurrentGeneration's
// semantics in bash. This file is the reference implementation those two are
// held against, plus its own test — not a live dependency of either.

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
// max `.claim.<n>` suffix in the worker dir, or 0 if none.
//
// READ-ONLY OBSERVABILITY ONLY. A spawn path must NEVER claim this + 1: the
// claim set is mutated by the very computation that reads it, so two staggered
// dispatchers observe different high-water marks, compute different targets, and
// each wins its own O_EXCL file — the double-spawn the fence exists to close
// (CTL-1667, CTL-1791). The spawn target comes from the SIGNAL. This function
// backs the `current-generation` subcommand (inspection) and nothing else.
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
// NOTE (CTL-1791): there is deliberately NO `dispatch-claim` subcommand. It used
// to exist and computed `currentGeneration + 1` — a target derived from the LIVE
// claim-file high-water mark, which is precisely what the CTL-736 fence forbids:
// two staggered dispatchers each see the OTHER's claim, compute DIFFERENT
// targets (A: max 2 → 3, then B: max 3 → 4), each win their own O_EXCL file, and
// both spawn a worker — the double-spawn this file exists to make impossible.
// The claim set is mutated by that very computation, so it can never be a stable
// input to it. The live dispatcher (`phase-agent-dispatch`, pure bash, `set -o
// noclobber`) derives the target from the SIGNAL instead (fresh → 1, revive →
// signal.generation + 1) and never shelled into this CLI. The subcommand had
// zero production callers and existed only to be tested. Do not reintroduce it.
//
// Subcommands (all stdout is one JSON line unless noted):
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
          "usage: claim.mjs <claim|current-generation|release|fence-check> …\n",
      );
      return 1;
  }
}

if (isMain()) {
  process.exit(cli(process.argv.slice(2)));
}
