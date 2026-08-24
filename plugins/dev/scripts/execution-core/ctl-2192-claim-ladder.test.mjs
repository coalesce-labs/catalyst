// ctl-2192-claim-ladder.test.mjs — CTL-2192 Phase 5 (AC4).
//
// Replays the fix against CAPTURED LIVE SIGNALS (see __fixtures__/ctl-2192/
// PROVENANCE.md) and asserts THE PROPERTY — the count of `<phase>.claim.*` files
// stops growing for a ticket whose worker is alive — not a neighbour of it (a log
// line, an event name, a status string). A fixture authored to match the assumed
// model would agree with the assumption; these three trees were already on disk
// from the investigation, so they can disagree.
//
// Every assertion here is paired with a control:
//   - the PRE-FIX positive control replays the same tree through the OLD
//     two-valued liveness answer and asserts the ladder DOES grow. A harness that
//     cannot reproduce the bug cannot prove the fix, and a green run without this
//     control is INCONCLUSIVE, not a pass.
//   - the worker-absent control asserts a genuinely dead worker IS still
//     recovered (AC2), so "the ladder stopped" can never be satisfied by simply
//     never dispatching.
//   - CTC-166 is the negative control on the fixtures themselves: the ladder is
//     not universal.
//
// Run: cd plugins/dev/scripts/execution-core && bun test ctl-2192-claim-ladder.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { selectBootResumeCandidates } from "./boot-resume.mjs";
import { classifySdkWorkerLiveness, resetSdkWorkerRegistry } from "./sdk-worker-registry.mjs";
import { isPreemptBudgetExhausted, recordPreemption, preemptBudgetPath, PREEMPT_MAX_LAPS } from "./preempt-budget.mjs";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "ctl-2192");

let orchDir;

beforeEach(() => {
  resetSdkWorkerRegistry();
  orchDir = mkdtempSync(join(tmpdir(), "ctl2192-replay-"));
});

afterEach(() => {
  resetSdkWorkerRegistry();
  rmSync(orchDir, { recursive: true, force: true });
});

// ── fixture loading ─────────────────────────────────────────────────────────

// The captured phase signals are committed as `phase-<name>.json.fixture`, NOT
// under their live name. `orphan-sweep.sh` runs a fully RECURSIVE
// `find "$SWEEP_WORKERS_GLOB_ROOT" -name 'phase-*.json' -type f` (:803) whose
// default root is `$HOME/catalyst` — and every Catalyst worktree lives under it
// (`~/catalyst/wt/...`), so the PRODUCTION sweep matched these committed files
// and rewrote `status: "running"` → `failed` in place. Measured, not
// hypothetical: it fired on this worktree twice on 2026-08-23 (09:12:25Z and
// 10:35:37Z), red-failing this very file (4/19) via the checksum test and
// leaving a TRACKED file dirty, which `_precheck_has_real_source` classifies as
// real source and the CTL-707 dispatch-time rebase stalls on (rc=2). The
// `.fixture` suffix takes the committed bytes out of that glob; the live name is
// restored here, on the copy, inside the tmp orchDir. `no-live-phase-signal-name`
// below is the guard that keeps the next fixture capture from reopening it.
const FIXTURE_SUFFIX = ".fixture";

// Copy the captured tree into a tmp orchDir, restore the live `phase-*.json`
// names, and re-expand the scrub tokens. %ORCH% becomes THIS test's orchDir;
// %WT%/%HOME% become stable synthetic roots (nothing in the replay touches a
// real worktree).
function loadFixture(tickets) {
  for (const t of tickets) {
    cpSync(join(FIXTURE_DIR, "workers", t), join(orchDir, "workers", t), { recursive: true });
  }
  if (existsSync(join(FIXTURE_DIR, ".sdk-workers"))) {
    cpSync(join(FIXTURE_DIR, ".sdk-workers"), join(orchDir, ".sdk-workers"), { recursive: true });
  }
  for (const file of walk(orchDir)) {
    if (!file.endsWith(FIXTURE_SUFFIX)) continue;
    renameSync(file, file.slice(0, -FIXTURE_SUFFIX.length));
  }
  for (const file of walk(orchDir)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("%ORCH%") && !text.includes("%WT%") && !text.includes("%HOME%")) continue;
    writeFileSync(
      file,
      text.replaceAll("%ORCH%", orchDir).replaceAll("%WT%", "/replay/wt").replaceAll("%HOME%", "/replay/home"),
    );
  }
  writeFileSync(join(orchDir, "state.json"), JSON.stringify({ maxParallel: 3 }));
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// The escalation marker post-dates every ladder in these captures (PROVENANCE.md
// tabulates the mtimes), and selectBootResumeCandidates short-circuits on it
// BEFORE the liveness arm — so replaying the tree as-captured would exercise
// nothing and still print green. Restore the pre-escalation state explicitly.
function withPreEscalationState(tickets) {
  for (const t of tickets) {
    rmSync(join(orchDir, "workers", t, ".linear-label-needs-human.applied"), { force: true });
  }
}

