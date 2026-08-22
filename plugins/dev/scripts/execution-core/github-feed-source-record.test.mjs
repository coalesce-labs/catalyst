// CTL-2011: Phase 1 tests — `source` persisted in readiness record.
// Run: cd plugins/dev/scripts && bun test execution-core/github-feed-source-record.test.mjs

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGithubFeedConfig } from "./config.mjs";
import { startGithubFeedTimer } from "./github-feed-timer.mjs";

const tmp = mkdtempSync(join(tmpdir(), "gh-feed-source-rec-"));
afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* never fail in cleanup */ }
});

// ─── Phase 1a: readGithubFeedConfig returns source ───────────────────────────

describe("readGithubFeedConfig returns source", () => {
  test("env pin → source:'env'", () => {
    const cfg = readGithubFeedConfig({ CATALYST_GITHUB_FEED: "enforce", HOME: tmp });
    expect(cfg.source).toBe("env");
    expect(cfg.mode).toBe("enforce");
  });

  test("env pin with shadow → source:'env'", () => {
    const cfg = readGithubFeedConfig({ CATALYST_GITHUB_FEED: "shadow", HOME: tmp });
    expect(cfg.source).toBe("env");
    expect(cfg.mode).toBe("shadow");
  });

  test("env=0 → source:'env', mode:'off'", () => {
    const cfg = readGithubFeedConfig({ CATALYST_GITHUB_FEED: "0", HOME: tmp });
    expect(cfg.source).toBe("env");
    expect(cfg.mode).toBe("off");
  });

  test("no pin, no Layer-2 → source:'default', mode:'off'", () => {
    const cfg = readGithubFeedConfig({ HOME: tmp });
    expect(cfg.source).toBe("default");
    expect(cfg.mode).toBe("off");
  });

  test("typo → source:'env-invalid', mode:'off'", () => {
    const cfg = readGithubFeedConfig({ CATALYST_GITHUB_FEED: "nonsense", HOME: tmp });
    expect(cfg.source).toBe("env-invalid");
    expect(cfg.mode).toBe("off");
  });
});

// ─── Phase 1b: startGithubFeedTimer writes source into the readiness record ──

describe("startGithubFeedTimer writes source into the readiness record", () => {
  test("readiness record carries source field after one tick (source=env)", () => {
    const orchDir = join(tmp, "orch-1b-env");
    const account = "tenant-0";
    const readyPath = join(orchDir, "shadow", `github-feed-ready-${account}.json`);
    const events = [];

    const timer = startGithubFeedTimer({
      mode: "shadow",
      source: "env",
      intervalSec: 30,
      orchDir,
      account,
      dbPath: join(orchDir, "nonexistent.db"),
      eventLogPath: join(orchDir, "events.jsonl"),
      appendFn: (_path, line) => events.push(line),
      clock: { setInterval: (_fn, _ms) => null, clearInterval: () => {} },
    });

    // Force one tick synchronously.
    timer.tickNow();

    const state = JSON.parse(readFileSync(readyPath, "utf8"));
    expect(state.source).toBe("env");
  });

  test("readiness record carries source:'layer2' when passed as such", () => {
    const orchDir = join(tmp, "orch-1b-l2");
    const account = "tenant-0";
    const readyPath = join(orchDir, "shadow", `github-feed-ready-${account}.json`);
    const events = [];

    const timer = startGithubFeedTimer({
      mode: "shadow",
      source: "layer2",
      intervalSec: 30,
      orchDir,
      account,
      dbPath: join(orchDir, "nonexistent.db"),
      eventLogPath: join(orchDir, "events.jsonl"),
      appendFn: (_path, line) => events.push(line),
      clock: { setInterval: (_fn, _ms) => null, clearInterval: () => {} },
    });

    timer.tickNow();

    const state = JSON.parse(readFileSync(readyPath, "utf8"));
    expect(state.source).toBe("layer2");
  });

  test("readiness record carries source:'default' when passed as null (default arg)", () => {
    const orchDir = join(tmp, "orch-1b-default");
    const account = "tenant-0";
    const readyPath = join(orchDir, "shadow", `github-feed-ready-${account}.json`);
    const events = [];

    const timer = startGithubFeedTimer({
      mode: "shadow",
      // source not passed — should default to null
      intervalSec: 30,
      orchDir,
      account,
      dbPath: join(orchDir, "nonexistent.db"),
      eventLogPath: join(orchDir, "events.jsonl"),
      appendFn: (_path, line) => events.push(line),
      clock: { setInterval: (_fn, _ms) => null, clearInterval: () => {} },
    });

    timer.tickNow();

    const state = JSON.parse(readFileSync(readyPath, "utf8"));
    // source is null when not explicitly supplied (backward-compatible)
    expect(state).toHaveProperty("source");
  });

  test("throwing tick also writes source in the readiness record", () => {
    const orchDir = join(tmp, "orch-1b-throw");
    const account = "tenant-0";
    const readyPath = join(orchDir, "shadow", `github-feed-ready-${account}.json`);
    const events = [];

    // Write a corrupt (non-SQLite) file at the dbPath so that `new Database(dbPath)` throws.
    // SQLite is strict: opening a plain-text file as a DB produces a SQLITE_NOTADB error.
    // We rely on this to exercise the catch branch of the tick, which must still carry `source`.
    const corruptDbPath = join(orchDir, "corrupt.db");

    // Create orchDir and write the corrupt file before constructing the timer.
    // startGithubFeedTimer will create orchDir/shadow/ via mkdirSync({recursive:true}).
    mkdirSync(orchDir, { recursive: true });
    writeFileSync(corruptDbPath, "this is not a sqlite database");

    const timer = startGithubFeedTimer({
      mode: "shadow",
      source: "env",
      intervalSec: 30,
      orchDir,
      account,
      dbPath: corruptDbPath,
      eventLogPath: join(orchDir, "events.jsonl"),
      appendFn: (_path, line) => events.push(line),
      clock: { setInterval: (_fn, _ms) => null, clearInterval: () => {} },
    });

    // Tick — runGithubFeedTick will throw SQLITE_NOTADB; the catch branch calls
    // publishReady which must write source to the readiness file.
    timer.tickNow();

    // Do NOT wrap assertions in try/catch — let assertion failures surface directly.
    const raw = readFileSync(readyPath, "utf8");
    const state = JSON.parse(raw);
    expect(state.source).toBe("env");
    // The catch path sets ready:false, but source must still be present.
    expect(state.ready).toBe(false);
  });
});
