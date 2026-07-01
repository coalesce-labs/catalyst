import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, main, defaultCheckOpenPrs } from "./linear-reconcile-cli.mjs";
import { defaultDeriveAttachmentPrs } from "./open-pr-gate.mjs";
import { readDeclaration, listDeclarations } from "./linear-reconcile-store.mjs";

// The open-PR Done gate is now UNIVERSAL (CTL-1157): every `--state done` declare
// runs checkOpenPrs. Tests that aren't exercising the gate inject this pass-through
// so they never shell out to real `gh`.
const PASS = () => ({ ok: true, prs: [] });

async function runCli(argv, deps = {}) {
  const out = [];
  const err = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = (s) => {
    out.push(String(s));
    return true;
  };
  process.stderr.write = (s) => {
    err.push(String(s));
    return true;
  };
  try {
    const code = await main(argv, deps);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

// .catalyst config fixture with a stateMap (for reconcile dry-run target resolution).
function configFixture() {
  const dir = mkdtempSync(join(tmpdir(), "reconcile-cfg-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      catalyst: {
        linear: {
          teamKey: "CTL",
          stateMap: { backlog: "Backlog", inReview: "PR", done: "Done", canceled: "Canceled" },
        },
      },
    })
  );
  return path;
}

// ── parseArgs ─────────────────────────────────────────────────────────────────

test("parseArgs: subcommand + flags", () => {
  const a = parseArgs(["declare", "CTL-9", "--state", "done", "--no-write", "--note", "hi"]);
  expect(a._).toEqual(["declare", "CTL-9"]);
  expect(a.state).toBe("done");
  expect(a.noWrite).toBe(true);
  expect(a.note).toBe("hi");
  expect(parseArgs(["--bogus"]).error).toContain("unknown option");
});

// ── exit codes ────────────────────────────────────────────────────────────────

test("--help exits 0; no command exits 2; unknown command exits 2", async () => {
  expect((await runCli(["--help"])).code).toBe(0);
  expect((await runCli([])).code).toBe(2);
  expect((await runCli(["frobnicate"])).code).toBe(2);
});

test("declare without a ticket exits 2", async () => {
  expect((await runCli(["declare"])).code).toBe(2);
});

// ── declare (no write) → durable marker ───────────────────────────────────────

test("declare --no-write persists a pending marker and emits nothing to Linear", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const { code, out } = await runCli(
    ["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs: PASS }
  );
  expect(code).toBe(0);
  expect(out).toContain("declared (no write)");
  const d = readDeclaration("CTL-9", dir);
  expect(d.state).toBe("done");
  expect(d.reconciledAt).toBeNull();
  expect(listDeclarations({ dir, pendingOnly: true }).map((x) => x.ticket)).toEqual(["CTL-9"]);
});

// ── status ────────────────────────────────────────────────────────────────────

test("status --json lists pending declarations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  await runCli(["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir], {
    checkOpenPrs: PASS,
  });
  const { code, out } = await runCli(["status", "--json", "--decls-dir", dir]);
  expect(code).toBe(0);
  expect(JSON.parse(out).pending.map((x) => x.ticket)).toEqual(["CTL-9"]);
});

// ── reconcile (dry-run drain over fixtures) ──────────────────────────────────

test("reconcile --json drains pending → reports drift, writes nothing, exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const statesFile = join(dir, "states.json");
  writeFileSync(statesFile, JSON.stringify({ "CTL-9": "Implement" }));
  await runCli(["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir], {
    checkOpenPrs: PASS,
  });

  const { code, out } = await runCli([
    "reconcile",
    "--decls-dir",
    dir,
    "--states-file",
    statesFile,
    "--config",
    configFixture(),
    "--json",
  ]);
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.mode).toBe("dry-run");
  expect(parsed.summary.drift).toBe(1);
  expect(parsed.summary.corrected).toBe(0);
  const row = parsed.rows.find((r) => r.ticket === "CTL-9");
  expect(row.decision).toBe("correct");
  expect(row.dryRun).toBe(true);
  // dry-run does not stamp reconciledAt → still pending
  expect(listDeclarations({ dir, pendingOnly: true }).map((x) => x.ticket)).toEqual(["CTL-9"]);
});