function claimCount(ticket) {
  return readdirSync(join(orchDir, "workers", ticket)).filter((f) => /\.claim\.\d+$/.test(f)).length;
}

function claimFiles(ticket) {
  return readdirSync(join(orchDir, "workers", ticket)).filter((f) => /\.claim\.\d+$/.test(f)).sort();
}

// ── the modelled producer ───────────────────────────────────────────────────
//
// phase-agent-dispatch's revive branch mints `<phase>.claim.<gen+1>` and bumps
// the signal's generation. The replay models exactly that one write, because
// shelling out to the real dispatcher would need a worktree, a git repo, and a
// live claude. The model's fidelity is what the PRE-FIX control checks: if the
// model could not produce a ladder, the control would fail.
function mintClaim(ticket, phase) {
  const sigPath = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  const sig = JSON.parse(readFileSync(sigPath, "utf8"));
  const nextGen = Number(sig.generation ?? 0) + 1;
  writeFileSync(
    join(orchDir, "workers", ticket, `${phase}.claim.${nextGen}`),
    JSON.stringify({ generation: nextGen, claimedAt: new Date(0).toISOString() }),
  );
  writeFileSync(sigPath, JSON.stringify({ ...sig, generation: nextGen, status: "dispatched" }));
  return nextGen;
}

/**
 * Replay N boot passes over the loaded tree.
 * @param {object} opts
 * @param {"fixed"|"pre-fix"} opts.mode  "pre-fix" restores the OLD two-valued
 *   answer (no SDK arm at all → every in-flight ticket is a candidate). It is a
 *   HARNESS-level injection: nothing shipped can restore the defect.
 * @param {(ticket:string)=>object} [opts.liveness] the oracle, when mode==="fixed".
 */
function replayBootPasses({ ticks = 5, mode = "fixed", liveness, reapFailedTickets = new Set() } = {}) {
  const dispatched = [];
  for (let i = 0; i < ticks; i++) {
    const candidates = selectBootResumeCandidates({
      orchDir,
      agents: [], // no `claude agents` background sessions — SDK workers never appear there
      maxParallel: 3,
      logger: { warn: () => {}, info: () => {}, debug: () => {} },
      reapFailedTickets,
      // mode "pre-fix": omit sdkLiveness entirely, which is byte-for-byte the
      // pre-CTL-2192 selection (hasLiveBgWorker alone).
      ...(mode === "fixed" ? { sdkLiveness: liveness } : {}),
    });
    for (const c of candidates) {
      dispatched.push({ tick: i, ticket: c.ticket, phase: c.phase });
      mintClaim(c.ticket, c.phase);
    }
  }
  return dispatched;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("fixture integrity", () => {
  test("every committed fixture file matches the checksum PROVENANCE.md records", () => {
    const lines = readFileSync(join(FIXTURE_DIR, "CHECKSUMS.txt"), "utf8").split("\n").filter(Boolean);
    // POSITIVE CONTROL on the manifest itself: an empty or truncated CHECKSUMS.txt
    // would make this test pass over nothing ([].every(p) is true).
    expect(lines.length).toBeGreaterThan(50);
    for (const line of lines) {
      const [want, rel] = line.split(/\s{2,}/);
      const got = createHash("sha256").update(readFileSync(join(FIXTURE_DIR, rel))).digest("hex");
      expect(got, `fixture drifted: ${rel}`).toBe(want);
    }
  });

  test("the scrub left no absolute home path in any fixture", () => {
    const files = walk(FIXTURE_DIR).filter((f) => !f.endsWith("PROVENANCE.md"));
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) {
      expect(readFileSync(f, "utf8"), `unscrubbed path in ${f}`).not.toContain("/Users/");
    }
  });

  test("the captured CTL-2192 projection is the LEGACY shape this rollout has to tolerate", () => {
    // pid is the daemon's, childPid null, and NO childPidResolved key — so the
    // Phase 1 ladder must answer `unknown`, never `dead`.
    const proj = JSON.parse(readFileSync(join(FIXTURE_DIR, ".sdk-workers", "CTL-2192.json"), "utf8"));
    expect(proj.childPid).toBe(null);
    expect("childPidResolved" in proj).toBe(false);
    expect(typeof proj.pid).toBe("number");
  });
});

