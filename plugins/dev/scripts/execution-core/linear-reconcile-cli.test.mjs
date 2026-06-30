import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, main, defaultCheckOpenPrs } from "./linear-reconcile-cli.mjs";
import { readDeclaration, listDeclarations } from "./linear-reconcile-store.mjs";

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
  const { code, out } = await runCli([
    "declare",
    "CTL-9",
    "--no-write",
    "--no-emit",
    "--decls-dir",
    dir,
  ]);
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
  await runCli(["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir]);
  const { code, out } = await runCli(["status", "--json", "--decls-dir", dir]);
  expect(code).toBe(0);
  expect(JSON.parse(out).pending.map((x) => x.ticket)).toEqual(["CTL-9"]);
});

// ── reconcile (dry-run drain over fixtures) ──────────────────────────────────

test("reconcile --json drains pending → reports drift, writes nothing, exit 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  const statesFile = join(dir, "states.json");
  writeFileSync(statesFile, JSON.stringify({ "CTL-9": "Implement" }));
  await runCli(["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir]);

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
  await runCli(["declare", "CTL-9", "--no-write", "--no-emit", "--decls-dir", dir]);
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

// ── H1 open-PR gate (CTL-1157) ────────────────────────────────────────────────
// The recovery-pass delegate must be unable to declare Done while any PR for the
// ticket is still open. The gate is keyed on `--by recovery-pass` (not an opt-in
// flag), runs BEFORE any durable marker is persisted, and is fail-closed.

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

test("teardown/CTL-1371 callers are UNAFFECTED — no gate runs without recovery-pass or the flag", async () => {
  const dir = mkdtempSync(join(tmpdir(), "decl-"));
  let called = 0;
  const checkOpenPrs = () => {
    called++;
    return { ok: false, prs: [{ number: 1, state: "OPEN" }] };
  };
  // `--by teardown` (and the default `model`) must NOT trigger the gate even when
  // an open PR exists — these completion-signal callers keep today's behavior.
  for (const by of ["teardown", "model"]) {
    const { code, out } = await runCli(
      ["declare", "CTL-9", "--by", by, "--no-write", "--no-emit", "--decls-dir", dir],
      { checkOpenPrs }
    );
    expect(code).toBe(0);
    expect(out).toContain("declared (no write)");
  }
  expect(called).toBe(0); // the gate function was never even consulted
});

test("defaultCheckOpenPrs is fail-closed when `gh` is unavailable", () => {
  // No gh binary on a clean PATH ⇒ spawnSync errors ⇒ the gate refuses (ok:false).
  const r = defaultCheckOpenPrs("CTL-9", { cwd: tmpdir() });
  expect(r.ok).toBe(false);
});