test("reconcile over an already-Done ticket is in-sync (idempotent), exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const statesFile = join(dir, "states.json");
  writeFileSync(statesFile, JSON.stringify({ "CTL-9": "Done" }));
  await runCli(["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir], {
    checkOpenPrs: PASS,
  });
  const { code, out } = await runCli([
    "reconcile",
    "--decls-dir",
    dir,
    "--states-file",
    statesFile,
    "--config",
    configFixture(),
    "--json",
  ]);
  expect(code).toBe(0);
  expect(JSON.parse(out).summary.inSync).toBe(1);
  expect(JSON.parse(out).summary.drift).toBe(0);
});

// ── CTL-1157 THE REVERSAL: agent judgment, not a mechanical block ─────────────
// The Done-safety mechanism is AGENT JUDGMENT. The senior-engineer delegate
// enumerates a ticket's open PRs and resolves them ITSELF (finish/merge the needed
// ones, CLOSE the abandoned ones) BEFORE it declares Done — so `declare` is NOT
// gated and NEVER refuses. The hard block is held in reserve. The two pure-code
// backstops (terminal sweep + reconcile drain) PROCEED but emit the loud
// `recovery.done-applied-with-open-pr` alarm when they land a Done with an open PR.

test("parseArgs: --require-prs-merged / --branch (retained as no-op back-compat)", () => {
  const a = parseArgs(["declare", "CTL-9", "--require-prs-merged", "--branch", "ryan/ctl-9-x"]);
  expect(a.requirePrsMerged).toBe(true);
  expect(a.branch).toBe("ryan/ctl-9-x");
});

test("REVERSAL: declare PROCEEDS (exit 0, marker persists) even with an open PR — the agent already reasoned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  // An open PR is present, but the senior-engineer delegate decided (autonomously)
  // to mark Done. The CLI must NOT refuse, and must NOT consult any PR gate.
  let consulted = 0;
  const checkOpenPrs = () => {
    consulted++;
    return { ok: false, prs: [{ number: 101, state: "OPEN", isDraft: false, title: "wip" }] };
  };
  const { code, out } = await runCli(
    ["declare", "CTL-9", "--by", "recovery-pass", "--no-write", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs }
  );
  expect(code).toBe(0); // no handcuff — proceeds
  expect(out).toContain("declared (no write)");
  expect(consulted).toBe(0); // the agent declare path does NOT consult the enumerator
  // The durable marker persists (no fail-closed swallow).
  expect(readDeclaration("CTL-9", dir).state).toBe("done");
  expect(listDeclarations({ dir, pendingOnly: true }).map((x) => x.ticket)).toEqual(["CTL-9"]);
});

test("REVERSAL: a clean Done declaration (no open PR) proceeds exactly as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const { code, out } = await runCli(
    ["declare", "CTL-9", "--by", "pipeline", "--no-write", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs: PASS }
  );
  expect(code).toBe(0);
  expect(out).toContain("declared (no write)");
  expect(readDeclaration("CTL-9", dir).state).toBe("done");
});

// ── Reconcile drain backstop: ALARM-NOT-BLOCK ────────────────────────────────
// The pure-code drain has no agent to reason. It PROCEEDS (always writes), but when
// it lands a real Done transition for a ticket that still has ≥1 OPEN PR it fires
// recovery.done-applied-with-open-pr. A clean Done emits nothing.

// applyCorrectionDone — a fake Linear write that reports a real Done transition.
const applyCorrectionDone = ({ ticket, target }) => ({
  applied: true,
  action: "transitioned",
  from_state: "Implement",
  to_state: target,
  ticket,
});

