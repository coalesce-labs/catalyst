// cli/beliefs.test.mjs — CTL-935 remediate: cover the beliefs CLI noun
// dispatcher (cli/beliefs.mjs). This file did not exist, which is exactly why
// the high-severity async-dispatch crash shipped undetected: `beliefs-status`
// delegates to an ASYNC main(), and a sync dispatcher handed the resulting
// Promise to process.exit() → ERR_INVALID_ARG_TYPE on every invocation.
// Run: cd plugins/dev/scripts/execution-core && bun test cli/beliefs.test.mjs

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { main } from "./beliefs.mjs";

const tmps = [];
function scratchDbPath() {
  const d = mkdtempSync(join(tmpdir(), "ctl935-beliefs-cli-"));
  tmps.push(d);
  return join(d, "beliefs.db");
}
afterEach(() => {
  while (tmps.length) {
    try { rmSync(tmps.pop(), { recursive: true, force: true }); } catch { /* */ }
  }
});

// ─── async dispatch (the high-severity regression) ────────────────────────────

describe("async dispatch — main() resolves to a numeric exit code", () => {
  test("beliefs-status resolves to a NUMBER, never a Promise (regression: sync main → process.exit(Promise))", async () => {
    const out = [];
    // Flag off by default → INACTIVE → passed:false → exit 1. The point is the
    // RESOLVED type: before the fix the dispatcher returned a Promise here.
    const code = await main(["beliefs-status"], { out: (s) => out.push(s), env: {} });
    expect(typeof code).toBe("number");
    expect(code).toBe(1);
    // Delegation sanity — shadowStatusMain rendered its status text.
    expect(out.join("\n")).toContain("status:");
  });

  test("beliefs-status --json delegates and still resolves numerically", async () => {
    const out = [];
    const code = await main(["beliefs-status", "--json"], { out: (s) => out.push(s), env: {} });
    expect(typeof code).toBe("number");
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toHaveProperty("status");
    expect(parsed).toHaveProperty("passed");
  });
});

// ─── report verb ──────────────────────────────────────────────────────────────

describe("report verb — delegates to beliefs/report.mjs main()", () => {
  test("report on an empty scratch db resolves to 0 and renders the markdown header", async () => {
    const out = [];
    const env = { CATALYST_BELIEFS_DB: scratchDbPath() };
    const code = await main(["report"], { out: (s) => out.push(s), env });
    expect(typeof code).toBe("number");
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Belief Shadow Disagreement Report");
  });

  test("report --json resolves to 0 and emits parseable JSON", async () => {
    const out = [];
    const env = { CATALYST_BELIEFS_DB: scratchDbPath() };
    const code = await main(["report", "--json"], { out: (s) => out.push(s), env });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n"));
    expect(parsed).toHaveProperty("window");
    expect(parsed).toHaveProperty("perRule");
  });
});

// ─── default / usage branch ───────────────────────────────────────────────────

describe("unknown verb → usage + exit 1", () => {
  test("bogus verb returns 1 and emits the usage banner", async () => {
    const out = [];
    const code = await main(["bogus"], { out: (s) => out.push(s) });
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("usage: catalyst-execution-core beliefs");
  });

  test("no verb at all returns 1 and emits usage", async () => {
    const out = [];
    const code = await main([], { out: (s) => out.push(s) });
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("verbs:");
  });
});