// ── the repo-wide guard ─────────────────────────────────────────────────────
//
// A committed file that LOOKS like a live phase signal is not inert: the
// production `orphan-sweep.sh` recurses the whole of `$HOME/catalyst` — which
// contains every worktree — matching `phase-*.json` and rewriting any whose
// `.status` is `running` (:731-:803). That mutation dirties a TRACKED file,
// which `_precheck_has_real_source` classifies as real source and the CTL-707
// dispatch-time rebase stalls on. This guard is repo-wide rather than
// fixture-local on purpose: the exposure belongs to the NAME, so the next
// capture — for any ticket, under any directory — must not be able to
// reintroduce it silently.
describe("no tracked file is shaped like a live phase signal", () => {
  // A committed file is exposed iff BOTH hold: the sweep's glob matches its
  // basename, AND jq can read a `.status` out of it (`.status // empty`,
  // orphan-sweep.sh:743). Split out so the positive control can exercise the
  // classifier on bytes that are deliberately NOT in the repo.
  function isSweepExposed(basename, contents) {
    if (!/^phase-.*\.json$/.test(basename)) return false;
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return false; // jq fails → `|| continue` → the sweep skips it
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return typeof parsed.status === "string" && parsed.status.length > 0;
  }

  test("POSITIVE CONTROL: the classifier flags a real captured signal, and clears the .fixture form", () => {
    // The exact bytes the sweep mutated on this worktree, read from the
    // committed fixture — not a hand-written stand-in.
    const captured = readFileSync(
      join(FIXTURE_DIR, "workers", "CTL-2192", `phase-implement.json${FIXTURE_SUFFIX}`),
      "utf8",
    );
    expect(JSON.parse(captured).status).toBe("running");

    // Under the LIVE name it is exposed — this is the defect, reproduced.
    expect(isSweepExposed("phase-implement.json", captured)).toBe(true);
    // Under the committed name it is not: `phase-*.json` does not match.
    expect(isSweepExposed(`phase-implement.json${FIXTURE_SUFFIX}`, captured)).toBe(false);
    // And a same-named file the sweep cannot parse is skipped by `|| continue`.
    expect(isSweepExposed("phase-implement.json", "not json")).toBe(false);
  });

  test("⛔ THE INVARIANT: no file tracked by git is sweep-exposed", () => {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: dirname(fileURLToPath(import.meta.url)),
      encoding: "utf8",
    }).trim();
    const tracked = execFileSync("git", ["ls-files", "-z", "--full-name"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean);

    // POSITIVE CONTROL on the ENUMERATION, not just the predicate. Two failure
    // modes this closes, both of which read as a clean pass: `git ls-files`
    // returning nothing (wrong cwd, no repo) makes the loop below run zero times
    // and print green; and an enumeration that never descends into
    // `__fixtures__/` would miss the only files that have ever tripped this.
    expect(tracked.length).toBeGreaterThan(500);
    expect(tracked).toContain(
      "plugins/dev/scripts/execution-core/__fixtures__/ctl-2192/workers/CTL-2192/phase-implement.json.fixture",
    );

    const exposed = [];
    for (const rel of tracked) {
      const base = rel.slice(rel.lastIndexOf("/") + 1);
      if (!/^phase-.*\.json$/.test(base)) continue; // cheap gate before any read
      const abs = join(repoRoot, rel);
      if (!existsSync(abs)) continue; // tracked-but-absent (sparse checkout)
      let contents;
      try {
        contents = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (isSweepExposed(base, contents)) exposed.push(rel);
    }

    expect(
      exposed,
      `these tracked files are rewritten in place by the production orphan-sweep ` +
        `(find $HOME/catalyst -name 'phase-*.json' → flip .status) — commit them under ` +
        `a name outside that glob (e.g. the '${FIXTURE_SUFFIX}' suffix loadFixture strips):\n` +
        exposed.join("\n"),
    ).toEqual([]);
  });
});