test("DRAIN: emits recovery.done-applied-with-open-pr when it writes Done with an open PR present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const statesFile = join(dir, "states.json");
  writeFileSync(statesFile, JSON.stringify({ "CTL-9": "Implement" })); // drifted ⇒ a real Done write
  await runCli(["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir], {
    checkOpenPrs: PASS,
  });

  const alarms = [];
  const { code, out } = await runCli(
    [
      "reconcile",
      "--write",
      "--decls-dir",
      dir,
      "--states-file",
      statesFile,
      "--config",
      configFixture(),
      "--json",
    ],
    {
      applyCorrection: applyCorrectionDone,
      checkOpenPrs: () => ({ ok: false, prs: [{ number: 101, state: "OPEN", isDraft: false }] }),
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
    }
  );
  expect(code).toBe(0);
  const parsed = JSON.parse(out);
  expect(parsed.summary.corrected).toBe(1); // the drain PROCEEDED — Done was written
  // The alarm fired with the ticket, the open PR list, and the backstop label.
  expect(alarms).toHaveLength(1);
  expect(alarms[0].ticket).toBe("CTL-9");
  expect(alarms[0].by).toBe("reconcile-drain");
  expect(alarms[0].openPrs.map((p) => p.number)).toEqual([101]);
});

test("DRAIN: a CLEAN Done (0 open PRs) emits NO alarm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const statesFile = join(dir, "states.json");
  writeFileSync(statesFile, JSON.stringify({ "CTL-9": "Implement" }));
  await runCli(["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir], {
    checkOpenPrs: PASS,
  });

  const alarms = [];
  const { code } = await runCli(
    [
      "reconcile",
      "--write",
      "--decls-dir",
      dir,
      "--states-file",
      statesFile,
      "--config",
      configFixture(),
      "--json",
    ],
    {
      applyCorrection: applyCorrectionDone,
      checkOpenPrs: () => ({ ok: true, prs: [] }), // clean
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
    }
  );
  expect(code).toBe(0);
  expect(alarms).toEqual([]); // clean Done is silent
});

// ── CTL-1157 SLICE 3 — the broad recovery.done-applied "Done-moves" event ──────
// Unlike the open-PR alarm, this fires on EVERY autonomous Done (clean or not).

test("DRAIN done-applied: fires on EVERY drained Done (clean too), by=reconcile-drain, 0/0 counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const statesFile = join(dir, "states.json");
  writeFileSync(statesFile, JSON.stringify({ "CTL-9": "Implement" }));
  await runCli(["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir], {
    checkOpenPrs: PASS,
  });
  const moves = [];
  const { code } = await runCli(
    ["reconcile", "--write", "--decls-dir", dir, "--states-file", statesFile, "--config", configFixture(), "--json"],
    {
      applyCorrection: applyCorrectionDone,
      checkOpenPrs: () => ({ ok: true, prs: [] }), // CLEAN — alarm stays silent
      emitDoneApplied: (f) => moves.push(f),
    }
  );
  expect(code).toBe(0);
  expect(moves).toHaveLength(1); // the move event fires even on a clean Done
  expect(moves[0]).toMatchObject({
    ticket: "CTL-9",
    by: "reconcile-drain",
    openPrsAtDone: 0,
    prsClosed: 0,
    prsKept: 0,
    recoveryMode: "enforce",
  });
});

test("DRAIN done-applied: open_prs_at_done carries the red-line count when a PR is still open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const statesFile = join(dir, "states.json");
  writeFileSync(statesFile, JSON.stringify({ "CTL-9": "Implement" }));
  await runCli(["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir], {
    checkOpenPrs: PASS,
  });
  const moves = [];
  await runCli(
    ["reconcile", "--write", "--decls-dir", dir, "--states-file", statesFile, "--config", configFixture(), "--json"],
    {
      applyCorrection: applyCorrectionDone,
      checkOpenPrs: () => ({ ok: false, prs: [{ number: 101, state: "OPEN" }] }),
      emitDoneApplied: (f) => moves.push(f),
    }
  );
  expect(moves).toHaveLength(1);
  expect(moves[0].openPrsAtDone).toBe(1); // >0 = the red-line
});

