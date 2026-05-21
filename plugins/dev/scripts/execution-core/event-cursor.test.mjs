// Unit tests for the durable event-log tailer cursor (CTL-539 Phase 1).
// Run: cd plugins/dev/scripts/execution-core && bun test event-cursor.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCursor, saveCursor, resolveStartOffset } from "./event-cursor.mjs";
import { getCursorPath } from "./config.mjs";

let catalystDir;
let prevCatalystDir;

beforeEach(() => {
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "exec-core-cursor-"));
  process.env.CATALYST_DIR = catalystDir;
});

afterEach(() => {
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  rmSync(catalystDir, { recursive: true, force: true });
});

// --- resolveStartOffset — pure ------------------------------------------

describe("resolveStartOffset", () => {
  test("valid cursor matching logPath, offset <= size → resumes at cursor offset", () => {
    expect(
      resolveStartOffset({
        cursor: { logPath: "/L", byteOffset: 50 },
        logPath: "/L",
        fileSize: 200,
      }),
    ).toBe(50);
  });

  test("cursor offset exactly equal to fileSize → resumes at that offset", () => {
    expect(
      resolveStartOffset({
        cursor: { logPath: "/L", byteOffset: 200 },
        logPath: "/L",
        fileSize: 200,
      }),
    ).toBe(200);
  });

  test("no cursor → seeds at EOF (returns fileSize)", () => {
    expect(
      resolveStartOffset({ cursor: null, logPath: "/L", fileSize: 200 }),
    ).toBe(200);
  });

  test("cursor logPath mismatch (month rollover) → seeds at EOF of current file", () => {
    expect(
      resolveStartOffset({
        cursor: { logPath: "/2026-04.jsonl", byteOffset: 10 },
        logPath: "/2026-05.jsonl",
        fileSize: 200,
      }),
    ).toBe(200);
  });

  test("cursor offset > fileSize (log truncated/rotated) → seeds at EOF", () => {
    expect(
      resolveStartOffset({
        cursor: { logPath: "/L", byteOffset: 9999 },
        logPath: "/L",
        fileSize: 200,
      }),
    ).toBe(200);
  });

  test("cursor offset negative → seeds at EOF", () => {
    expect(
      resolveStartOffset({
        cursor: { logPath: "/L", byteOffset: -1 },
        logPath: "/L",
        fileSize: 200,
      }),
    ).toBe(200);
  });

  test("cursor offset non-integer → seeds at EOF", () => {
    expect(
      resolveStartOffset({
        cursor: { logPath: "/L", byteOffset: 12.5 },
        logPath: "/L",
        fileSize: 200,
      }),
    ).toBe(200);
  });
});

// --- loadCursor / saveCursor — round-trip + durability -----------------

describe("loadCursor / saveCursor", () => {
  test("saveCursor then loadCursor round-trips {logPath, byteOffset}", () => {
    saveCursor({ logPath: "/events/2026-05.jsonl", byteOffset: 1234 });
    expect(loadCursor()).toEqual({
      logPath: "/events/2026-05.jsonl",
      byteOffset: 1234,
    });
  });

  test("loadCursor returns null when no cursor file exists", () => {
    expect(loadCursor()).toBeNull();
  });

  test("loadCursor returns null on a corrupt (non-JSON) cursor file", () => {
    mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
    writeFileSync(getCursorPath(), "{ not json");
    expect(loadCursor()).toBeNull();
  });

  test("loadCursor returns null when the cursor file is missing required keys", () => {
    mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
    writeFileSync(getCursorPath(), JSON.stringify({ logPath: "/L" })); // no byteOffset
    expect(loadCursor()).toBeNull();
    writeFileSync(getCursorPath(), JSON.stringify({ byteOffset: 5 })); // no logPath
    expect(loadCursor()).toBeNull();
  });

  test("loadCursor returns null when byteOffset is not an integer", () => {
    mkdirSync(join(catalystDir, "execution-core"), { recursive: true });
    writeFileSync(
      getCursorPath(),
      JSON.stringify({ logPath: "/L", byteOffset: "fifty" }),
    );
    expect(loadCursor()).toBeNull();
  });

  test("saveCursor writes atomically — no <file>.tmp left behind on success", () => {
    saveCursor({ logPath: "/L", byteOffset: 7 });
    expect(existsSync(getCursorPath())).toBe(true);
    expect(existsSync(`${getCursorPath()}.tmp`)).toBe(false);
  });

  test("saveCursor creates the execution-core dir if absent", () => {
    expect(existsSync(join(catalystDir, "execution-core"))).toBe(false);
    saveCursor({ logPath: "/L", byteOffset: 1 });
    expect(loadCursor()).toEqual({ logPath: "/L", byteOffset: 1 });
  });
});
