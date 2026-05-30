// claim.test.mjs — atomic single-flight claim + fencing generation (CTL-736 Phase 1).
//
// The claim makes duplicate worker spawn structurally impossible: each
// (ticket, phase, generation) is claimed by an atomic open(O_CREAT|O_EXCL);
// exactly one dispatcher wins, all others no-op. The generation is a monotonic
// fencing token written into the signal; a worker whose generation is stale
// self-disqualifies before any outcome write.
import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  claimPhase,
  releaseClaim,
  isCurrentGeneration,
  currentGeneration,
  claimPath,
} from "./claim.mjs";

const CLAIM_BIN = fileURLToPath(new URL("./claim.mjs", import.meta.url));

let ORCH_DIR;

beforeEach(() => {
  ORCH_DIR = mkdtempSync(join(tmpdir(), "claim-"));
  // claimPhase writes under ${orchDir}/workers/<ticket>/; make the ticket dir.
  mkdirSync(join(ORCH_DIR, "workers", "CTL-1"), { recursive: true });
});

describe("claimPhase — atomic single-flight per generation", () => {
  it("two concurrent claims at the same generation: exactly one wins", async () => {
    const results = await Promise.all([
      Promise.resolve().then(() => claimPhase(ORCH_DIR, "CTL-1", "implement", 1)),
      Promise.resolve().then(() => claimPhase(ORCH_DIR, "CTL-1", "implement", 1)),
    ]);
    expect(results.filter((r) => r.won)).toHaveLength(1);
    expect(results.filter((r) => !r.won)).toHaveLength(1);
  });

  it("a higher generation can re-claim after death (revive path)", () => {
    expect(claimPhase(ORCH_DIR, "CTL-1", "implement", 1).won).toBe(true);
    // gen 1 still held → same-gen reclaim fails…
    expect(claimPhase(ORCH_DIR, "CTL-1", "implement", 1).won).toBe(false);
    // …but the next generation is a fresh exclusive file → succeeds, even
    // WITHOUT releasing gen 1 (per-generation filenames guarantee freshness).
    expect(claimPhase(ORCH_DIR, "CTL-1", "implement", 2).won).toBe(true);
  });

  it("a lost claim reports the held generation and never overwrites the winner", () => {
    const first = claimPhase(ORCH_DIR, "CTL-1", "implement", 1);
    const second = claimPhase(ORCH_DIR, "CTL-1", "implement", 1);
    expect(first.won).toBe(true);
    expect(second.won).toBe(false);
    // The winner's claim file is intact — the loser did not truncate it.
    const body = JSON.parse(readFileSync(claimPath(ORCH_DIR, "CTL-1", "implement", 1), "utf8"));
    expect(body.generation).toBe(1);
    expect(typeof body.claimedAt).toBe("string");
  });

  it("claim is O_EXCL (create-exclusive), never a read-then-write race", () => {
    // White-box: pre-create the claim file, then a claim at that generation must
    // fail with won:false (EEXIST) rather than truncating/overwriting it. Proves
    // the create uses the wx/O_EXCL flag, not existsSync()+write.
    const path = claimPath(ORCH_DIR, "CTL-1", "implement", 7);
    writeFileSync(path, "SENTINEL");
    expect(claimPhase(ORCH_DIR, "CTL-1", "implement", 7).won).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("SENTINEL");
  });

  it("distinct (ticket, phase) pairs do not collide", () => {
    mkdirSync(join(ORCH_DIR, "workers", "CTL-2"), { recursive: true });
    expect(claimPhase(ORCH_DIR, "CTL-1", "implement", 1).won).toBe(true);
    expect(claimPhase(ORCH_DIR, "CTL-1", "verify", 1).won).toBe(true);
    expect(claimPhase(ORCH_DIR, "CTL-2", "implement", 1).won).toBe(true);
  });
});

describe("releaseClaim", () => {
  it("unlinks the claim file and reports released:true", () => {
    claimPhase(ORCH_DIR, "CTL-1", "implement", 1);
    expect(existsSync(claimPath(ORCH_DIR, "CTL-1", "implement", 1))).toBe(true);
    expect(releaseClaim(ORCH_DIR, "CTL-1", "implement", 1)).toBe(true);
    expect(existsSync(claimPath(ORCH_DIR, "CTL-1", "implement", 1))).toBe(false);
  });

  it("releasing an absent claim is a no-op (released:false), never throws", () => {
    expect(releaseClaim(ORCH_DIR, "CTL-1", "implement", 99)).toBe(false);
  });
});