test("DECLARE done-applied: the agent's own Done carries its PR-2 tallies (by=recovery-pass)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const moves = [];
  const { code } = await runCli(
    [
      "declare", "CTL-9", "--by", "recovery-pass", "--state", "done", "--no-write",
      "--prs-closed", "2", "--prs-kept", "1", "--open-prs-at-done", "0",
      "--decls-dir", dir,
    ],
    { emitDoneApplied: (f) => moves.push(f), checkOpenPrs: PASS }
  );
  expect(code).toBe(0);
  expect(moves).toHaveLength(1);
  expect(moves[0]).toMatchObject({
    ticket: "CTL-9",
    by: "recovery-pass",
    prsClosed: 2,
    prsKept: 1,
    openPrsAtDone: 0,
    // --no-write ⇒ no actual Done write yet ⇒ shadow/would-apply telemetry
    recoveryMode: "shadow",
  });
});

test("DECLARE done-applied: a pipeline record-only marker (--by pipeline --no-write) emits an ENFORCE done-applied, never a shadow would-event", async () => {
  // CTL-1157 GROUP 1 (observable teardown Done): phase-teardown records durable
  // completion with `declare --state done --by pipeline --no-write` AFTER it has
  // ALREADY performed the real Linear Done (via linear-transition.sh, no telemetry).
  // That --no-write is the RECORD OF A REAL EXTERNAL DONE, NOT a shadow — it must
  // emit recovery.done-applied in ENFORCE mode (so the normal-pipeline teardown Done
  // is observable, not SILENT), and must NOT emit the recovery.would-done-applied
  // shadow variant (Codex round-1 #7).
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const moves = [];
  const { code } = await runCli(
    [
      "declare", "CTL-9", "--by", "pipeline", "--state", "done", "--no-write",
      "--transition-verified", "--decls-dir", dir,
    ],
    { emitDoneApplied: (f) => moves.push(f), checkOpenPrs: PASS }
  );
  expect(code).toBe(0);
  expect(moves).toHaveLength(1); // the teardown Done is observable — not silent
  expect(moves[0]).toMatchObject({
    ticket: "CTL-9",
    by: "pipeline",
    openPrsAtDone: 0,
    prsClosed: 0,
    prsKept: 0,
    // the real Done ALREADY landed externally ⇒ enforce, NOT a shadow would-event
    recoveryMode: "enforce",
  });
});

test("DECLARE done-applied: a pipeline marker WITHOUT --transition-verified (failed/missing real Done) emits a SHADOW would-event, never an enforce Done-move or alarm", async () => {
  // CTL-1157 F #3 (Codex round-4): phase-teardown drops the `--by pipeline --no-write`
  // marker EVEN when linear-transition.sh failed or was missing (SKILL.md runs it with
  // `|| true`). Without --transition-verified we must NOT report an applied Done that
  // never landed — no enforce done-applied, no open-PR alarm. It degrades to the shadow
  // would-event so the reconcile drain / terminalDoneOnce backstop lands the real Done.
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const moves = [];
  const alarms = [];
  const openPrCalls = [];
  const { code } = await runCli(
    [
      "declare", "CTL-9", "--by", "pipeline", "--state", "done", "--no-write",
      "--decls-dir", dir,
    ],
    {
      emitDoneApplied: (f) => moves.push(f),
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
      checkOpenPrs: (...a) => { openPrCalls.push(a); return PASS(...a); },
    }
  );
  expect(code).toBe(0);
  // still observable — but as a SHADOW would-event, not an enforce Done-move.
  expect(moves).toHaveLength(1);
  expect(moves[0]).toMatchObject({ ticket: "CTL-9", recoveryMode: "shadow" });
  // no open-PR enumeration + NO alarm on the unverified path (it never claims a Done).
  expect(alarms).toEqual([]);
  expect(openPrCalls).toEqual([]);
});