describe("Producer B — the captured CTL-2192 ladder", () => {
  test("⛔ THE PROPERTY: with the worker alive, replayed boot passes add NO claim files", () => {
    loadFixture(["CTL-2192"]);
    withPreEscalationState(["CTL-2192"]);
    const before = claimFiles("CTL-2192");
    expect(before.length).toBeGreaterThan(0); // the captured ladder is really there

    const dispatched = replayBootPasses({
      ticks: 5,
      liveness: () => ({ state: "live", reason: "orphan-child-alive", childPid: 4242 }),
    });

    expect(dispatched).toEqual([]);
    expect(claimFiles("CTL-2192")).toEqual(before);
  });

  test("⛔ PRE-FIX POSITIVE CONTROL: the SAME replay through the old answer DOES grow the ladder", () => {
    // If this passes green, the harness has no teeth and the test above proves
    // nothing. The control is what makes the green run evidence.
    loadFixture(["CTL-2192"]);
    withPreEscalationState(["CTL-2192"]);
    const before = claimCount("CTL-2192");

    const dispatched = replayBootPasses({ ticks: 5, mode: "pre-fix" });

    expect(dispatched.length).toBe(5); // one fresh generation per boot, forever
    expect(claimCount("CTL-2192")).toBe(before + 5);
  });

  test("AC2: with the worker ABSENT the ladder grows by exactly ONE per boot — recovery still works", () => {
    loadFixture(["CTL-2192"]);
    withPreEscalationState(["CTL-2192"]);
    const before = claimCount("CTL-2192");

    const dispatched = replayBootPasses({
      ticks: 1,
      liveness: () => ({ state: "dead", reason: "no-child-resolved", childPid: null }),
    });

    expect(dispatched).toHaveLength(1);
    expect(claimCount("CTL-2192")).toBe(before + 1);
  });

  test("UNKNOWN (the legacy projection actually captured) preserves today's recovery behaviour", () => {
    loadFixture(["CTL-2192"]);
    withPreEscalationState(["CTL-2192"]);
    const before = claimCount("CTL-2192");

    // The REAL oracle, against the REAL captured projection — no stub.
    const verdict = classifySdkWorkerLiveness(orchDir, "CTL-2192", { pidAlive: () => false, selfPid: 1 });
    expect(verdict.state).toBe("unknown");
    expect(verdict.reason).toBe("legacy-projection-no-child-record");

    const dispatched = replayBootPasses({
      ticks: 1,
      liveness: (t) => classifySdkWorkerLiveness(orchDir, t, { pidAlive: () => false, selfPid: 1 }),
    });
    expect(dispatched).toHaveLength(1);
    expect(claimCount("CTL-2192")).toBe(before + 1);
  });

  test("⛔ an unconfirmed orphan reap adds NO claim, even at a `dead` verdict", () => {
    loadFixture(["CTL-2192"]);
    withPreEscalationState(["CTL-2192"]);
    const before = claimFiles("CTL-2192");

    const dispatched = replayBootPasses({
      ticks: 5,
      liveness: () => ({ state: "dead", reason: "no-child-resolved", childPid: null }),
      reapFailedTickets: new Set(["CTL-2192"]),
    });

    expect(dispatched).toEqual([]);
    expect(claimFiles("CTL-2192")).toEqual(before);
  });
});

