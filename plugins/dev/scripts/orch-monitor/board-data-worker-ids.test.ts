// CTL-888 (BFF6) P6/P7: BoardWorker gains startedAt (epoch ms), pid, and the
// catalyst sess_ id alongside the CC-UUID sessionId.
//
// assembleBoard() shells out to `claude agents --json` and reads a homedir DB
// const, so it is not directly unit-testable. Following the convention in
// board-data-phase-costs.test.ts, we exercise:
//   • the CC-UUID → catalyst-sess_ join SQL (P7) against a temp DB, and
//   • the worker field-derivation logic (P6 startedAt, P7 pid) on a synthetic
//     `claude agents --json` agent record — asserting the exact null-vs-value
//     normalization the board applies.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("BFF6 P7: CC-UUID → catalyst sess_ id join SQL", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "board-worker-ids-"));
    dbPath = join(tmpDir, "catalyst.db");
    execFileSync("sqlite3", [
      dbPath,
      `
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        ticket_key TEXT,
        pid INTEGER,
        claude_session_id TEXT
      );
      -- one worker with both ids
      INSERT INTO sessions VALUES ('sess_abc_01','CTL-888',4242,'cc-uuid-1111');
      -- a session that never recorded its CC-UUID (pre-CTL-374 / solo run)
      INSERT INTO sessions VALUES ('sess_def_02','CTL-889',4243,NULL);
      INSERT INTO sessions VALUES ('sess_ghi_03','CTL-890',4244,'');
      `,
    ]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("maps a CC-UUID to its catalyst session_id and skips rows with no CC-UUID", () => {
    const sql =
      "SELECT claude_session_id, session_id FROM sessions " +
      "WHERE claude_session_id IS NOT NULL AND claude_session_id <> '';";
    const out = execFileSync("sqlite3", ["-separator", "\t", dbPath, sql], {
      encoding: "utf8",
    });
    const map: Record<string, string> = {};
    for (const line of out.trim().split("\n")) {
      if (!line) continue;
      const [ccUuid, sessId] = line.split("\t");
      if (ccUuid && sessId) map[ccUuid] = sessId;
    }
    // the only row carrying a CC-UUID resolves to its catalyst sess_ id
    expect(map["cc-uuid-1111"]).toBe("sess_abc_01");
    // NULL / empty CC-UUID rows are excluded — no fabricated mapping
    expect(Object.keys(map)).toEqual(["cc-uuid-1111"]);
  });

  it("an unknown CC-UUID has no mapping (catalystSessionId stays null)", () => {
    const sql =
      "SELECT claude_session_id, session_id FROM sessions " +
      "WHERE claude_session_id IS NOT NULL AND claude_session_id <> '';";
    const out = execFileSync("sqlite3", ["-separator", "\t", dbPath, sql], {
      encoding: "utf8",
    });
    const map: Record<string, string> = {};
    for (const line of out.trim().split("\n")) {
      if (!line) continue;
      const [ccUuid, sessId] = line.split("\t");
      if (ccUuid && sessId) map[ccUuid] = sessId;
    }
    const catalystSessionId = map["cc-uuid-does-not-exist"] ?? null;
    expect(catalystSessionId).toBeNull();
  });
});

// P6 (startedAt) + P7 (pid) field normalization the worker assembly applies to a
// `claude agents --json` agent record. The board persists numeric startedAt/pid
// verbatim and collapses any non-number (absent field) to null.
describe("BFF6 P6/P7: worker startedAt + pid field normalization", () => {
  type Agent = { startedAt?: unknown; pid?: unknown; sessionId?: string };

  // Mirrors the normalization in board-data.mjs assembleBoard worker map.
  function deriveWorkerIds(a: Agent, catalystByUuid: Record<string, string>) {
    return {
      startedAt: typeof a.startedAt === "number" ? a.startedAt : null,
      pid: typeof a.pid === "number" ? a.pid : null,
      catalystSessionId: a.sessionId ? catalystByUuid[a.sessionId] ?? null : null,
    };
  }

  it("persists numeric startedAt (epoch ms) and pid verbatim", () => {
    const out = deriveWorkerIds(
      { startedAt: 1780476726027, pid: 51612, sessionId: "cc-uuid-1111" },
      { "cc-uuid-1111": "sess_abc_01" },
    );
    expect(out).toEqual({
      startedAt: 1780476726027,
      pid: 51612,
      catalystSessionId: "sess_abc_01",
    });
  });

  it("collapses absent startedAt / pid to null (no fabrication)", () => {
    const out = deriveWorkerIds({ sessionId: "cc-uuid-2222" }, {});
    expect(out).toEqual({ startedAt: null, pid: null, catalystSessionId: null });
  });

  it("surfaces BOTH id spaces: CC-UUID sessionId is independent of the catalyst sess_ id", () => {
    const a: Agent = { startedAt: 1, pid: 2, sessionId: "cc-uuid-1111" };
    const ids = deriveWorkerIds(a, { "cc-uuid-1111": "sess_abc_01" });
    // CC-UUID (Prometheus/Loki claude-code key) and catalyst sess_ id
    // (catalyst.session heartbeat key) are distinct, both present.
    expect(a.sessionId).toBe("cc-uuid-1111");
    expect(ids.catalystSessionId).toBe("sess_abc_01");
    expect(a.sessionId).not.toBe(ids.catalystSessionId);
  });
});