test("DECLARE (GROUP 1): a pipeline record-only Done WITH an open PR is observable + alarmed — not silent", async () => {
  // The Problem-A regression: real teardown Done (external) → pipeline record-only
  // marker → later terminal-sweep sees already-Done → skipped. WITHOUT this fix the
  // teardown Done with an open PR emitted NEITHER done-applied NOR the open-PR alarm.
  // Now the record-only marker enumerates open PRs itself and fires both.
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const moves = [];
  const alarms = [];
  const { code } = await runCli(
    [
      "declare", "CTL-9", "--by", "pipeline", "--state", "done", "--no-write",
      "--transition-verified", "--decls-dir", dir,
    ],
    {
      emitDoneApplied: (f) => moves.push(f),
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
      checkOpenPrs: () => ({ ok: false, prs: [{ number: 202, state: "OPEN", isDraft: false }] }),
    }
  );
  expect(code).toBe(0);
  // done-applied fires (enforce) carrying the red-line open count
  expect(moves).toHaveLength(1);
  expect(moves[0]).toMatchObject({ ticket: "CTL-9", recoveryMode: "enforce", openPrsAtDone: 1 });
  // and the loud recovery.done-applied-with-open-pr alarm fires
  expect(alarms).toHaveLength(1);
  expect(alarms[0]).toMatchObject({ ticket: "CTL-9", by: "pipeline-teardown", unverifiable: false });
  expect(alarms[0].openPrs.map((p) => p.number)).toEqual([202]);
});

test("DECLARE (GROUP 1): a pipeline record-only Done with an UNVERIFIABLE open-PR check still alarms (unverifiable ≠ clean)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const moves = [];
  const alarms = [];
  const { code } = await runCli(
    [
      "declare", "CTL-9", "--by", "pipeline", "--state", "done", "--no-write",
      "--transition-verified", "--decls-dir", dir,
    ],
    {
      emitDoneApplied: (f) => moves.push(f),
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
      checkOpenPrs: () => ({ ok: false, unverifiable: true, reason: "repo-underivable", prs: [] }),
    }
  );
  expect(code).toBe(0);
  expect(moves).toHaveLength(1); // still observable
  expect(moves[0].openPrsAtDone).toBe(0);
  expect(alarms).toHaveLength(1); // unverifiable ⇒ surfaced, not silently assumed clean
  expect(alarms[0]).toMatchObject({ ticket: "CTL-9", by: "pipeline-teardown", unverifiable: true });
});

test("DECLARE (GROUP 1): a CLEAN pipeline record-only Done emits done-applied but NO alarm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const moves = [];
  const alarms = [];
  const { code } = await runCli(
    [
      "declare", "CTL-9", "--by", "pipeline", "--state", "done", "--no-write",
      "--transition-verified", "--decls-dir", dir,
    ],
    {
      emitDoneApplied: (f) => moves.push(f),
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
      checkOpenPrs: PASS, // verifiably clean
    }
  );
  expect(code).toBe(0);
  expect(moves).toHaveLength(1); // observable
  expect(alarms).toEqual([]); // clean, confirmed Done is silent
});

test("DECLARE done-applied: --no-emit suppresses the move event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const moves = [];
  await runCli(
    ["declare", "CTL-9", "--by", "recovery-pass", "--no-write", "--no-emit", "--decls-dir", dir],
    { emitDoneApplied: (f) => moves.push(f), checkOpenPrs: PASS }
  );
  expect(moves).toEqual([]);
});

test("DRAIN: an idempotent already-Done write (writeAction=skipped) emits NO alarm", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const statesFile = join(dir, "states.json");
  // Current state is already past target in a way that yields an applied:skipped write.
  writeFileSync(statesFile, JSON.stringify({ "CTL-9": "Implement" }));
  await runCli(["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir], {
    checkOpenPrs: PASS,
  });
  const alarms = [];
  const applyCorrectionNoop = ({ ticket, target }) => ({
    applied: true,
    action: "skipped", // idempotent: already Done before this drain
    to_state: target,
    ticket,
  });
  await runCli(
    [
      "reconcile",
      "--write",
      "--decls-dir",
      dir,
      "--states-file",
      statesFile,
      "--config",
      configFixture(),
      "--json",
    ],
    {
      applyCorrection: applyCorrectionNoop,
      checkOpenPrs: () => ({ ok: false, prs: [{ number: 7, state: "OPEN" }] }),
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
    }
  );
  expect(alarms).toEqual([]); // not a real transition ⇒ no alarm
});