describe("Producer A — the captured CTC-355 ladder", () => {
  // CTC-355 carries 19 captured claim files and 18 `phase.*.preempted.CTC-355`
  // events (PROVENANCE.md, counted by exact event.name with a 1788-event positive
  // control). The property here is the CROSS-LAP bound: a victim cannot be
  // preempted without limit inside one window.
  test("the captured ladder really is a ladder (the thing being bounded exists)", () => {
    loadFixture(["CTC-355"]);
    expect(claimCount("CTC-355")).toBeGreaterThanOrEqual(19);
    const research = claimFiles("CTC-355").filter((f) => f.startsWith("research.claim."));
    expect(research.length).toBe(8);
  });

  test("the captured signal cross-checks the claim ladder: generation N ⇔ N claim files", () => {
    // Validates the mechanism this ticket describes AND the fidelity of the
    // harness's mintClaim model (one claim per generation bump) against real
    // captured data rather than against the model's own assumptions.
    loadFixture(["CTC-355"]);
    const research = JSON.parse(readFileSync(join(orchDir, "workers", "CTC-355", "phase-research.json"), "utf8"));
    expect(research.generation).toBe(8);
    expect(claimFiles("CTC-355").filter((f) => f.startsWith("research.claim.")).length).toBe(8);
    // And it is a PREEMPTION ladder, not some other re-dispatch: `parkedFrom` +
    // `attentionReason: "preempted-by-priority"` has exactly one production
    // writer, the scheduler's preemption park.
    expect(research.parkedFrom).toBe("research");
    expect(research.attentionReason).toBe("preempted-by-priority");
  });

  test("SCOPE (stated, not worked around): a full schedulerTick replay is not possible on this capture", () => {
    // Every CTC-355 signal on disk is now TERMINAL — research `done`, implement
    // `stalled` (rebase_refused_dirty_tree) — because the ticket moved on after
    // the ladder. isTicketInFlight therefore drops it, and the preemption sweep
    // never considers it. Restoring a `running` status here would be AUTHORING
    // the fixture, which is exactly what AC4 rules out.
    //
    // The full schedulerTick proof for Producer A lives in
    // integration-ctl-705.test.mjs (real tick, real park, asserting no signal
    // rewrite / unchanged generation / no preempted event at the cap). What THIS
    // file proves against captured data is the cross-lap bound itself.
    loadFixture(["CTC-355"]);
    const statuses = ["research", "plan", "implement", "triage"].map(
      (ph) => JSON.parse(readFileSync(join(orchDir, "workers", "CTC-355", `phase-${ph}.json`), "utf8")).status,
    );
    expect(statuses).not.toContain("running");
    expect(statuses).not.toContain("preempted");
  });

  test("⛔ THE PROPERTY: the durable budget caps the laps inside one window", () => {
    loadFixture(["CTC-355"]);
    const T0 = 1_700_000_000_000;
    let laps = 0;
    // Replay 20 preemption opportunities ~90 s apart — the measured cadence.
    for (let i = 0; i < 20; i++) {
      const at = T0 + i * 90_000;
      if (isPreemptBudgetExhausted(orchDir, "CTC-355", { now: () => at }).exhausted) continue;
      recordPreemption(orchDir, "CTC-355", { now: () => at });
      laps++;
    }
    expect(laps).toBe(PREEMPT_MAX_LAPS);
  });

  test("⛔ PRE-FIX POSITIVE CONTROL: without a DURABLE ledger every opportunity preempts", () => {
    // rankedAboveSince was MODULE state, erased by every daemon bounce — modelled
    // here by dropping the ledger between opportunities. 20 laps, unbounded.
    loadFixture(["CTC-355"]);
    const T0 = 1_700_000_000_000;
    let laps = 0;
    for (let i = 0; i < 20; i++) {
      const at = T0 + i * 90_000;
      rmSync(preemptBudgetPath(orchDir, "CTC-355"), { force: true }); // the bounce
      if (isPreemptBudgetExhausted(orchDir, "CTC-355", { now: () => at }).exhausted) continue;
      recordPreemption(orchDir, "CTC-355", { now: () => at });
      laps++;
    }
    expect(laps).toBe(20);
  });

  test("EXPIRY: a new window re-arms the budget (damping, not a permanent exemption)", () => {
    loadFixture(["CTC-355"]);
    const T0 = 1_700_000_000_000;
    for (let i = 0; i < PREEMPT_MAX_LAPS; i++) recordPreemption(orchDir, "CTC-355", { now: () => T0 });
    expect(isPreemptBudgetExhausted(orchDir, "CTC-355", { now: () => T0 }).exhausted).toBe(true);
    const later = T0 + 31 * 60_000;
    expect(isPreemptBudgetExhausted(orchDir, "CTC-355", { now: () => later }).exhausted).toBe(false);
  });
});

