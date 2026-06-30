import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, main, defaultCheckOpenPrs } from "./linear-reconcile-cli.mjs";
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
    deriveAttachmentPrNumbers: () => [],
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
    deriveAttachmentPrNumbers: () => [808],
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
    deriveAttachmentPrNumbers: () => [808],
  });
  expect(r.ok).toBe(true); // merged attachment ⇒ no open PR
  expect(r.prs).toEqual([]);
});

test("ENUMERATOR: reports unverifiable (ok:false, reason) when `gh` list is unavailable", () => {
  // No gh binary on a clean PATH ⇒ spawnSync errors ⇒ the list pass throws ⇒ the
  // enumeration is unverifiable. (Callers no longer refuse on this — they proceed.)
  // deriveBranchName/attachment stubbed so the test stays hermetic (no spawn).
  const r = defaultCheckOpenPrs("CTL-9", {
    cwd: tmpdir(),
    deriveBranchName: () => null,
    deriveAttachmentPrNumbers: () => [],
  });
  expect(r.ok).toBe(false);
  expect(r.reason).toBeTruthy();
});