test("DRAIN: a dry-run reconcile never alarms (no write landed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const statesFile = join(dir, "states.json");
  writeFileSync(statesFile, JSON.stringify({ "CTL-9": "Implement" }));
  await runCli(["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir], {
    checkOpenPrs: PASS,
  });
  const alarms = [];
  await runCli(
    ["reconcile", "--decls-dir", dir, "--states-file", statesFile, "--config", configFixture(), "--json"],
    {
      checkOpenPrs: () => ({ ok: false, prs: [{ number: 9, state: "OPEN" }] }),
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
    }
  );
  expect(alarms).toEqual([]); // dry-run wrote nothing
});

test("UNIVERSAL: a NON-done target (--state canceled) is never alarmed by the drain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const statesFile = join(dir, "states.json");
  writeFileSync(statesFile, JSON.stringify({ "CTL-9": "Implement" }));
  await runCli(
    ["declare", "CTL-9", "--state", "canceled", "--no-write", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs: PASS }
  );
  const alarms = [];
  await runCli(
    [
      "reconcile",
      "--write",
      "--decls-dir",
      dir,
      "--states-file",
      statesFile,
      "--config",
      configFixture(),
      "--json",
    ],
    {
      applyCorrection: applyCorrectionDone,
      checkOpenPrs: () => ({ ok: false, prs: [{ number: 7, state: "OPEN" }] }),
      emitDoneWithOpenPr: (ev) => alarms.push(ev),
    }
  );
  expect(alarms).toEqual([]); // kind!=="done" ⇒ never alarmed
});

// ── Enumerator (open-pr-gate): FACTS, three discovery passes ──────────────────

test("ENUMERATOR: a non-standard-branch open PR (title omits the ticket key) is caught via the branchName head pass", () => {
  // The ticket-key SEARCH pass returns nothing (the PR title/body never mention
  // CTL-9), but the HEAD pass on the derived branchName finds the open PR. Inject
  // both gh + branch-derivation seams so the union logic is exercised hermetically.
  const calls = [];
  const runGh = (args) => {
    calls.push(args);
    if (args.includes("--search")) return []; // key-search misses the non-standard PR
    if (args.includes("--head")) return [{ number: 555, state: "OPEN", isDraft: false, title: "random title" }];
    return [];
  };
  const deriveBranchName = () => "ryan/some-unconventional-branch";
  const r = defaultCheckOpenPrs("CTL-9", {
    runGh,
    deriveBranchName,
    deriveAttachmentPrs: () => [],
  });
  expect(r.ok).toBe(false);
  expect(r.prs.map((p) => p.number)).toEqual([555]);
  expect(r.branchName).toBe("ryan/some-unconventional-branch");
  // The head pass ran with the replica-derived branch (proves the ALWAYS-derive path).
  expect(calls.some((a) => a.includes("--head") && a.includes("ryan/some-unconventional-branch"))).toBe(true);
});

test("ENUMERATOR (slice 4): a PR with no key + non-standard branch but a Linear attachment is caught via the attachment pass", () => {
  // Search misses (no key in text); head pass misses (no branch). The PR is only
  // discoverable through Linear's own attachment — gh pr view confirms it OPEN.
  const viewed = [];
  const runGh = (args) => {
    if (args.includes("list") && args.includes("--search")) return [];
    if (args.includes("list") && args.includes("--head")) return [];
    if (args.includes("view")) {
      viewed.push(args);
      return { number: 808, state: "OPEN", isDraft: false, title: "attachment-linked" };
    }
    return [];
  };
  const r = defaultCheckOpenPrs("CTL-9", {
    runGh,
    deriveBranchName: () => null,
    deriveAttachmentPrs: () => [808],
  });
  expect(r.ok).toBe(false);
  expect(r.prs.map((p) => p.number)).toEqual([808]);
  expect(viewed.some((a) => a.includes("808"))).toBe(true);
});

