import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, main } from "./linear-reconcile-cli.mjs";
import { readDeclaration, listDeclarations } from "./linear-reconcile-store.mjs";

async function runCli(argv) {
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
    const code = await main(argv);
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
