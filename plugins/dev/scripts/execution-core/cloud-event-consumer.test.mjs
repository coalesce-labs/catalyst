// cloud-event-consumer.test.mjs — CTL-1534.
//
// Hermetic by construction: every test points the consumer at a throwaway tmp
// CATALYST_DIR and injects an in-memory `fetchImpl`, a token override, and the
// team/bot config. No network, no credential, no real ~/catalyst is ever touched
// — so this suite is exactly the credential-free CI negative control the phase-3
// harness rules demand (rule 8).
//
// Run: cd plugins/dev/scripts/execution-core && bun test cloud-event-consumer.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  DECLARED_MAPPABLE_TYPES,
  DECLARED_UNMAPPABLE_TYPES,
  EXIT_HEALTHY,
  EXIT_PROBLEM,
  EXIT_UNEVALUATED,
  LIVE_DIR_NAME,
  MARKER_FEED_GAP,
  MARKER_UNMAPPABLE,
  SEQ_ATTR,
  SHADOW_DIR_NAME,
  VALUE_FLAGS,
  classifyLine,
  classifyProviderType,
  createShadowAppender,
  ghEvent,
  isPayloadOmitted,
  linearEvent,
  main,
  mapCloudEvent,
  ndjsonLines,
  parseArgv,
  parseEnvFile,
  parseSinceArg,
  readCloudToken,
  readState,
  resolveShadowDir,
  runOnce,
  runSelfTest,
  shadowFilePath,
  statePath,
  strictSeq,
  writeState,
} from "./cloud-event-consumer.mjs";

const TOKEN = "cat_tok_SUPERSECRET_do_not_log_0123456789";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cec-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

function res({ status = 200, head = null, lines = [], body = null, stream = false }) {
  const headers = new Map();
  if (head !== null) headers.set("x-catalyst-event-head-seq", String(head));
  const text =
    body !== null ? JSON.stringify(body) : lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "");
  const out = {
    status,
    headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
    text: async () => text,
  };
  if (stream) {
    out.body = new ReadableStream({
      start(controller) {
        // deliberately chunk mid-line so the line buffer is exercised
        const bytes = new TextEncoder().encode(text);
        const mid = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.slice(0, mid));
        controller.enqueue(bytes.slice(mid));
        controller.close();
      },
    });
  }
  return out;
}

function memAppender() {
  const records = [];
  return { records, dir: "<memory>", write: (r) => records.push(r) };
}

function collectLogs() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, info: push, warn: push, error: push };
}

async function runMain(argv, responses, extra = {}) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const requested = [];
  const out = [];
  const err = [];
  const code = await main(argv, {
    catalystDir: dir,
    tokenOverride: TOKEN,
    linearTeams: [],
    botUserIds: new Set(),
    fetchImpl: async (url) => {
      requested.push(url);
      const next = queue.shift();
      if (next === undefined) throw new Error("no more mocked responses");
      if (next instanceof Error) throw next;
      return next;
    },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    sleep: async () => {},
    ...extra,
  });
  return { code, requested, stdout: out.join(""), stderr: err.join("") };
}

function shadowLines() {
  const sdir = resolve(dir, SHADOW_DIR_NAME);
  if (!existsSync(sdir)) return [];
  return readdirSync(sdir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) =>
      readFileSync(join(sdir, f), "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l)),
    );
}

// --------------------------------------------------------------------------
// rule 6 — never normalise the evidence
// --------------------------------------------------------------------------