test("ENUMERATOR (slice 4): a MERGED attachment PR does not count (gh pr view reports non-OPEN)", () => {
  const runGh = (args) => {
    if (args.includes("list")) return [];
    if (args.includes("view")) return { number: 808, state: "MERGED", isDraft: false };
    return [];
  };
  const r = defaultCheckOpenPrs("CTL-9", {
    runGh,
    deriveBranchName: () => null,
    deriveAttachmentPrs: () => [808],
  });
  expect(r.ok).toBe(true); // merged attachment ⇒ no open PR
  expect(r.prs).toEqual([]);
});

// CTL-1157 (GROUP-3 #1): an attached OPEN PR that lives in a DIFFERENT repo than the
// ticket's project repo must be `gh pr view`'d against ITS OWN repo (-R owner/repo).
// The ticket-repo passes see nothing (or a same-numbered UNRELATED PR); collapsing the
// attachment to the ticket repo would check #808 in the wrong repo → report it
// closed/absent → a FALSE clean. -R org/other confirms it OPEN.
test("ENUMERATOR (CTL-1157 GROUP-3 #1): a cross-repo attachment PR is viewed with -R against its OWN repo", () => {
  const viewed = [];
  const runGh = (args) => {
    if (args.includes("list")) return []; // ticket-repo search + head find nothing
    if (args.includes("view")) {
      viewed.push(args);
      return { number: 808, state: "OPEN", isDraft: false, title: "cross-repo open PR" };
    }
    return [];
  };
  const r = defaultCheckOpenPrs("CTL-9", {
    runGh,
    deriveBranchName: () => null,
    deriveAttachmentPrs: () => [{ owner: "org", repo: "other", number: 808 }],
  });
  expect(r.ok).toBe(false); // the open cross-repo PR is caught, not falsely clean
  expect(r.prs.map((p) => p.number)).toEqual([808]);
  // The view targeted the attachment's OWN repo, not the ticket repo cwd.
  const viewCall = viewed.find((a) => a.includes("808"));
  expect(viewCall).toBeTruthy();
  const rIdx = viewCall.indexOf("-R");
  expect(rIdx).toBeGreaterThan(-1);
  expect(viewCall[rIdx + 1]).toBe("org/other");
  // The resolving repo is annotated on the returned PR (composite-key disambiguation).
  expect(r.prs[0].repo).toBe("org/other");
});

// CTL-1157 (GROUP-3 #1): a cross-repo attachment (#808 in org/other) is NOT deduped
// against a same-numbered OPEN PR the ticket-repo passes already found — they are
// DISTINCT PRs. Both are reported (keyed by repo#number vs bare number).
test("ENUMERATOR (CTL-1157 GROUP-3 #1): a cross-repo attachment is not collapsed onto a same-numbered ticket-repo PR", () => {
  const runGh = (args) => {
    // The ticket-repo key-search already found #808 (a DIFFERENT PR that happens to
    // share the number).
    if (args.includes("list") && args.includes("--search"))
      return [{ number: 808, state: "OPEN", isDraft: false, title: "ticket-repo #808" }];
    if (args.includes("list")) return [];
    // -R org/other resolves the cross-repo attachment (also #808, but distinct).
    if (args.includes("view")) return { number: 808, state: "OPEN", isDraft: false, title: "org/other #808" };
    return [];
  };
  const r = defaultCheckOpenPrs("CTL-9", {
    runGh,
    deriveBranchName: () => null,
    deriveAttachmentPrs: () => [{ owner: "org", repo: "other", number: 808 }],
  });
  expect(r.ok).toBe(false);
  // Both the ticket-repo #808 and the cross-repo org/other#808 are present — the
  // composite key kept them distinct instead of hiding the orphaned open PR.
  expect(r.prs.length).toBe(2);
});

// CTL-1157 (GROUP-3 #1): defaultDeriveAttachmentPrs preserves each attachment's OWN
// (owner/repo, number) from a full GitHub PR URL, and yields {owner:null,repo:null}
// for a bare numeric attachment.
test("ENUMERATOR (CTL-1157 GROUP-3 #1): defaultDeriveAttachmentPrs parses owner/repo/number from the URL", () => {
  const rec = {
    attachments: {
      nodes: [
        { url: "https://github.com/org/other/pull/808" },
        { sourceUrl: "https://github.com/coalesce-labs/catalyst/pull/42" },
        1234, // bare number → ticket repo (owner/repo null)
      ],
    },
  };
  const out = defaultDeriveAttachmentPrs("CTL-9", { read: () => rec });
  expect(out).toEqual([
    { owner: "org", repo: "other", number: 808 },
    { owner: "coalesce-labs", repo: "catalyst", number: 42 },
    { owner: null, repo: null, number: 1234 },
  ]);
});

