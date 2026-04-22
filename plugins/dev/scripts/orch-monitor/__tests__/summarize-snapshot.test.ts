import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildSummarizeSnapshot,
  isSafeOrchId,
} from "../lib/summarize/snapshot";

describe("buildSummarizeSnapshot", () => {
  let tmp: string;
  let orchDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "summarize-snapshot-"));
    orchDir = join(tmp, "orch-test");
    mkdirSync(orchDir, { recursive: true });
    mkdirSync(join(orchDir, "workers"), { recursive: true });
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({
        orchestrator: "orch-test",
        startedAt: "2026-04-22T12:00:00Z",
        waves: [{ wave: 1, status: "in_progress", tickets: ["CTL-1"] }],
        currentWave: 1,
        totalWaves: 1,
      }),
    );
    writeFileSync(
      join(orchDir, "workers", "CTL-1.json"),
      JSON.stringify({
        ticket: "CTL-1",
        orchestrator: "orch-test",
        status: "researching",
        phase: 1,
        startedAt: "2026-04-22T12:01:00Z",
        updatedAt: "2026-04-22T12:01:00Z",
      }),
    );
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns null when orchestrator directory does not exist", () => {
    const snap = buildSummarizeSnapshot(tmp, "nonexistent-orch");
    expect(snap).toBeNull();
  });

  it("rejects path-traversal orchId", () => {
    const snap = buildSummarizeSnapshot(tmp, "../../etc");
    expect(snap).toBeNull();
  });

  it("rejects orchId with slashes", () => {
    const snap = buildSummarizeSnapshot(tmp, "foo/bar");
    expect(snap).toBeNull();
  });

  it("builds snapshot with state and workers", () => {
    const snap = buildSummarizeSnapshot(tmp, "orch-test");
    expect(snap).not.toBeNull();
    expect(snap!.orchId).toBe("orch-test");
    expect(snap!.workers["CTL-1"]).toBeDefined();
    expect(snap!.snapshotHash.length).toBeGreaterThan(0);
  });

  it("includes SUMMARY.md when present", () => {
    writeFileSync(join(orchDir, "SUMMARY.md"), "# Run Summary\nAll good.");
    const snap = buildSummarizeSnapshot(tmp, "orch-test");
    expect(snap!.summaryMd).toContain("All good");
  });

  it("leaves summaryMd null when SUMMARY.md absent", () => {
    const snap = buildSummarizeSnapshot(tmp, "orch-test");
    expect(snap!.summaryMd).toBeNull();
  });

  it("includes briefings from wave-N-briefing.md files", () => {
    writeFileSync(
      join(orchDir, "wave-1-briefing.md"),
      "# Wave 1\nBrief content.",
    );
    const snap = buildSummarizeSnapshot(tmp, "orch-test");
    expect(snap!.briefings[1]).toContain("Brief content");
  });

  it("produces stable hash for identical inputs", () => {
    const a = buildSummarizeSnapshot(tmp, "orch-test");
    const b = buildSummarizeSnapshot(tmp, "orch-test");
    expect(a!.snapshotHash).toBe(b!.snapshotHash);
  });

  it("isSafeOrchId accepts and rejects the right shapes", () => {
    expect(isSafeOrchId("orch-2026-04-22-3")).toBe(true);
    expect(isSafeOrchId("orch_test.123")).toBe(true);
    expect(isSafeOrchId("")).toBe(false);
    expect(isSafeOrchId("..")).toBe(false);
    expect(isSafeOrchId("../etc")).toBe(false);
    expect(isSafeOrchId("a/b")).toBe(false);
    expect(isSafeOrchId("a\\b")).toBe(false);
    expect(isSafeOrchId("a".repeat(121))).toBe(false);
  });

  it("produces different hash when state changes", () => {
    const a = buildSummarizeSnapshot(tmp, "orch-test");
    writeFileSync(
      join(orchDir, "workers", "CTL-1.json"),
      JSON.stringify({
        ticket: "CTL-1",
        orchestrator: "orch-test",
        status: "done",
        phase: 5,
        startedAt: "2026-04-22T12:01:00Z",
        updatedAt: "2026-04-22T12:05:00Z",
      }),
    );
    const b = buildSummarizeSnapshot(tmp, "orch-test");
    expect(a!.snapshotHash).not.toBe(b!.snapshotHash);
  });
});
