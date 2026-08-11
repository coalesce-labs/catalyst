import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  RECOVERY_LEAVE_ALONE_TTL_MS,
  recoveryIntentPath,
  leaveAloneSuppression,
} from "./recovery-intent-ledger.mjs";

let orchDir;
beforeEach(() => {
  orchDir = mkdtempSync(join(tmpdir(), "cat44-ledger-"));
  mkdirSync(join(orchDir, ".recovery-intents"), { recursive: true });
});
afterEach(() => rmSync(orchDir, { recursive: true, force: true }));
const write = (ticket, entry) =>
  writeFileSync(recoveryIntentPath(orchDir, ticket), JSON.stringify(entry));

describe("leaveAloneSuppression", () => {
  const t0 = 1_700_000_000_000;
  it("uses the shared path", () => expect(recoveryIntentPath("/o", "CAT-1")).toBe("/o/.recovery-intents/CAT-1.json"));
  it("suppresses a fresh verdict and reports its age and reason", () => {
    write("CAT-1", { verdict: "leave-alone", verdictTs: t0, verdictReason: "healthy" });
    expect(leaveAloneSuppression("CAT-1", { orchDir, now: () => t0 + 1000 })).toEqual({
      suppressed: true, ageMs: 1000, verdictTs: t0, verdictReason: "healthy",
    });
  });
  it("uses a strict TTL boundary", () => {
    write("CAT-1", { verdict: "leave-alone", verdictTs: t0 });
    expect(leaveAloneSuppression("CAT-1", { orchDir, now: () => t0 + RECOVERY_LEAVE_ALONE_TTL_MS })).toBeNull();
    expect(leaveAloneSuppression("CAT-1", { orchDir, now: () => t0 + RECOVERY_LEAVE_ALONE_TTL_MS - 1 })?.suppressed).toBe(true);
  });
  it.each([
    ["absent", "CAT-x", null],
    ["non-verdict", "CAT-2", { verdict: "escalate", verdictTs: t0 }],
    ["decision only", "CAT-3", { decision: "leave-alone", lastTs: t0 }],
    ["timestamp-less", "CAT-4", { verdict: "leave-alone", verdictTs: null }],
    ["expired", "CAT-5", { verdict: "leave-alone", verdictTs: t0 - RECOVERY_LEAVE_ALONE_TTL_MS - 1 }],
    ["future-skew", "CAT-6", { verdict: "leave-alone", verdictTs: t0 + 1 }],
    // Codex #3217 P2: an escalated ticket is human-owned. `recordVerdict` keeps the
    // sticky `escalated` latch when a later leave-alone verdict lands (see
    // recovery-reasoning.test.mjs "escalated latch takes precedence over a later
    // leave-alone decision"), and defaultSkipReason gives that 7-day latch
    // precedence over the shorter leave-alone TTL. Suppressing here would hide a
    // still-human-owned ticket from the operator sweep for up to 24h.
    ["escalated latch", "CAT-7", { verdict: "leave-alone", verdictTs: t0, escalated: true }],
  ])("fails open for %s", (_name, ticket, entry) => {
    if (entry) write(ticket, entry);
    expect(leaveAloneSuppression(ticket, { orchDir, now: () => t0 })).toBeNull();
  });
  it("fails open for malformed JSON and missing orchDir", () => {
    writeFileSync(recoveryIntentPath(orchDir, "CAT-bad"), "{not json");
    expect(leaveAloneSuppression("CAT-bad", { orchDir, now: () => t0 })).toBeNull();
    expect(leaveAloneSuppression("CAT-1", { orchDir: "", now: () => t0 })).toBeNull();
  });
  it("keys on verdictTs and verdict, not decision or lastTs", () => {
    write("CAT-mk", { decision: "defer", verdict: "leave-alone", verdictTs: t0, lastTs: t0 + 60_000 });
    expect(leaveAloneSuppression("CAT-mk", { orchDir, now: () => t0 + 120_000 })?.ageMs).toBe(120_000);
  });
});

describe("single source of truth", () => {
  it("recovery-reasoning re-exports the leaf TTL", async () => {
    const leaf = await import("./recovery-intent-ledger.mjs");
    const reasoning = await import("./recovery-reasoning.mjs");
    expect(reasoning.RECOVERY_LEAVE_ALONE_TTL_MS).toBe(leaf.RECOVERY_LEAVE_ALONE_TTL_MS);
  });
  it("imports under plain node", () => {
    const out = execFileSync("node", ["-e", 'import("./recovery-intent-ledger.mjs").then(m=>console.log(typeof m.leaveAloneSuppression))'], { cwd: import.meta.dir, encoding: "utf8" });
    expect(out.trim()).toBe("function");
  });
});
