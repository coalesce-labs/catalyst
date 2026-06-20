// archive-stale-host-workers.test.mjs — unit tests for the ghost-worker archive
// selector (CTL-1093 Phase 3).
// Run: cd plugins/dev/scripts/execution-core && bun test archive-stale-host-workers.test.mjs

import { test, describe, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectStaleHostWorkerDirs, archiveStaleHostWorkerDirs } from "./archive-stale-host-workers.mjs";

const TERMINAL_STATUSES = ["complete", "failed", "skipped"];

function writeSignal(dir, phase, status, hostName) {
  const signal = { ticket: "CTL-TEST", phase, status, host: { name: hostName, id: "x" } };
  writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify(signal));
}

function makeWorkerDir(orchDir, ticket) {
  const d = join(orchDir, "workers", ticket);
  mkdirSync(d, { recursive: true });
  return d;
}

describe("selectStaleHostWorkerDirs", () => {
  let orchDir;
  let archiveRoot;

  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl1093-orch-"));
    archiveRoot = mkdtempSync(join(tmpdir(), "ctl1093-arch-"));
  });

  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
    rmSync(archiveRoot, { recursive: true, force: true });
  });

  test("selects a dir where all phases are terminal and host is non-roster, non-live", () => {
    const d = makeWorkerDir(orchDir, "CTL-GHOST");
    writeSignal(d, "implement", "complete", "Ryans-Mac-mini-250233");
    writeSignal(d, "review", "complete", "Ryans-Mac-mini-250233");

    const result = selectStaleHostWorkerDirs({
      orchDir,
      roster: ["mini"],
      liveHosts: new Set(),
    });
    expect(result.map((r) => r.ticket)).toContain("CTL-GHOST");
  });

  test("excludes a dir whose host is in the roster", () => {
    const d = makeWorkerDir(orchDir, "CTL-LIVE");
    writeSignal(d, "implement", "complete", "mini");

    const result = selectStaleHostWorkerDirs({
      orchDir,
      roster: ["mini"],
      liveHosts: new Set(),
    });
    expect(result.map((r) => r.ticket)).not.toContain("CTL-LIVE");
  });

  test("excludes a dir whose host is currently live (heartbeating)", () => {
    const d = makeWorkerDir(orchDir, "CTL-HEARTBEAT");
    writeSignal(d, "implement", "complete", "old-name");

    const result = selectStaleHostWorkerDirs({
      orchDir,
      roster: ["mini"],
      liveHosts: new Set(["old-name"]),
    });
    expect(result.map((r) => r.ticket)).not.toContain("CTL-HEARTBEAT");
  });

  test("excludes a dir with any running phase", () => {
    const d = makeWorkerDir(orchDir, "CTL-RUNNING");
    writeSignal(d, "implement", "running", "Ryans-Mac-mini-250233");

    const result = selectStaleHostWorkerDirs({
      orchDir,
      roster: ["mini"],
      liveHosts: new Set(),
    });
    expect(result.map((r) => r.ticket)).not.toContain("CTL-RUNNING");
  });

  test("excludes a dir with no phase signal files (not a worker dir)", () => {
    mkdirSync(join(orchDir, "not-a-worker"), { recursive: true });

    const result = selectStaleHostWorkerDirs({
      orchDir,
      roster: ["mini"],
      liveHosts: new Set(),
    });
    expect(result.map((r) => r.ticket)).not.toContain("not-a-worker");
  });

  test("returns empty array when orchDir has no stale dirs", () => {
    makeWorkerDir(orchDir, "CTL-OK");
    // orchDir exists but CTL-OK has no signal files → excluded
    const result = selectStaleHostWorkerDirs({
      orchDir,
      roster: ["mini"],
      liveHosts: new Set(),
    });
    expect(result).toEqual([]);
  });
});

describe("archiveStaleHostWorkerDirs", () => {
  let orchDir;
  let archiveRoot;

  beforeEach(() => {
    orchDir = mkdtempSync(join(tmpdir(), "ctl1093-orch2-"));
    archiveRoot = mkdtempSync(join(tmpdir(), "ctl1093-arch2-"));
  });

  afterEach(() => {
    rmSync(orchDir, { recursive: true, force: true });
    rmSync(archiveRoot, { recursive: true, force: true });
  });

  test("dry-run returns the list without moving anything", () => {
    const d = makeWorkerDir(orchDir, "CTL-GHOST2");
    writeSignal(d, "implement", "complete", "Ryans-Mac-mini-250233");

    const result = archiveStaleHostWorkerDirs({
      orchDir,
      archiveRoot,
      roster: ["mini"],
      liveHosts: new Set(),
      apply: false,
    });

    expect(result.archived).toContain("CTL-GHOST2");
    expect(existsSync(d)).toBe(true); // dry-run: not moved
  });

  test("--apply moves the dir to archiveRoot", () => {
    const d = makeWorkerDir(orchDir, "CTL-GHOST3");
    writeSignal(d, "implement", "complete", "Ryans-Mac-mini-250233");

    const result = archiveStaleHostWorkerDirs({
      orchDir,
      archiveRoot,
      roster: ["mini"],
      liveHosts: new Set(),
      apply: true,
    });

    expect(result.archived).toContain("CTL-GHOST3");
    expect(existsSync(d)).toBe(false); // moved
    expect(existsSync(join(archiveRoot, "CTL-GHOST3"))).toBe(true);
  });

  test("--apply is idempotent: re-running on already-archived dirs returns empty", () => {
    const d = makeWorkerDir(orchDir, "CTL-GHOST4");
    writeSignal(d, "implement", "complete", "Ryans-Mac-mini-250233");

    archiveStaleHostWorkerDirs({
      orchDir, archiveRoot, roster: ["mini"], liveHosts: new Set(), apply: true,
    });
    const second = archiveStaleHostWorkerDirs({
      orchDir, archiveRoot, roster: ["mini"], liveHosts: new Set(), apply: true,
    });
    expect(second.archived).toHaveLength(0);
  });
});