// CTL-1157 (GROUP-3 #1): a bare-number attachment (no recorded repo URL) keeps the
// legacy behavior — viewed in the ticket-repo cwd with NO -R.
test("ENUMERATOR (CTL-1157 GROUP-3 #1): a bare-number attachment is viewed WITHOUT -R (ticket repo)", () => {
  const viewed = [];
  const runGh = (args) => {
    if (args.includes("list")) return [];
    if (args.includes("view")) {
      viewed.push(args);
      return { number: 808, state: "OPEN", isDraft: false };
    }
    return [];
  };
  const r = defaultCheckOpenPrs("CTL-9", {
    runGh,
    deriveBranchName: () => null,
    deriveAttachmentPrs: () => [808],
  });
  expect(r.ok).toBe(false);
  expect(r.prs.map((p) => p.number)).toEqual([808]);
  const viewCall = viewed.find((a) => a.includes("808"));
  expect(viewCall.includes("-R")).toBe(false);
});

test("ENUMERATOR: reports unverifiable (ok:false, reason) when `gh` list is unavailable", () => {
  // No gh binary on a clean PATH ⇒ spawnSync errors ⇒ the list pass throws ⇒ the
  // enumeration is unverifiable. (Callers no longer refuse on this — they proceed.)
  // deriveBranchName/attachment stubbed so the test stays hermetic (no spawn).
  const r = defaultCheckOpenPrs("CTL-9", {
    cwd: tmpdir(),
    deriveBranchName: () => null,
    deriveAttachmentPrs: () => [],
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBeTruthy();
  expect(r.unverifiable).toBe(true); // an unparseable/failed authoritative check is unverifiable
});

// CTL-1157 (Codex GROUP-A fix #1): an attachment-discovered PR we KNOW exists but
// cannot `gh pr view` (transient GitHub/auth/rate-limit) makes the WHOLE
// enumeration unverifiable — it must NOT be silently dropped into a clean empty
// list, which would let a backstop mark Done with no alarm on an unverified check.
test("ENUMERATOR (CTL-1157): an attachment `gh pr view` FAILURE → UNVERIFIABLE, never a clean empty list", () => {
  const runGh = (args) => {
    if (args.includes("list")) return []; // search + head passes find nothing
    if (args.includes("view")) throw new Error("gh: API rate limit exceeded");
    return [];
  };
  const r = defaultCheckOpenPrs("CTL-9", {
    runGh,
    deriveBranchName: () => null,
    deriveAttachmentPrs: () => [808], // Linear says #808 is attached
  });
  expect(r.ok).toBe(false);
  expect(r.unverifiable).toBe(true);
  expect(r.reason).toMatch(/808/); // names the attachment PR it could not view
});

// CTL-1157 (Codex GROUP-A fix #2): when we must spawn REAL gh (no runGh seam) but
// cannot derive the ticket's repo, the check is UNVERIFIABLE — we refuse to run gh
// in the daemon's cwd (which would falsely report zero open PRs for a multi-repo
// ticket). The repo is derived from the registry/config, NEVER bare linearis.
test("ENUMERATOR (CTL-1157): an UNDERIVABLE repo is UNVERIFIABLE (never runs gh in the wrong repo)", () => {
  const r = defaultCheckOpenPrs("CTL-9", {
    deriveRepoRoot: () => null, // registry has no entry for this ticket's team
    deriveBranchName: () => null,
    deriveAttachmentPrs: () => [],
  });
  expect(r.ok).toBe(false);
  expect(r.unverifiable).toBe(true);
  expect(r.reason).toBe("repo-underivable");
});