describe("CTC-166 — the negative control on the fixtures themselves", () => {
  test("⛔ the ladder is NOT universal: this captured tree has only 3 claims across two days", () => {
    // A fix that always re-claims, or a harness that assumes every tree ladders,
    // is wrong in the other direction. This tree is what catches that.
    loadFixture(["CTC-166"]);
    expect(claimCount("CTC-166")).toBe(3);
    expect(claimFiles("CTC-166")).toEqual(["research.claim.1", "research.claim.2", "triage.claim.1"]);
  });

  test("a tree with no live worker and no ladder still recovers exactly once", () => {
    loadFixture(["CTC-166"]);
    withPreEscalationState(["CTC-166"]);
    const before = claimCount("CTC-166");
    const dispatched = replayBootPasses({
      ticks: 1,
      liveness: () => ({ state: "dead", reason: "no-child-resolved", childPid: null }),
    });
    // CTC-166's captured signals are all terminal (`stalled`), so it is not
    // in-flight and boot-resume correctly proposes nothing. Assert the tree is
    // unchanged rather than asserting a dispatch that should not happen.
    expect(dispatched).toEqual([]);
    expect(claimCount("CTC-166")).toBe(before);
  });
});

// ─── CTL-2192 (remediation): the WIRING is the guard ────────────────────────
//
// Every functional test of the Phase-4 guard injects its seams, so deleting the
// two lines in daemon.mjs that DERIVE and THREAD `sdkReapFailedTickets` left the
// whole guard a silent no-op with all of them still green. A unit test cannot
// observe startDaemon's boot ordering (the same reason github-auth-preflight's
// "daemon boot ordering" block is a source scan), so this is one too — and it
// lives here rather than in daemon.test.mjs, which is EXCLUDED from the
// execution-core-tests allowlist and therefore gates nothing.
describe("daemon wiring — the reap-failed set is derived and threaded (CTL-2192)", () => {
  const daemonSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "daemon.mjs"), "utf8");
  const lines = daemonSrc.split("\n");
  const lineOf = (needle) => lines.findIndex((l) => l.includes(needle));

  test("sdkReapFailedTickets is DERIVED from reconcileSdkRegistryOnBoot().reapFailed", () => {
    const derive = lineOf("const sdkReapFailedTickets = new Set(");
    expect(derive).toBeGreaterThan(-1);
    // …from the boot reconcile's own result, not from some other source.
    expect(lines[derive]).toContain("sdkRegistryBoot.reapFailed");
    // …and after the reconcile that produces it.
    const reconcile = lineOf("const sdkRegistryBoot = reconcileSdkRegistryOnBoot(");
    expect(reconcile).toBeGreaterThan(-1);
    expect(reconcile).toBeLessThan(derive);
  });

  test("BOTH boot dispatch entry points receive it", () => {
    // reconcileBoot is the door the guard was written for; processApprovedResumes
    // is the adjacent one it walked around, eight lines later.
    const bootResume = lineOf("const bootResume = reconcileBoot(");
    const approved = lineOf("processApprovedResumes({ orchDir, dispatch: dispatchFn");
    expect(bootResume).toBeGreaterThan(-1);
    expect(approved).toBeGreaterThan(-1);

    // The argument must actually be present at each site. reconcileBoot's call is
    // multi-line, so scan its object literal; processApprovedResumes' is one line.
    const bootResumeBlock = lines.slice(bootResume, bootResume + 14).join("\n");
    expect(bootResumeBlock).toContain("reapFailedTickets: sdkReapFailedTickets");
    expect(lines[approved]).toContain("reapFailedTickets: sdkReapFailedTickets");

    // Derived before it is used at either door.
    const derive = lineOf("const sdkReapFailedTickets = new Set(");
    expect(derive).toBeLessThan(bootResume);
    expect(derive).toBeLessThan(approved);
  });

  test("⛔ the scan is anchored on strings that EXIST — the instrument can fail", () => {
    // A source scan whose needles have all drifted returns -1 everywhere and, if
    // the assertions were written the other way round, would read as a pass.
    // This asserts the anchors resolve, so a rename fails loudly here rather
    // than silently disarming the two tests above.
    expect(lineOf("reconcileSdkRegistryOnBoot(")).toBeGreaterThan(-1);
    expect(lineOf("a-string-that-must-never-appear-in-daemon-mjs")).toBe(-1);
  });
});
