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

// ── UNIVERSAL open-PR gate (CTL-1157) ─────────────────────────────────────────
// NO declarer may move a ticket to Done while any PR for it is still open. The gate
// is keyed on the TARGET STATE (`--state done`), not the declarer — it fires for
// recovery-pass, pipeline/teardown, the default model, and humans alike. It runs
// BEFORE any durable marker is persisted, and is fail-closed.

test("parseArgs: --require-prs-merged / --branch", () => {
  const a = parseArgs(["declare", "CTL-9", "--require-prs-merged", "--branch", "ryan/ctl-9-x"]);
  expect(a.requirePrsMerged).toBe(true);
  expect(a.branch).toBe("ryan/ctl-9-x");
});

test("H1: recovery-pass Done is REFUSED when a non-standard-branch PR is still open (one merged + one open)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  // The false-Done scenario: #100 already merged, #101 still open on a weird branch.
  // The gate sees the OPEN PR and must refuse — nothing written, nothing persisted.
  const calls = [];
  const checkOpenPrs = (ticket, opts) => {
    calls.push({ ticket, opts });
    return { ok: false, prs: [{ number: 101, state: "OPEN", isDraft: false, title: "wip" }] };
  };
  const { code, err } = await runCli(
    ["declare", "CTL-9", "--by", "recovery-pass", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs }
  );
  expect(code).toBe(2);
  expect(err).toContain("refusing Done declaration");
  expect(err).toContain("#101");
  expect(calls).toHaveLength(1);
  expect(calls[0].ticket).toBe("CTL-9");
  // Fail-closed: NO durable declaration marker is left behind for the drain to land.
  expect(listDeclarations({ dir, pendingOnly: true })).toEqual([]);
});

test("H1: recovery-pass Done is ALLOWED when the ticket's only PR is merged (no open PRs)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  let called = 0;
  const checkOpenPrs = () => {
    called++;
    return { ok: true, prs: [] };
  };
  const { code, out } = await runCli(
    ["declare", "CTL-9", "--by", "recovery-pass", "--no-write", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs }
  );
  expect(code).toBe(0);
  expect(out).toContain("declared (no write)");
  expect(called).toBe(1);
  // Gate cleared ⇒ the declaration proceeds and the durable marker persists.
  const d = readDeclaration("CTL-9", dir);
  expect(d.state).toBe("done");
  expect(listDeclarations({ dir, pendingOnly: true }).map((x) => x.ticket)).toEqual(["CTL-9"]);
});

test("H1: gate is FAIL-CLOSED — an unverifiable PR set (gh failure) refuses the write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const checkOpenPrs = () => ({ ok: false, reason: "`gh pr list` failed: not authenticated", prs: [] });
  const { code, err } = await runCli(
    ["declare", "CTL-9", "--by", "recovery-pass", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs }
  );
  expect(code).toBe(2);
  expect(err).toContain("could not be verified");
  expect(listDeclarations({ dir, pendingOnly: true })).toEqual([]);
});

test("H1: the gate cannot be bypassed via --no-write (refusal happens before the marker is dropped)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const checkOpenPrs = () => ({ ok: false, prs: [{ number: 7, state: "OPEN", isDraft: false }] });
  const { code } = await runCli(
    ["declare", "CTL-9", "--by", "recovery-pass", "--no-write", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs }
  );
  expect(code).toBe(2);
  // No poison marker ⇒ a later `reconcile --write` drain has nothing to land.
  expect(listDeclarations({ dir, pendingOnly: true })).toEqual([]);
});

test("H1: --require-prs-merged opts a non-delegate declarer into the same gate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const checkOpenPrs = () => ({ ok: false, prs: [{ number: 9, state: "OPEN", isDraft: false }] });
  const { code } = await runCli(
    ["declare", "CTL-9", "--by", "model", "--require-prs-merged", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs }
  );
  expect(code).toBe(2);
  expect(listDeclarations({ dir, pendingOnly: true })).toEqual([]);
});