describe("strict input parsing (never coerce, never default)", () => {
  test("parseSinceArg accepts only canonical non-negative integers", () => {
    expect(parseSinceArg("0")).toBe(0);
    expect(parseSinceArg("42")).toBe(42);
    for (const bad of ["banana", "", " 5", "5 ", "-1", "1e3", "1.0", "0x10", "007", "+3", "NaN", "Infinity"]) {
      expect(parseSinceArg(bad)).toBeNull();
    }
    expect(parseSinceArg(5)).toBeNull(); // not a string -> rejected, not coerced
  });

  test("--since banana is REJECTED with exit 2 (never coerced to 0 and rescanned)", async () => {
    const { code, stderr } = await runMain(["--once", "--since", "banana"], []);
    expect(code).toBe(EXIT_UNEVALUATED);
    expect(stderr).toContain("--since must be a non-negative integer");
  });

  test("strictSeq rejects strings, floats and negatives from the wire", () => {
    expect(strictSeq(3)).toBe(3);
    expect(strictSeq(0)).toBe(0);
    expect(strictSeq("3")).toBeNull();
    expect(strictSeq(3.5)).toBeNull();
    expect(strictSeq(-1)).toBeNull();
    expect(strictSeq(NaN)).toBeNull();
    expect(strictSeq(undefined)).toBeNull();
  });

  test("a wire seq that is a string makes the run UNEVALUATED, not repaired", async () => {
    const r = await runOnce({
      fetchImpl: async () => res({ head: 1, lines: [{ ...ghEvent(1, "d1"), seq: "1" }] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.status).toBe(EXIT_UNEVALUATED);
    expect(r.unevaluated.join(" ")).toContain("non-integer seq");
  });
});

// --------------------------------------------------------------------------
// the shadow path can never be the live path
// --------------------------------------------------------------------------

describe("shadow path is impossible-by-construction (never the live event log)", () => {
  test("resolveShadowDir always lands on <root>/events-shadow", () => {
    expect(resolveShadowDir("/tmp/cat")).toBe(resolve("/tmp/cat", SHADOW_DIR_NAME));
    expect(SHADOW_DIR_NAME).not.toBe(LIVE_DIR_NAME);
  });

  test("refuses a root that would nest the shadow dir inside the live events dir", () => {
    expect(() => resolveShadowDir("/tmp/cat/events")).toThrow(/live events dir/);
  });

  test("refuses an empty/non-string root rather than defaulting", () => {
    expect(() => resolveShadowDir("")).toThrow();
    expect(() => resolveShadowDir(undefined)).toThrow();
  });

  test("there is NO parameter that names a write directory — only a catalyst root", () => {
    // The appender takes the root; the last segment is a module constant.
    const app = createShadowAppender(dir);
    expect(app.dir).toBe(resolve(dir, SHADOW_DIR_NAME));
    expect(shadowFilePath(dir, new Date(Date.UTC(2026, 6, 5)))).toBe(
      resolve(dir, SHADOW_DIR_NAME, "shadow-2026-07.jsonl"),
    );
  });

  test("a full ingest run never creates <root>/events", async () => {
    const { code } = await runMain(["--once", "--since", "0"], [
      res({ head: 2, lines: [ghEvent(1, "d1"), linearEvent(2, "d2")] }),
    ]);
    expect(code).toBe(EXIT_HEALTHY);
    expect(existsSync(resolve(dir, SHADOW_DIR_NAME))).toBe(true);
    expect(existsSync(resolve(dir, LIVE_DIR_NAME))).toBe(false);
  });
});

// --------------------------------------------------------------------------
// cursor persistence + resume
// --------------------------------------------------------------------------

describe("cursor persistence and resume", () => {
  test("persists the cursor atomically and resumes from it on the next run", async () => {
    const first = await runMain(["--once", "--since", "0"], [
      res({ head: 3, lines: [ghEvent(1, "d1"), ghEvent(2, "d2"), ghEvent(3, "d3")] }),
    ]);
    expect(first.code).toBe(EXIT_HEALTHY);
    expect(first.requested[0]).toContain("since=0");

    const persisted = JSON.parse(readFileSync(statePath(dir), "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.cursor).toBe(3);
    expect(persisted.seenDeliveryIds).toEqual(["d1", "d2", "d3"]);
    // atomic write leaves no tmp behind
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    // second run: no --since, resumes from the persisted cursor
    const second = await runMain(["--once"], [res({ head: 3, lines: [] })]);
    expect(second.code).toBe(EXIT_HEALTHY);
    expect(second.requested[0]).toContain("since=3");
  });

  test("--since OVERRIDES the persisted cursor", async () => {
    writeState(dir, { cursor: 99, seenDeliveryIds: [] });
    const { requested } = await runMain(["--once", "--since", "5"], [res({ head: 5, lines: [] })]);
    expect(requested[0]).toContain("since=5");
  });

  test("refuses to invent a cursor when there is neither state nor --since (since=0 409s forever)", async () => {
    const { code, stderr } = await runMain(["--once"], []);
    expect(code).toBe(EXIT_UNEVALUATED);
    expect(stderr).toContain("Refusing to default to 0");
  });

  test("a corrupt state file is exit 2, NOT a silent reset to a fresh cursor", async () => {
    writeFileSync(statePath(dir), "{not json");
    const { code, stderr } = await runMain(["--once"], []);
    expect(code).toBe(EXIT_UNEVALUATED);
    expect(stderr).toContain("cursor state file is unusable");
    expect(readState(dir).ok).toBe(false);
  });

  test("the persisted dedup ring is bounded", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `d${i}`);
    writeState(dir, { cursor: 1, seenDeliveryIds: ids }, { dedupMax: 5 });
    const p = JSON.parse(readFileSync(statePath(dir), "utf8"));
    expect(p.seenDeliveryIds).toEqual(["d15", "d16", "d17", "d18", "d19"]);
  });
});

// --------------------------------------------------------------------------
// dedup on deliveryId
// --------------------------------------------------------------------------

describe("dedup on deliveryId before appending", () => {
  test("a re-delivered deliveryId is counted, not appended twice", async () => {
    await runMain(["--once", "--since", "0"], [res({ head: 2, lines: [ghEvent(1, "d1"), ghEvent(2, "d2")] })]);
    expect(shadowLines().length).toBe(2);

    // crash-and-rewind: the same events arrive again from an earlier cursor
    const second = await runMain(["--once", "--since", "0"], [
      res({ head: 3, lines: [ghEvent(1, "d1"), ghEvent(2, "d2"), ghEvent(3, "d3")] }),
    ]);
    expect(second.code).toBe(EXIT_HEALTHY);
    const all = shadowLines();
    expect(all.length).toBe(3); // only d3 was new
    const ids = all.map((e) => e.attributes["webhook.delivery.id"]);
    expect(ids).toEqual(["d1", "d2", "d3"]);
  });

  test("dedup survives a process restart (it is persisted, not in-memory only)", async () => {
    await runMain(["--once", "--since", "0"], [res({ head: 1, lines: [ghEvent(1, "d1")] })]);
    const r = await runOnce({
      fetchImpl: async () => res({ head: 1, lines: [ghEvent(1, "d1")] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(readState(dir).state.seenDeliveryIds),
      log: collectLogs(),
    });
    expect(r.deduped).toBe(1);
    expect(r.appended).toBe(0);
  });
});

// --------------------------------------------------------------------------
// control records (rule 3)
// --------------------------------------------------------------------------

describe("control records invalidate the run", () => {
  test("a line with `error` and NO `seq` is a control record", () => {
    expect(classifyLine({ error: "cursor_underflow", resync: true }).kind).toBe("control");
    expect(classifyLine({ seq: 1, source: "github" }).kind).toBe("event");
    // a provider body carrying its own `error` key nests under payload — no collision
    expect(classifyLine({ seq: 1, source: "github", payload: { error: "boom" } }).kind).toBe("event");
    expect(classifyLine(null).kind).toBe("invalid");
    expect(classifyLine([]).kind).toBe("invalid");
    expect(classifyLine({ hello: 1 }).kind).toBe("invalid");
  });

  test("a contiguous prefix terminated by a control record is exit 2, NOT a clean pass", async () => {
    const { code } = await runMain(["--once", "--since", "0"], [
      res({
        head: 9,
        lines: [ghEvent(1, "d1"), ghEvent(2, "d2"), { error: "cursor_underflow", resync: true }],
      }),
    ]);
    expect(code).toBe(EXIT_UNEVALUATED);

    const lines = shadowLines();
    // the prefix is real and was ingested; the gap is recorded, never silent
    expect(lines.filter((l) => l.marker === undefined).length).toBe(2);
    const gap = lines.find((l) => l.marker === "feed-gap");
    expect(gap).toBeDefined();
    expect(gap.attributes["event.name"]).toBe(MARKER_FEED_GAP);
    expect(gap.reason).toBe("control-record");
    expect(gap.body.error).toBe("cursor_underflow");
  });

  test("the cursor is NOT advanced past a server-declared incomplete scan", async () => {
    writeState(dir, { cursor: 0, seenDeliveryIds: [] });
    const { code } = await runMain(["--once"], [
      res({ head: 9, lines: [ghEvent(1, "d1"), ghEvent(2, "d2"), { error: "cursor_underflow", resync: true }] }),
    ]);
    expect(code).toBe(EXIT_UNEVALUATED);
    // Advancing to 2 here would let a later restart silently resume PAST the hole.
    expect(JSON.parse(readFileSync(statePath(dir), "utf8")).cursor).toBe(0);
  });

  test("a control record after a LATE start names the range that was never delivered", async () => {
    const r = await runOnce({
      fetchImpl: async () => res({ head: 99, lines: [ghEvent(50, "d50"), { error: "cursor_underflow" }] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.status).toBe(EXIT_UNEVALUATED);
    expect(r.cursorAdvancedTo).toBeNull();
    expect(r.unevaluated.join(" ")).toContain("seqs 1..49 were never delivered");
  });

  test("the control-record run does NOT report a coverage verdict it did not earn", async () => {
    const r = await runOnce({
      fetchImpl: async () => res({ head: 9, lines: [ghEvent(1, "d1"), { error: "cursor_underflow" }] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.status).toBe(EXIT_UNEVALUATED);
    expect(r.coverage.ok).toBeNull();
    expect(r.integrity.ok).toBe(true); // the PREFIX is contiguous — which is the trap
  });

  test("a control record stops the poll loop instead of spinning", async () => {
    const { code, requested } = await runMain(["--since", "0", "--max-passes", "3"], [
      res({ head: 9, lines: [{ error: "cursor_underflow", resync: true }] }),
    ]);
    expect(code).toBe(EXIT_UNEVALUATED);
    expect(requested.length).toBe(1);
  });
});

// --------------------------------------------------------------------------
// 409 handling — both kinds, both LOUD, neither auto-repaired
// --------------------------------------------------------------------------

describe("409 handling", () => {
  test("cursor_underflow is a RECONCILE signal, exits 2, and leaves the cursor UNCHANGED", async () => {
    writeState(dir, { cursor: 7, seenDeliveryIds: [] });
    const { code, stderr } = await runMain(["--once"], [
      res({ status: 409, body: { error: "cursor_underflow", resync: true } }),
    ]);
    expect(code).toBe(EXIT_UNEVALUATED);
    expect(stderr).toContain("RECONCILE");
    expect(stderr).toContain("NOT a resume");
    expect(JSON.parse(readFileSync(statePath(dir), "utf8")).cursor).toBe(7);
    const gap = shadowLines().find((l) => l.marker === "feed-gap");
    expect(gap.reason).toBe("cursor_underflow");
  });

  test("cursor_ahead_of_head exits 2 and is NOT clamped to the reported head", async () => {
    writeState(dir, { cursor: 999999999, seenDeliveryIds: [] });
    const { code, stderr } = await runMain(["--once"], [
      res({ status: 409, body: { error: "cursor_ahead_of_head", resync: true, head: 113 } }),
    ]);
    expect(code).toBe(EXIT_UNEVALUATED);
    expect(stderr).toContain("crossed");
    expect(stderr).toContain("SEPARATE sequences");
    // NOT clamped to 113 — clamping would silently skip a real range
    expect(JSON.parse(readFileSync(statePath(dir), "utf8")).cursor).toBe(999999999);
  });

  test("an unrecognised 409 body is still exit 2, never 0", async () => {
    const r = await runOnce({
      fetchImpl: async () => res({ status: 409, body: { error: "something_new" } }),
      token: "",
      since: 1,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.status).toBe(EXIT_UNEVALUATED);
  });

  test("401/403 and other non-2xx are exit 2, never 0", async () => {
    for (const status of [401, 403, 500, 502]) {
      const r = await runOnce({
        fetchImpl: async () => res({ status }),
        token: "",
        since: 0,
        appender: memAppender(),
        seen: new Set(),
        log: collectLogs(),
      });
      expect(r.status).toBe(EXIT_UNEVALUATED);
    }
  });

  test("a thrown fetch is exit 2 (a failed probe is never 'healthy')", async () => {
    const r = await runOnce({
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.status).toBe(EXIT_UNEVALUATED);
  });
});

// --------------------------------------------------------------------------
// payloadOmitted -> attributable gap marker
// --------------------------------------------------------------------------

describe("payloadOmitted is a targeted gap, never a silent skip", () => {
  test("isPayloadOmitted is a TRUTHY test, not key-presence", () => {
    expect(isPayloadOmitted({})).toBe(false); // absent on normal events
    expect(isPayloadOmitted({ payloadOmitted: false })).toBe(false);
    expect(isPayloadOmitted({ payloadOmitted: true })).toBe(true);
  });

  test("a normal event (key ABSENT) maps and appends — the key-presence bug would break this", async () => {
    const { code } = await runMain(["--once", "--since", "0"], [res({ head: 1, lines: [ghEvent(1, "d1")] })]);
    expect(code).toBe(EXIT_HEALTHY);
    expect(shadowLines().filter((l) => l.marker === undefined).length).toBe(1);
  });

  test("an elided payload writes a marker carrying deliveryId/source/eventType/identity", async () => {
    const elided = {
      accountId: "tenant-0",
      seq: 1,
      deliveryId: "big-1",
      source: "linear",
      eventType: "Comment",
      action: "create",
      receivedAt: "2026-07-26T20:00:00.000Z",
      payload: null,
      payloadOmitted: true,
      payloadBytes: 120000,
      identity: { id: "iss-1", identifier: "CTL-1534", issueId: "iss-1" },
    };
    const { code } = await runMain(["--once", "--since", "0"], [res({ head: 1, lines: [elided] })]);
    expect(code).toBe(EXIT_PROBLEM); // evaluated, and a real gap was found

    const marker = shadowLines().find((l) => l.marker === "unmappable-payload");
    expect(marker).toBeDefined();
    expect(marker.attributes["event.name"]).toBe(MARKER_UNMAPPABLE);
    expect(marker.attributes["webhook.delivery.id"]).toBe("big-1");
    expect(marker.deliveryId).toBe("big-1");
    expect(marker.source).toBe("linear");
    expect(marker.eventType).toBe("Comment");
    expect(marker.payloadBytes).toBe(120000);
    expect(marker.identity).toEqual({ id: "iss-1", identifier: "CTL-1534", issueId: "iss-1" });
    // and it was NOT appended as an event
    expect(shadowLines().filter((l) => l.marker === undefined).length).toBe(0);
  });

  test("an elided payload with NO identity still produces an attributable marker", async () => {
    const r = await runOnce({
      fetchImpl: async () =>
        res({
          head: 1,
          lines: [
            {
              seq: 1, deliveryId: "big-2", source: "github", eventType: "push",
              receivedAt: "2026-07-26T20:00:00.000Z", payload: null, payloadOmitted: true, payloadBytes: 99999,
            },
          ],
        }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.status).toBe(EXIT_PROBLEM);
    expect(r.unmappable).toEqual([{ seq: 1, deliveryId: "big-2", source: "github", eventType: "push" }]);
  });

  test("payload:null WITHOUT payloadOmitted is malformed input -> exit 2, not a guess", () => {
    const out = mapCloudEvent({
      seq: 1, deliveryId: "x", source: "github", eventType: "push",
      receivedAt: "2026-07-26T20:00:00.000Z", payload: null,
    });
    expect(out.outcome).toBe("invalid");
  });
});

// --------------------------------------------------------------------------
// COVERAGE != INTEGRITY (rule 2 / defect 6)
// --------------------------------------------------------------------------

describe("coverage and integrity are asserted SEPARATELY", () => {
  const run = (since, head, lines) =>
    runOnce({
      fetchImpl: async () => res({ head, lines }),
      token: "",
      since,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });

  test("a full replay spanning since+1..head is healthy on both axes", async () => {
    const r = await run(0, 3, [ghEvent(1, "d1"), ghEvent(2, "d2"), ghEvent(3, "d3")]);
    expect(r.coverage.ok).toBe(true);
    expect(r.integrity.ok).toBe(true);
    expect(r.status).toBe(EXIT_HEALTHY);
  });

  test("SHORT READ: internally contiguous, no control record — integrity passes, coverage FAILS", async () => {
    const r = await run(0, 9, [ghEvent(1, "d1"), ghEvent(2, "d2")]);
    expect(r.integrity.ok).toBe(true); // the trap: every gap check passes
    expect(r.coverage.ok).toBe(false);
    expect(r.coverage.problems.join(" ")).toContain("SHORT READ");
    expect(r.status).toBe(EXIT_PROBLEM);
  });

  test("STARTS LATE: first != since+1 fails coverage while integrity passes", async () => {
    const r = await run(0, 3, [ghEvent(2, "d2"), ghEvent(3, "d3")]);
    expect(r.integrity.ok).toBe(true);
    expect(r.coverage.ok).toBe(false);
    expect(r.coverage.problems.join(" ")).toContain("starts late");
    expect(r.status).toBe(EXIT_PROBLEM);
  });

  test("EMPTY while head is ahead fails coverage", async () => {
    const r = await run(3, 9, []);
    expect(r.coverage.ok).toBe(false);
    expect(r.status).toBe(EXIT_PROBLEM);
  });

  test("EMPTY is healthy only when the cursor is exactly at head", async () => {
    const r = await run(7, 7, []);
    expect(r.coverage.ok).toBe(true);
    expect(r.status).toBe(EXIT_HEALTHY);
  });

  test("EMPTY with since > head is a crossed cursor, flagged not shrugged", async () => {
    const r = await run(9, 3, []);
    expect(r.coverage.ok).toBe(false);
    expect(r.coverage.problems.join(" ")).toContain("crossed cursor");
  });

  test("a feed that advances DURING the read is recorded, not treated as a fault", async () => {
    const r = await run(0, 2, [ghEvent(1, "d1"), ghEvent(2, "d2"), ghEvent(3, "d3")]);
    expect(r.coverage.ok).toBe(true);
    expect(r.coverage.advancedDuringRead).toBe(1);
    expect(r.status).toBe(EXIT_HEALTHY);
  });

  test("a missing head header makes coverage UNASSERTABLE -> exit 2, never 0", async () => {
    const r = await runOnce({
      fetchImpl: async () => res({ head: null, lines: [ghEvent(1, "d1")] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.status).toBe(EXIT_UNEVALUATED);
    expect(r.coverage.ok).toBeNull();
  });

  test("integrity is checked in WIRE ORDER — 1,3,2 is a break, not a clean pass", async () => {
    const r = await run(0, 3, [ghEvent(1, "d1"), ghEvent(3, "d3"), ghEvent(2, "d2")]);
    expect(r.integrity.ok).toBe(false);
    expect(r.integrity.breaks).toEqual([{ prev: 1, next: 3 }, { prev: 3, next: 2 }]);
    expect(r.status).toBe(EXIT_PROBLEM);
  });

  test("an internal gap 1,3 is caught", async () => {
    const r = await run(0, 3, [ghEvent(1, "d1"), ghEvent(3, "d3")]);
    expect(r.integrity.ok).toBe(false);
    expect(r.integrity.breaks).toEqual([{ prev: 1, next: 3 }]);
  });
});

// --------------------------------------------------------------------------
// per-source / per-type counts (rules 5 + 9)
// --------------------------------------------------------------------------

describe("per-source and per-type COUNTS, never presence", () => {
  test("counts are per source and per type", async () => {
    const r = await runOnce({
      fetchImpl: async () =>
        res({
          head: 4,
          lines: [
            ghEvent(1, "d1"),
            ghEvent(2, "d2", { eventType: "push", payload: { repository: { full_name: "a/b" }, ref: "refs/heads/main", before: "x", after: "y", commits: [] } }),
            linearEvent(3, "d3"),
            linearEvent(4, "d4"),
          ],
        }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.bySource).toEqual({ github: 2, linear: 2 });
    expect(r.byType["github:pull_request"]).toBe(1);
    expect(r.byType["github:push"]).toBe(1);
    expect(r.byType["linear:Comment"]).toBe(2);
  });

  test("--require-source goes RED when a named source contributes zero", async () => {
    const r = await runOnce({
      fetchImpl: async () => res({ head: 1, lines: [ghEvent(1, "d1")] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
      requireSources: ["github", "linear"],
    });
    expect(r.status).toBe(EXIT_PROBLEM);
    expect(r.problems.join(" ")).toContain('required source "linear" appended ZERO envelopes');
  });

  // H2/H9: the assertion used to read the WIRE census (`bySource`), which is bumped
  // before the mapper runs — so one arriving record of a source satisfied "non-zero"
  // even when it produced no envelope at all.
  test("--require-source is NOT satisfied by a wire record that produced no envelope", async () => {
    const attachment = {
      seq: 1, deliveryId: "att-1", source: "linear", eventType: "Attachment",
      action: "create", receivedAt: "2026-07-26T20:00:00.000Z",
      payload: { type: "Attachment", action: "create", data: { id: "a1" } },
    };
    const app = memAppender();
    const r = await runOnce({
      fetchImpl: async () => res({ head: 2, lines: [ghEvent(1, "d0"), { ...attachment, seq: 2 }] }),
      token: "",
      since: 0,
      appender: app,
      seen: new Set(),
      log: collectLogs(),
      requireSources: ["github", "linear"],
    });
    expect(r.bySource.linear).toBe(1); // it DID arrive
    expect(r.appendedBySource.linear).toBe(0); // and produced nothing
    expect(app.records.filter((x) => x.attributes?.["event.name"]?.startsWith("linear.")).length).toBe(0);
    expect(r.status).toBe(EXIT_PROBLEM);
    expect(r.problems.join(" ")).toContain('required source "linear" appended ZERO envelopes');
  });

  test("appendedBySource counts only envelopes that reached the shadow log", async () => {
    const r = await runOnce({
      fetchImpl: async () => res({ head: 3, lines: [ghEvent(1, "d1"), linearEvent(2, "d2"), ghEvent(3, "d1")] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.bySource).toEqual({ github: 2, linear: 1 });
    expect(r.appendedBySource).toEqual({ github: 1, linear: 1 }); // d1 deduped
    expect(r.deduped).toBe(1);
  });

  test("--require-source with an unknown source is rejected (exit 2), not ignored", async () => {
    const args = parseArgv(["--require-source", "gitlab"]);
    expect(args.errors.length).toBeGreaterThan(0);
    const { code } = await runMain(["--once", "--since", "0", "--require-source", "gitlab"], []);
    expect(code).toBe(EXIT_UNEVALUATED);
  });
});

// --------------------------------------------------------------------------
// mapping — reuse, and the join key
// --------------------------------------------------------------------------

describe("mapping via the UNMODIFIED orch-monitor mappers", () => {
  test("a github payload becomes the same v2 envelope shape the live path writes", () => {
    const out = mapCloudEvent(ghEvent(1, "gh-delivery-1"));
    expect(out.outcome).toBe("envelope");
    const e = out.envelope;
    expect(e.attributes["event.name"]).toBe("github.pr.opened");
    expect(e.attributes["vcs.repository.name"]).toBe("coalesce-labs/catalyst");
    expect(e.attributes["vcs.pr.number"]).toBe(2751);
    expect(e.attributes["webhook.delivery.id"]).toBe("gh-delivery-1");
    expect(e.resource["service.namespace"]).toBe("catalyst");
    expect(typeof e.id).toBe("string");
  });

  test("a linear payload becomes a linear.* envelope with the join key stamped", () => {
    const out = mapCloudEvent(linearEvent(2, "lin-delivery-1"));
    expect(out.outcome).toBe("envelope");
    expect(out.envelope.attributes["event.name"]).toBe("linear.comment.created");
    expect(out.envelope.attributes["linear.issue.identifier"]).toBe("CTL-1534");
    expect(out.envelope.attributes["webhook.delivery.id"]).toBe("lin-delivery-1");
  });

  test("teamsMap flows into the Linear envelope exactly as the live handler does", () => {
    const out = mapCloudEvent(linearEvent(2, "lin-2"), { teamsMap: new Map([["CTL", "coalesce-labs/catalyst"]]) });
    expect(out.envelope.attributes["vcs.repository.name"]).toBe("coalesce-labs/catalyst");
  });

  test("tsMode=receivedAt stamps the cloud receipt time; tsMode=now stamps map time", () => {
    const a = mapCloudEvent(ghEvent(1, "d1"), { tsMode: "receivedAt" });
    expect(a.envelope.ts).toBe("2026-07-26T20:00:00.000Z");
    const b = mapCloudEvent(ghEvent(1, "d1"), { tsMode: "now", now: () => new Date("2030-01-01T00:00:00.000Z") });
    expect(b.envelope.ts).toBe("2030-01-01T00:00:00.000Z");
  });

  test("an unknown source / missing deliveryId is invalid input, not a best-effort map", () => {
    expect(mapCloudEvent({ source: "gitlab", eventType: "x", deliveryId: "d", payload: {} }).outcome).toBe("invalid");
    expect(mapCloudEvent({ source: "github", eventType: "push", payload: {}, receivedAt: "2026-01-01T00:00:00Z" }).outcome).toBe("invalid");
  });

  // H10: "the mapper ignores it" is benign ONLY for a type we DECLARED has no
  // mapper on either path. Blanket-blessing every ignore made a total mapper
  // failure indistinguishable from a healthy run.
  test("a DECLARED-unmappable provider type is expected-zero coverage data, not a defect", async () => {
    const r = await runOnce({
      fetchImpl: async () =>
        res({ head: 1, lines: [ghEvent(1, "d1", { eventType: "workflow_job", payload: { repository: { full_name: "a/b" } } })] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.appended).toBe(0);
    expect(r.ignoredByType["github:workflow_job"]).toBe(1);
    expect(classifyProviderType("github", "workflow_job")).toBe("declared-unmappable");
    expect(r.status).toBe(EXIT_HEALTHY);
  });

  test("an UNDECLARED provider type is a PROBLEM, not silent coverage data", async () => {
    const r = await runOnce({
      fetchImpl: async () =>
        res({ head: 1, lines: [ghEvent(1, "d1", { eventType: "ping", payload: { repository: { full_name: "a/b" } } })] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.appended).toBe(0);
    expect(r.undeclaredTypes["github:ping"]).toBe(1);
    expect(r.status).toBe(EXIT_PROBLEM);
    expect(r.problems.join(" ")).toContain("undeclared provider type github:ping");
  });

  test("a DECLARED-mappable type that appends NOTHING is a problem (schema drift), not coverage data", async () => {
    // The recorded Linear drift: the Comment body nests under `comment`, not `data`.
    const drifted = (seq, id) => ({
      seq, deliveryId: id, source: "linear", eventType: "Comment", action: "create",
      receivedAt: "2026-07-26T20:00:00.000Z",
      payload: { type: "Comment", action: "create", comment: { id: "c1", body: "x" } },
    });
    const r = await runOnce({
      fetchImpl: async () => res({ head: 2, lines: [drifted(1, "c1"), drifted(2, "c2")] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
      requireSources: [],
    });
    expect(r.received).toBe(2);
    expect(r.appended).toBe(0);
    expect(r.status).toBe(EXIT_PROBLEM);
    expect(r.problems.join(" ")).toContain("linear:Comment");
  });

  test("a mixed window where ONE source silently stops mapping is still a problem", async () => {
    // github keeps flowing (so `received`, `appended` and every total look alive)
    // while 100% of Linear Comments are declined.
    const drifted = {
      seq: 2, deliveryId: "c1", source: "linear", eventType: "Comment", action: "create",
      receivedAt: "2026-07-26T20:00:00.000Z",
      payload: { type: "Comment", action: "create", comment: { id: "c1" } },
    };
    const r = await runOnce({
      fetchImpl: async () => res({ head: 3, lines: [ghEvent(1, "g1"), drifted, ghEvent(3, "g3")] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.appended).toBe(2); // both github events landed
    expect(r.status).toBe(EXIT_PROBLEM);
  });

  test("bot-authored Linear issue events are suppressed, matching the live handler", async () => {
    const botIssue = {
      seq: 1, deliveryId: "bot-1", source: "linear", eventType: "Issue", action: "update",
      receivedAt: "2026-07-26T20:00:00.000Z",
      payload: {
        type: "Issue", action: "update",
        actor: { id: "bot-uuid", name: "Catalyst" },
        data: { id: "i1", identifier: "CTL-1", team: { key: "CTL" } },
        updatedFrom: { stateId: "s0" },
      },
    };
    const r = await runOnce({
      fetchImpl: async () => res({ head: 1, lines: [botIssue] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      botUserIds: new Set(["bot-uuid"]),
      log: collectLogs(),
    });
    expect(r.botSuppressed).toBe(1);
    expect(r.appended).toBe(0);
  });

  test("check_suite with no inline PR numbers is flagged as a KNOWN pr-cache coverage delta", async () => {
    const cs = {
      seq: 1, deliveryId: "cs-1", source: "github", eventType: "check_suite", action: "completed",
      receivedAt: "2026-07-26T20:00:00.000Z",
      payload: {
        repository: { full_name: "a/b" },
        check_suite: { status: "completed", conclusion: "success", head_branch: "x", head_sha: "sha1", pull_requests: [] },
      },
    };
    const r = await runOnce({
      fetchImpl: async () => res({ head: 1, lines: [cs] }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.prCacheDependent).toBe(1);
  });
});

// --------------------------------------------------------------------------
// transport plumbing
// --------------------------------------------------------------------------

describe("NDJSON transport", () => {
  test("the streaming body path and the text() fallback path agree", async () => {
    const lines = [ghEvent(1, "d1"), linearEvent(2, "d2"), ghEvent(3, "d3")];
    const viaText = [];
    for await (const l of ndjsonLines(res({ head: 3, lines }))) viaText.push(l);
    const viaStream = [];
    for await (const l of ndjsonLines(res({ head: 3, lines, stream: true }))) viaStream.push(l);
    expect(viaStream).toEqual(viaText);
    expect(viaStream.length).toBe(3);
  });

  test("a run over the streaming body produces the same verdict", async () => {
    const r = await runOnce({
      fetchImpl: async () => res({ head: 2, lines: [ghEvent(1, "d1"), ghEvent(2, "d2")], stream: true }),
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.status).toBe(EXIT_HEALTHY);
    expect(r.appended).toBe(2);
  });

  test("an unparseable NDJSON line is exit 2, not a skipped line", async () => {
    const bad = {
      status: 200,
      headers: { get: () => "1" },
      text: async () => "{not json}\n",
    };
    const r = await runOnce({
      fetchImpl: async () => bad,
      token: "",
      since: 0,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.status).toBe(EXIT_UNEVALUATED);
  });

  test("the request carries the bearer and the requested cursor", async () => {
    let seenInit = null;
    let seenUrl = null;
    await runOnce({
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenInit = init;
        return res({ head: 4, lines: [] });
      },
      baseUrl: "https://example.test/",
      token: TOKEN,
      since: 4,
      appender: memAppender(),
      seen: new Set(),
      log: collectLogs(),
    });
    expect(seenUrl).toBe("https://example.test/events/stream?since=4");
    expect(seenInit.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

// --------------------------------------------------------------------------
// token handling
// --------------------------------------------------------------------------

describe("token handling", () => {
  test("parses `export KEY=value` and quoted forms from cloud-sync.env", () => {
    expect(parseEnvFile("export CATALYST_CLOUD_TOKEN=abc123\n").CATALYST_CLOUD_TOKEN).toBe("abc123");
    expect(parseEnvFile('CATALYST_CLOUD_TOKEN="q u o"\n').CATALYST_CLOUD_TOKEN).toBe("q u o");
    expect(parseEnvFile("# comment\n\nexport A='x'\n").A).toBe("x");
  });

  test("env var wins over the file; absent is reported, never guessed", () => {
    const p = join(dir, "cloud-sync.env");
    writeFileSync(p, "export CATALYST_CLOUD_TOKEN=from-file\n");
    expect(readCloudToken({ env: {}, envFilePath: p }).token).toBe("from-file");
    expect(readCloudToken({ env: { CATALYST_CLOUD_TOKEN: "from-env" }, envFilePath: p }).source).toBe("env");
    expect(readCloudToken({ env: {}, envFilePath: join(dir, "nope.env") }).token).toBe("");
  });

  test("a missing token is exit 2 — never a 'healthy' no-op run", async () => {
    const code = await main(["--once", "--since", "0"], {
      catalystDir: dir,
      env: { CATALYST_CONFIG_DIR: dir },
      linearTeams: [],
      botUserIds: new Set(),
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
      stdout: () => {},
      stderr: () => {},
    });
    expect(code).toBe(EXIT_UNEVALUATED);
  });

  test("the token NEVER appears in any log line or in stdout", async () => {
    const { stdout, stderr } = await runMain(["--once", "--since", "0"], [
      res({ head: 1, lines: [ghEvent(1, "d1")] }),
    ]);
    expect(stdout).not.toContain(TOKEN);
    expect(stderr).not.toContain(TOKEN);
    expect(stderr).toContain("value never logged");
  });

  test("a token echoed back inside an error message is scrubbed", async () => {
    const { stderr } = await runMain(["--once", "--since", "0"], [new Error(`connect failed for Bearer ${TOKEN}`)]);
    expect(stderr).not.toContain(TOKEN);
    expect(stderr).toContain("<redacted>");
  });
});

// --------------------------------------------------------------------------
// exit contract at the process level
// --------------------------------------------------------------------------

describe("three-way exit contract end to end", () => {
  test("healthy run exits 0", async () => {
    const { code } = await runMain(["--once", "--since", "0"], [res({ head: 1, lines: [ghEvent(1, "d1")] })]);
    expect(code).toBe(EXIT_HEALTHY);
  });

  test("evaluated-problem run exits 1", async () => {
    const { code } = await runMain(["--once", "--since", "0"], [res({ head: 9, lines: [ghEvent(1, "d1")] })]);
    expect(code).toBe(EXIT_PROBLEM);
  });

  test("could-not-evaluate run exits 2", async () => {
    const { code } = await runMain(["--once", "--since", "0"], [res({ status: 500 })]);
    expect(code).toBe(EXIT_UNEVALUATED);
  });

  test("a loop that saw BOTH a problem and an unevaluated pass exits 2 (2 dominates)", async () => {
    const { code, stdout } = await runMain(
      ["--since", "0", "--json", "--max-consecutive-failures", "1", "--max-passes", "4"],
      [res({ head: 9, lines: [ghEvent(1, "d1")] }), res({ status: 500 })],
    );
    expect(code).toBe(EXIT_UNEVALUATED);
    const parsed = JSON.parse(stdout);
    expect(parsed.exit).toBe(EXIT_UNEVALUATED);
    // both verdicts are printed — neither hides the other
    expect(parsed.reports.map((r) => r.status)).toEqual([EXIT_PROBLEM, EXIT_UNEVALUATED]);
  });

  test("the poll loop advances the cursor between passes", async () => {
    const { code, requested } = await runMain(
      ["--since", "0", "--max-consecutive-failures", "1", "--max-passes", "4"],
      [res({ head: 2, lines: [ghEvent(1, "d1"), ghEvent(2, "d2")] }), res({ status: 500 })],
    );
    expect(code).toBe(EXIT_UNEVALUATED);
    expect(requested[0]).toContain("since=0");
    expect(requested[1]).toContain("since=2");
  });

  test("--json emits a machine-readable report", async () => {
    const { stdout } = await runMain(["--once", "--json", "--since", "0"], [
      res({ head: 2, lines: [ghEvent(1, "d1"), linearEvent(2, "d2")] }),
    ]);
    const parsed = JSON.parse(stdout);
    expect(parsed.exit).toBe(EXIT_HEALTHY);
    expect(parsed.reports[0].bySource).toEqual({ github: 1, linear: 1 });
    expect(parsed.reports[0].coverage.ok).toBe(true);
    expect(parsed.reports[0].integrity.ok).toBe(true);
  });

  test("an unknown flag is exit 2, not silently ignored", async () => {
    const { code } = await runMain(["--once", "--wat"], []);
    expect(code).toBe(EXIT_UNEVALUATED);
  });
});

// --------------------------------------------------------------------------
// C1/C3/H15/M4 — the producer/harness ordering contract
// --------------------------------------------------------------------------

describe("the cloud seq is stamped on every shadow envelope (the harness's only ordering input)", () => {
  test("mapCloudEvent stamps the wire seq under SEQ_ATTR", () => {
    const gh = mapCloudEvent(ghEvent(41, "d1"));
    expect(gh.envelope.attributes[SEQ_ATTR]).toBe(41);
    const li = mapCloudEvent(linearEvent(42, "d2"));
    expect(li.envelope.attributes[SEQ_ATTR]).toBe(42);
  });

  test("SEQ_ATTR is the string parity-harness defaults --seq-attr to (a rename breaks this test, not the checks)", async () => {
    const { parseArgs } = await import("./parity-harness.mjs");
    expect(SEQ_ATTR).toBe(parseArgs([]).opts.seqAttr);
  });

  test("every envelope written to the shadow log carries the seq, in wire order", async () => {
    await runMain(["--once", "--since", "0"], [
      res({ head: 3, lines: [ghEvent(1, "d1"), linearEvent(2, "d2"), ghEvent(3, "d3")] }),
    ]);
    const written = shadowLines();
    expect(written.length).toBe(3);
    expect(written.map((w) => w.attributes[SEQ_ATTR])).toEqual([1, 2, 3]);
  });

  test("a record with no usable seq is INVALID input, never an envelope with the attribute missing", () => {
    const bad = mapCloudEvent({ ...ghEvent(1, "d1"), seq: "1" });
    expect(bad.outcome).toBe("invalid");
    expect(bad.reason).toContain("ordering key");
    expect(mapCloudEvent({ ...ghEvent(1, "d1"), seq: undefined }).outcome).toBe("invalid");
  });

  test("consumer output feeds the harness's seq subsystem end to end (the two halves are wired)", async () => {
    const { evaluate, ingestText, parseArgs } = await import("./parity-harness.mjs");
    await runMain(["--once", "--since", "0"], [
      res({
        head: 3,
        lines: [
          ghEvent(1, "d1", { receivedAt: "2026-07-26T22:11:00.000Z" }),
          linearEvent(2, "d2", { receivedAt: "2026-07-26T22:12:00.000Z" }),
          ghEvent(3, "d3", { receivedAt: "2026-07-26T22:13:00.000Z" }),
        ],
      }),
    ]);
    const shadowText = shadowLines().map((l) => JSON.stringify(l)).join("\n");
    // The live side is the same mapped envelopes minus the transport annotation.
    const liveText = shadowLines()
      .map((l) => {
        const copy = JSON.parse(JSON.stringify(l));
        delete copy.attributes[SEQ_ATTR];
        return JSON.stringify(copy);
      })
      .join("\n");
    const o = {
      ...parseArgs([]).opts,
      fromMs: Date.parse("2026-07-26T22:00:00Z"), fromIso: "2026-07-26T22:00:00Z",
      toMs: Date.parse("2026-07-26T23:00:00Z"), toIso: "2026-07-26T23:00:00Z",
      seqLedgerComplete: true, expectFirstSeq: 1, expectHeadSeq: 3,
    };
    const r = evaluate({
      live: ingestText("live", liveText, o),
      shadow: ingestText("shadow", shadowText, o),
      opts: o,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });
    // The seq subsystem must have ACTUALLY RUN against real producer output.
    expect(r.blockers.map((b) => b.id)).not.toContain("SEQ_ATTR_ABSENT");
    expect(r.checks.find((c) => c.id === "SEQ_WIRE_ORDER").status).toBe("pass");
    expect(r.checks.find((c) => c.id === "SEQ_CONTIGUITY").status).toBe("pass");
    expect(r.checks.find((c) => c.id === "SEQ_COVERAGE").status).toBe("pass");
    expect(r.exitCode).toBe(EXIT_HEALTHY);
  });

  test("the declared provider-type census matches the harness's structural-blind-spot list", async () => {
    const { UNMAPPABLE_PROVIDER_TYPES } = await import("./parity-harness.mjs");
    for (const u of UNMAPPABLE_PROVIDER_TYPES) {
      expect(DECLARED_UNMAPPABLE_TYPES[u.source].has(u.type)).toBe(true);
      expect(DECLARED_MAPPABLE_TYPES[u.source].has(u.type)).toBe(false);
    }
  });
});

// --------------------------------------------------------------------------
// C5 — dedup ordering: mark seen only AFTER the write succeeded
// --------------------------------------------------------------------------

describe("a failed append never poisons the dedup ring", () => {
  test("an append that throws leaves the delivery id UNSEEN", async () => {
    const seen = new Set();
    const r = await runOnce({
      fetchImpl: async () => res({ head: 3, lines: [ghEvent(1, "d1"), ghEvent(2, "d2"), ghEvent(3, "d3")] }),
      token: "",
      since: 0,
      appender: { dir: "<broken>", write: () => { throw new Error("EACCES: shadow dir is not writable"); } },
      seen,
      log: collectLogs(),
    });
    expect(r.status).toBe(EXIT_UNEVALUATED);
    expect([...seen]).toEqual([]);
    expect(r.cursorAdvancedTo).toBe(null);
  });

  test("the retry after a write failure re-appends the delivery instead of silently deduping it", async () => {
    // Pass 1: the shadow directory is a regular FILE, so every append throws.
    writeFileSync(resolve(dir, SHADOW_DIR_NAME), "not a directory");
    const first = await runMain(["--once", "--since", "0"], [
      res({ head: 3, lines: [ghEvent(1, "d1"), ghEvent(2, "d2"), ghEvent(3, "d3")] }),
    ]);
    expect(first.code).toBe(EXIT_UNEVALUATED);
    const persisted = JSON.parse(readFileSync(statePath(dir), "utf8"));
    expect(persisted.seenDeliveryIds).toEqual([]);
    expect(persisted.cursor).toBe(0);

    // The condition clears; the same range is refetched.
    rmSync(resolve(dir, SHADOW_DIR_NAME), { force: true });
    const second = await runMain(["--once", "--since", "0"], [
      res({ head: 3, lines: [ghEvent(1, "d1"), ghEvent(2, "d2"), ghEvent(3, "d3")] }),
    ]);
    expect(second.code).toBe(EXIT_HEALTHY);
    expect(shadowLines().map((l) => l.attributes["webhook.delivery.id"])).toEqual(["d1", "d2", "d3"]);
  });
});

// --------------------------------------------------------------------------
// C6/H4/H13 — a PROVEN coverage hole: durable marker, no cursor advance
// --------------------------------------------------------------------------

describe("a proven coverage hole leaves durable evidence and does not burn the cursor", () => {
  test("a late-started replay writes a feed-gap marker naming the undelivered range", async () => {
    const app = memAppender();
    const r = await runOnce({
      fetchImpl: async () => res({ head: 605, lines: [ghEvent(601, "d601"), ghEvent(602, "d602")] }),
      token: "",
      since: 500,
      appender: app,
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.status).toBe(EXIT_PROBLEM);
    expect(r.coverage.ok).toBe(false);
    const gaps = app.records.filter((x) => x.attributes?.["event.name"] === MARKER_FEED_GAP);
    expect(gaps.length).toBe(1);
    expect(gaps[0].reason).toBe("coverage-late-start");
    expect(gaps[0].body.missingFrom).toBe(501);
    expect(gaps[0].body.missingTo).toBe(600);
  });

  test("the cursor is NOT advanced past a proven hole, in-process or across a restart", async () => {
    const first = await runMain(["--once", "--since", "0"], [
      res({ head: 10, lines: [ghEvent(9, "d9"), ghEvent(10, "d10")] }),
    ]);
    expect(first.code).toBe(EXIT_PROBLEM);
    expect(JSON.parse(readFileSync(statePath(dir), "utf8")).cursor).toBe(0);

    // A supervised restart must NOT resume beyond the hole.
    const second = await runMain(["--once"], [res({ head: 10, lines: [ghEvent(9, "d9"), ghEvent(10, "d10")] })]);
    expect(second.requested[0]).toContain("since=0");
    expect(second.code).toBe(EXIT_PROBLEM);
  });

  test("the durable marker is what makes a later parity run non-evaluable instead of green", async () => {
    const { evaluate, ingestText, parseArgs } = await import("./parity-harness.mjs");
    await runMain(["--once", "--since", "0"], [
      res({ head: 10, lines: [ghEvent(9, "d9", { receivedAt: "2026-07-26T22:11:00.000Z" })] }),
    ]);
    const written = shadowLines();
    const shadowText = written.map((l) => JSON.stringify(l)).join("\n");
    // The gap marker is stamped with the wall clock, so derive the window from the
    // records themselves (edge margin 0 — this case is about the marker, not edges).
    const stamps = written.map((l) => Date.parse(l.ts)).sort((a, b) => a - b);
    const o = {
      ...parseArgs([]).opts,
      edgeMarginMs: 0,
      fromMs: stamps[0], fromIso: new Date(stamps[0]).toISOString(),
      toMs: stamps[stamps.length - 1], toIso: new Date(stamps[stamps.length - 1]).toISOString(),
    };
    const r = evaluate({
      live: ingestText("live", shadowText, o),
      shadow: ingestText("shadow", shadowText, o),
      opts: o,
      generatedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(r.blockers.some((b) => b.id === "FEED_GAP_DECLARED")).toBe(true);
    expect(r.exitCode).toBe(2);
  });

  test("a SHORT READ still advances (nothing was skipped) but stays a loud problem with no false gap marker", async () => {
    const app = memAppender();
    const r = await runOnce({
      fetchImpl: async () => res({ head: 9, lines: [ghEvent(1, "d1"), ghEvent(2, "d2")] }),
      token: "",
      since: 0,
      appender: app,
      seen: new Set(),
      log: collectLogs(),
    });
    expect(r.status).toBe(EXIT_PROBLEM);
    expect(r.cursorAdvancedTo).toBe(2);
    expect(app.records.filter((x) => x.attributes?.["event.name"] === MARKER_FEED_GAP).length).toBe(0);
  });

  test("a non-healthy pass that makes NO progress is bounded, not spun on forever", async () => {
    const stuck = () => res({ head: 10, lines: [ghEvent(9, "d9"), ghEvent(10, "d10")] });
    const { code, requested } = await runMain(
      ["--since", "0", "--max-consecutive-failures", "3"],
      [stuck(), stuck(), stuck(), stuck(), stuck()],
    );
    expect(code).toBe(EXIT_PROBLEM);
    expect(requested.length).toBe(3);
    expect(requested.every((u) => u.includes("since=0"))).toBe(true);
  });
});

// --------------------------------------------------------------------------
// H3/H5/H6/M9 — a flag whose value was eaten must never fall through
// --------------------------------------------------------------------------

describe("value-taking flags reject a missing/empty/flag-shaped value", () => {
  test.each([...VALUE_FLAGS])("%s in final position is an error, not a silent drop", (flag) => {
    const parsed = parseArgv(["--once", flag]);
    expect(parsed.errors.length).toBeGreaterThan(0);
  });

  test.each(["--since=", "--base-url=", "--require-source=", "--ts-mode=", "--interval-ms=", "--max-passes="])(
    "%s with an empty value is an error",
    (flag) => {
      expect(parseArgv(["--once", flag]).errors.length).toBeGreaterThan(0);
    },
  );

  test("a flag-shaped value is rejected rather than consumed", () => {
    expect(parseArgv(["--since", "--json"]).errors.length).toBeGreaterThan(0);
  });

  test("--since with the value eaten does NOT silently resume from the persisted cursor", async () => {
    writeState(dir, { cursor: 900, seenDeliveryIds: [] });
    const { code, requested } = await runMain(["--once", "--since"], []);
    expect(code).toBe(EXIT_UNEVALUATED);
    expect(requested.length).toBe(0); // nothing was scanned at all
  });

  test("--require-source with the value eaten does NOT disable the dead-source detector", async () => {
    const { code } = await runMain(["--once", "--since", "0", "--require-source"], []);
    expect(code).toBe(EXIT_UNEVALUATED);
    // and an explicitly EMPTY list is equally rejected
    expect(parseArgv(["--require-source", ","]).errors.length).toBeGreaterThan(0);
  });

  test("--base-url with the value eaten does NOT silently probe the default staging feed", async () => {
    const { code, requested } = await runMain(["--once", "--since", "0", "--base-url"], []);
    expect(code).toBe(EXIT_UNEVALUATED);
    expect(requested.length).toBe(0);
    expect(parseArgv(["--base-url", "not-a-url"]).errors.length).toBeGreaterThan(0);
  });

  test("a malformed or zero poll interval in the ENV is rejected exactly like the flag", async () => {
    for (const bad of ["banana", "0"]) {
      const code = await main(["--since", "0"], {
        catalystDir: dir,
        tokenOverride: TOKEN,
        linearTeams: [],
        botUserIds: new Set(),
        env: { CATALYST_CLOUD_EVENT_POLL_MS: bad },
        fetchImpl: async () => {
          throw new Error("must not be called");
        },
        stdout: () => {},
        stderr: () => {},
        sleep: async () => {},
      });
      expect(code).toBe(EXIT_UNEVALUATED);
    }
  });
});

// --------------------------------------------------------------------------
// the negative control itself
// --------------------------------------------------------------------------

describe("--self-test is the credential-free negative control", () => {
  test("it runs with no token, no network, no filesystem and every detector fires", async () => {
    const out = [];
    const code = await runSelfTest({ stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
    const text = out.join("");
    expect(code).toBe(EXIT_HEALTHY);
    expect(text).not.toContain("FAIL");
    // observed RED, not merely "runs"
    expect(text).toMatch(/detectors expected RED/);
    const reds = text.split("\n").filter((l) => /expect=[12] /.test(l));
    expect(reds.length).toBeGreaterThanOrEqual(9);
  });

  test("main --self-test needs no credential and no CATALYST_DIR", async () => {
    const code = await main(["--self-test"], {
      env: {},
      stdout: () => {},
      stderr: () => {},
      fetchImpl: async () => {
        throw new Error("must not be called");
      },
    });
    expect(code).toBe(EXIT_HEALTHY);
  });
});

// CTL-1534 (M10): the shadow-dir guard was purely LEXICAL, and resolve() does not
// follow symlinks. A symlinked <root>/events-shadow -> <root>/events passed every
// lexical check and would have written the LIVE event log, double-waking every
// worker — while the safety self-test printed PASS. These pin the real-path guard.
describe("CTL-1534 M10 — shadow dir cannot resolve onto the live event log", () => {
  test("refuses a shadow dir that is a symlink to the live events dir", () => {
    const root = mkdtempSync(join(tmpdir(), "m10-sym-"));
    mkdirSync(join(root, "events"), { recursive: true });
    symlinkSync(join(root, "events"), join(root, "events-shadow"));
    expect(() => resolveShadowDir(root)).toThrow();
  });

  test("refuses a shadow dir symlinked anywhere that resolves under the live dir", () => {
    const root = mkdtempSync(join(tmpdir(), "m10-nest-"));
    mkdirSync(join(root, "events", "inner"), { recursive: true });
    symlinkSync(join(root, "events", "inner"), join(root, "events-shadow"));
    expect(() => resolveShadowDir(root)).toThrow();
  });

  test("accepts an ordinary shadow dir", () => {
    const root = mkdtempSync(join(tmpdir(), "m10-ok-"));
    mkdirSync(join(root, "events"), { recursive: true });
    expect(resolveShadowDir(root)).toBe(join(root, "events-shadow"));
  });

  test("shadow filename does not collide with the live log basename", () => {
    const root = mkdtempSync(join(tmpdir(), "m10-name-"));
    const f = shadowFilePath(root, new Date(Date.UTC(2026, 6, 1)));
    expect(basename(f)).toBe("shadow-2026-07.jsonl");
    expect(basename(f)).not.toBe("2026-07.jsonl");
  });
});