describe("currentGeneration — max held generation", () => {
  it("returns 0 when nothing is claimed (fresh dispatch ⇒ gen 1)", () => {
    expect(currentGeneration(ORCH_DIR, "CTL-1", "implement")).toBe(0);
  });

  it("returns the highest claimed generation suffix", () => {
    claimPhase(ORCH_DIR, "CTL-1", "implement", 1);
    claimPhase(ORCH_DIR, "CTL-1", "implement", 2);
    claimPhase(ORCH_DIR, "CTL-1", "implement", 5);
    expect(currentGeneration(ORCH_DIR, "CTL-1", "implement")).toBe(5);
  });

  it("a released lower generation does not lower the high-water mark", () => {
    claimPhase(ORCH_DIR, "CTL-1", "implement", 1);
    claimPhase(ORCH_DIR, "CTL-1", "implement", 2);
    releaseClaim(ORCH_DIR, "CTL-1", "implement", 1);
    expect(currentGeneration(ORCH_DIR, "CTL-1", "implement")).toBe(2);
  });

  it("is scoped per phase — verify claims don't count toward implement", () => {
    claimPhase(ORCH_DIR, "CTL-1", "verify", 3);
    expect(currentGeneration(ORCH_DIR, "CTL-1", "implement")).toBe(0);
  });
});

describe("isCurrentGeneration — fencing check", () => {
  it("a worker whose generation < signal.generation bows out", () => {
    expect(isCurrentGeneration({ generation: 3 }, 2)).toBe(false);
    expect(isCurrentGeneration({ generation: 3 }, 3)).toBe(true);
    expect(isCurrentGeneration({ generation: 3 }, 4)).toBe(true);
  });

  it("legacy signal without a generation field ⇒ proceed (never bow out)", () => {
    expect(isCurrentGeneration({}, 1)).toBe(true);
    expect(isCurrentGeneration(null, 1)).toBe(true);
  });

  it("worker without a generation (CATALYST_GENERATION unset) ⇒ proceed", () => {
    expect(isCurrentGeneration({ generation: 3 }, undefined)).toBe(true);
    expect(isCurrentGeneration({ generation: 3 }, "")).toBe(true);
  });
});

// ─── CLI surface (the bash dispatch/emit/skill callers shell into this) ──────

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLAIM_BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("CLI: dispatch-claim", () => {
  it("computes gen = currentGeneration + 1, claims it, prints {won, generation}", () => {
    const r = runCli(["dispatch-claim", ORCH_DIR, "CTL-1", "implement"]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.won).toBe(true);
    expect(out.generation).toBe(1); // fresh ⇒ gen 1
    // A second dispatch-claim (e.g. revive) bumps to gen 2.
    const r2 = runCli(["dispatch-claim", ORCH_DIR, "CTL-1", "implement"]);
    expect(JSON.parse(r2.stdout).generation).toBe(2);
  });
});

describe("CLI: claim (loss is a clean signal, not an error exit)", () => {
  it("a lost same-generation claim prints won:false and still exits 0", () => {
    runCli(["claim", ORCH_DIR, "CTL-1", "implement", "1"]);
    const r = runCli(["claim", ORCH_DIR, "CTL-1", "implement", "1"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).won).toBe(false);
  });
});

describe("CLI: fence-check", () => {
  function writeSignal(generation) {
    const p = join(ORCH_DIR, "workers", "CTL-1", "phase-implement.json");
    const body = { ticket: "CTL-1", phase: "implement", status: "running" };
    if (generation !== undefined) body.generation = generation;
    writeFileSync(p, JSON.stringify(body));
  }

  it("current generation ⇒ exit 0 (proceed)", () => {
    writeSignal(2);
    const r = runCli(["fence-check", ORCH_DIR, "CTL-1", "implement"], { CATALYST_GENERATION: "2" });
    expect(r.status).toBe(0);
  });

  it("stale generation (mine < signal) ⇒ non-zero exit (bow out)", () => {
    writeSignal(3);
    const r = runCli(["fence-check", ORCH_DIR, "CTL-1", "implement"], { CATALYST_GENERATION: "2" });
    expect(r.status).not.toBe(0);
  });

  it("no CATALYST_GENERATION (legacy worker) ⇒ exit 0 (proceed)", () => {
    writeSignal(3);
    const r = runCli(["fence-check", ORCH_DIR, "CTL-1", "implement"]);
    expect(r.status).toBe(0);
  });

  it("missing signal file ⇒ exit 0 (proceed; nothing to fence against)", () => {
    const r = runCli(["fence-check", ORCH_DIR, "CTL-1", "implement"], { CATALYST_GENERATION: "2" });
    expect(r.status).toBe(0);
  });
});