test("UNIVERSAL (a): --by pipeline (teardown) with one merged + one open PR is REFUSED (exit 2, no marker)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  // Teardown's completion-signal path is now gated too: #100 merged, #101 still open.
  const calls = [];
  const checkOpenPrs = (ticket, opts) => {
    calls.push({ ticket, opts });
    return { ok: false, prs: [{ number: 101, state: "OPEN", isDraft: false, title: "wip" }] };
  };
  const { code, err } = await runCli(
    ["declare", "CTL-9", "--by", "pipeline", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs }
  );
  expect(code).toBe(2);
  expect(err).toContain("refusing Done declaration");
  expect(err).toContain("#101");
  expect(calls).toHaveLength(1); // the universal gate WAS consulted for --by pipeline
  // Fail-closed: nothing persisted ⇒ the reconcile drain has nothing to land.
  expect(listDeclarations({ dir, pendingOnly: true })).toEqual([]);
});

test("UNIVERSAL (b): --by pipeline (teardown) with only a MERGED PR is ALLOWED — legitimate completion preserved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  let called = 0;
  const checkOpenPrs = () => {
    called++;
    return { ok: true, prs: [] }; // only-merged ⇒ no open PR
  };
  const { code, out } = await runCli(
    ["declare", "CTL-9", "--by", "pipeline", "--no-write", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs }
  );
  expect(code).toBe(0);
  expect(out).toContain("declared (no write)");
  expect(called).toBe(1);
  expect(readDeclaration("CTL-9", dir).state).toBe("done");
});

test("UNIVERSAL (c): the default --by model with an open PR is REFUSED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const checkOpenPrs = () => ({ ok: false, prs: [{ number: 42, state: "OPEN", isDraft: false }] });
  // No --by ⇒ defaults to model; the gate still fires on --state done.
  const { code, err } = await runCli(
    ["declare", "CTL-9", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs }
  );
  expect(code).toBe(2);
  expect(err).toContain("#42");
  expect(listDeclarations({ dir, pendingOnly: true })).toEqual([]);
});

test("UNIVERSAL: a NON-done target (--state canceled) is NOT gated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  let called = 0;
  const checkOpenPrs = () => {
    called++;
    return { ok: false, prs: [{ number: 7, state: "OPEN" }] };
  };
  const { code } = await runCli(
    ["declare", "CTL-9", "--state", "canceled", "--no-write", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs }
  );
  expect(code).toBe(0);
  expect(called).toBe(0); // canceling is not a completion claim ⇒ gate never consulted
});

test("UNIVERSAL (d): a non-standard-branch open PR (title omits the ticket key) is caught via the branchName head pass", () => {
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
  const r = defaultCheckOpenPrs("CTL-9", { runGh, deriveBranchName });
  expect(r.ok).toBe(false);
  expect(r.prs.map((p) => p.number)).toEqual([555]);
  expect(r.branchName).toBe("ryan/some-unconventional-branch");
  // The head pass ran with the replica-derived branch (proves the ALWAYS-derive path).
  expect(calls.some((a) => a.includes("--head") && a.includes("ryan/some-unconventional-branch"))).toBe(true);
});

test("UNIVERSAL (e): the reconcile drain cannot land a Done while a PR is open (no poison marker to drain)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const checkOpenPrs = () => ({ ok: false, prs: [{ number: 9, state: "OPEN", isDraft: false }] });
  // Step 1: a Done declaration is REFUSED while the PR is open → no marker persists.
  const refused = await runCli(
    ["declare", "CTL-9", "--by", "pipeline", "--no-emit", "--decls-dir", dir],
    { checkOpenPrs }
  );
  expect(refused.code).toBe(2);
  expect(listDeclarations({ dir, pendingOnly: true })).toEqual([]);
  // Step 2: `reconcile --write` over the same store has NOTHING pending → it cannot
  // write Done. The drain is safe by construction: the ONLY producer of a Done
  // marker is the gated declare, which refused above.
  const statesFile = join(dir, "states.json");
  writeFileSync(statesFile, JSON.stringify({ "CTL-9": "Implement" }));
  const { code, out } = await runCli([
    "reconcile",
    "--write",
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
  expect(parsed.summary.tickets).toBe(0); // nothing drained → no Done written
  expect(parsed.rows).toEqual([]);
});

test("defaultCheckOpenPrs is fail-closed when `gh` is unavailable", () => {
  // No gh binary on a clean PATH ⇒ spawnSync errors ⇒ the gate refuses (ok:false).
  // deriveBranchName is stubbed null so the test stays hermetic (no catalyst-linear spawn).
  const r = defaultCheckOpenPrs("CTL-9", { cwd: tmpdir(), deriveBranchName: () => null });
  expect(r.ok).toBe(false);
});
