// feed-progress.test.mjs — CTL-1902.
//
// The property under test is asymmetric: a FALSE NEGATIVE (a healthy quiet feed
// read as unhealthy) silently disables the cutover, and a FALSE POSITIVE (a
// frozen feed read as healthy) silently suppresses live webhook events with no
// replacement. Both directions are pinned, and the quiet-feed case is pinned
// hardest because it is the one the ticket's own acceptance criterion got wrong.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_FRAME_STALE_MS,
  FEED_PROGRESS_SUFFIX,
  DEFAULT_RECORD_STALE_MS,
  buildFeedProgressRecord,
  classifyFeedHealth,
  feedProgressPath,
  readFeedProgress,
  writeFeedProgress,
} from "./feed-progress.mjs";

const NOW = 1_786_940_000_000;
const ok = (over = {}) => ({
  ok: true,
  record: buildFeedProgressRecord({ now: NOW, cursor: 1146621, lastFrameAt: NOW - 5_000, status: "live", rows: 4129, pid: 123, ...over }),
});

describe("feedProgressPath", () => {
  test("is a sibling of the db, never the db itself", () => {
    expect(feedProgressPath("/x/catalyst-replica.db")).toBe("/x/catalyst-replica.db.feed-progress.json");
    expect(feedProgressPath("")).toBe(null);
    expect(feedProgressPath(null)).toBe(null);
  });

  test("is NOT the SDK's writer.lock — that file is not ours to write", () => {
    // `<db>.writer.lock` is written by CatalystReplica. Publishing into it would
    // mean writing another component's single-writer lock file.
    expect(feedProgressPath("/x/db")).not.toContain("writer.lock");
  });
});

describe("classifyFeedHealth — the quiet-feed trap (the reason this module exists)", () => {
  test("⭐ a FROZEN CURSOR with fresh frames is HEALTHY", () => {
    // ⛔ CTL-1902's written AC says "heartbeat fresh + sync cursor frozen ⇒ NOT
    // ready". Implemented literally that is a regression: a healthy quiet feed
    // freezes the cursor exactly like a dead socket does. Reproduced live on
    // mini-2 2026-08-17 — successive cloud-sync freshness lines with
    // replica.cursor frozen at 1146621 and frame_staleness 5 s then 11 s, on a
    // node that was entirely current. Gating on cursor movement would have
    // un-armed the producer through every quiet window.
    const first = classifyFeedHealth(ok({ cursor: 1146621, lastFrameAt: NOW - 5_000 }), { now: NOW });
    const second = classifyFeedHealth(ok({ cursor: 1146621, lastFrameAt: NOW - 11_000 }), { now: NOW });
    expect(first.healthy).toBe(true);
    expect(second.healthy).toBe(true);
    expect(first.reason).toBe("ok");
  });

  test("cursor and rows are NOT consulted at all — a totally idle fleet is healthy", () => {
    // The strong form: zero rows, null cursor, nothing moving anywhere, but the
    // socket is being spoken to.
    const v = classifyFeedHealth(ok({ cursor: null, rows: 0, maxUpdatedMs: null, lastFrameAt: NOW - 1_000 }), { now: NOW });
    expect(v.healthy).toBe(true);
  });

  test("⭐ ACCEPTANCE (the AC's intent): a live writer whose FEED is frozen is NOT ready", () => {
    // This is the AC's real subject — writer-process liveness must not be
    // sufficient. Here the record is being published (so the writer is alive and
    // heartbeating) but no inbound frames have arrived, not even watchdog pongs,
    // which a healthy socket cannot produce.
    const v = classifyFeedHealth(ok({ lastFrameAt: NOW - (DEFAULT_FRAME_STALE_MS + 1) }), { now: NOW });
    expect(v.healthy).toBe(false);
    expect(v.reason).toBe("frame-silent");
  });

  test("NEGATIVE CONTROL: the same record with fresh frames IS ready", () => {
    // Without this, the test above would pass against a classifier that returned
    // false unconditionally.
    expect(classifyFeedHealth(ok({ lastFrameAt: NOW - 1_000 }), { now: NOW }).healthy).toBe(true);
  });

  test("the boundary is inclusive on the healthy side and exclusive past it", () => {
    expect(classifyFeedHealth(ok({ lastFrameAt: NOW - DEFAULT_FRAME_STALE_MS }), { now: NOW }).healthy).toBe(true);
    expect(classifyFeedHealth(ok({ lastFrameAt: NOW - DEFAULT_FRAME_STALE_MS - 1 }), { now: NOW }).healthy).toBe(false);
  });
});

describe("classifyFeedHealth — every way of failing to LOOK is its own reason", () => {
  test("absent / unreadable / malformed are distinct, and none is healthy", () => {
    for (const reason of ["absent", "unreadable", "malformed", "no-db-path"]) {
      const v = classifyFeedHealth({ ok: false, reason }, { now: NOW });
      expect(v.healthy).toBe(false);
      expect(v.reason).toBe(reason);
    }
  });

  test("a null/garbage read is not healthy", () => {
    for (const bad of [null, undefined, {}, { ok: false }, "nope"]) {
      expect(classifyFeedHealth(bad, { now: NOW }).healthy).toBe(false);
    }
  });

  test("a STALE record un-arms — this is what subsumes the old writer-liveness check", () => {
    // A dead writer stops publishing, so the record ages out. That is the same
    // fact the writer.lock heartbeat carried, now obtained without pretending it
    // said anything about the feed.
    const v = classifyFeedHealth(ok({ now: NOW - (DEFAULT_RECORD_STALE_MS + 1) }), { now: NOW });
    expect(v.healthy).toBe(false);
    expect(v.reason).toBe("record-stale");
  });

  test("a record with no timestamp is not healthy", () => {
    expect(classifyFeedHealth({ ok: true, record: { lastFrameAt: NOW } }, { now: NOW }).reason).toBe("record-no-timestamp");
  });

  test("⚠️ a record from the FUTURE is not evidence", () => {
    // Clock skew or a rollback would otherwise make an arbitrarily old record
    // look brand new, and `now - updatedAt <= staleMs` is satisfied by every
    // negative age. Same for the frame timestamp.
    expect(classifyFeedHealth(ok({ now: NOW + 60_000 }), { now: NOW }).reason).toBe("record-ahead-of-clock");
    expect(classifyFeedHealth(ok({ lastFrameAt: NOW + 60_000 }), { now: NOW }).reason).toBe("frame-ahead-of-clock");
  });

  test("⛔ an ABSENT lastFrameAt is NOT healthy — an older SDK degrades to un-armed, not to trusted", () => {
    // `lastFrameAt` is feature-detected (SDK 0.6.0+). If it is missing we cannot
    // tell quiet from dead, and "cannot tell" must never render as "fine".
    for (const v of [null, undefined, "x", NaN]) {
      const r = classifyFeedHealth(ok({ lastFrameAt: v }), { now: NOW });
      expect(r.healthy).toBe(false);
      expect(r.reason).toBe("frame-unknown");
    }
  });

  test("the writer's OWN stall verdict is honoured over anything derivable here", () => {
    // classifyStall already requires an independent transport-liveness failure,
    // so when it fires it is strictly stronger evidence. Note the frames are
    // FRESH here — without honouring genuineStall this would read healthy.
    const v = classifyFeedHealth(ok({ genuineStall: true, lastFrameAt: NOW - 1_000 }), { now: NOW });
    expect(v.healthy).toBe(false);
    expect(v.reason).toBe("genuine-stall");
  });
});

describe("write → read round-trip (the record reads back as written)", () => {
  const dir = mkdtempSync(join(tmpdir(), "feed-progress-"));
  const db = join(dir, "replica.db");

  test("a published record reads back byte-identically and classifies healthy", () => {
    const record = buildFeedProgressRecord({ now: NOW, cursor: 42, lastFrameAt: NOW - 1_000, status: "live", rows: 7, pid: 99 });
    expect(writeFeedProgress(db, record)).toBe(true);

    const back = readFeedProgress(db);
    expect(back.ok).toBe(true);
    expect(back.record).toEqual(record);
    expect(classifyFeedHealth(back, { now: NOW }).healthy).toBe(true);
  });

  test("it lands at the sibling path and leaves no .tmp behind", () => {
    writeFeedProgress(db, buildFeedProgressRecord({ now: NOW, lastFrameAt: NOW }));
    expect(JSON.parse(readFileSync(`${db}.feed-progress.json`, "utf8")).updatedAt).toBe(NOW);
    expect(() => readFileSync(`${db}.feed-progress.json.tmp`, "utf8")).toThrow();
  });

  test("NEGATIVE CONTROL: reading a db with no published record says `absent`, not healthy", () => {
    const missing = join(dir, "never-written.db");
    const read = readFeedProgress(missing);
    expect(read).toEqual({ ok: false, reason: "absent" });
    expect(classifyFeedHealth(read, { now: NOW }).healthy).toBe(false);
  });

  test("a corrupt file reads as `malformed`, not as absent and not as healthy", () => {
    const badDb = join(dir, "corrupt.db");
    // A truncated record — the shape a NON-atomic writer would leave behind, and
    // the reason this module writes tmp+rename.
    writeFileSync(`${badDb}${FEED_PROGRESS_SUFFIX}`, '{"updatedAt":17');
    const read = readFeedProgress(badDb);
    expect(read.ok).toBe(false);
    expect(read.reason).toBe("malformed");
    expect(classifyFeedHealth(read, { now: NOW }).healthy).toBe(false);
  });

  test("a file holding valid JSON that is not an object is `malformed`", () => {
    const scalarDb = join(dir, "scalar.db");
    writeFileSync(`${scalarDb}${FEED_PROGRESS_SUFFIX}`, "42");
    expect(readFeedProgress(scalarDb).reason).toBe("malformed");
  });

  test("a write failure is reported, never thrown — telemetry must not kill the writer", () => {
    expect(
      writeFeedProgress(db, buildFeedProgressRecord({ now: NOW }), {
        writeFile: () => {
          throw new Error("EROFS");
        },
      }),
    ).toBe(false);
    expect(writeFeedProgress(null, {})).toBe(false);
  });
});

describe("buildFeedProgressRecord — non-numbers never masquerade as evidence", () => {
  test("junk numeric fields become null rather than being carried through", () => {
    const r = buildFeedProgressRecord({ now: NOW, cursor: "42", lastFrameAt: "x", rows: NaN, maxUpdatedMs: Infinity, pid: null });
    expect(r.cursor).toBe(null);
    expect(r.lastFrameAt).toBe(null);
    expect(r.rows).toBe(null);
    expect(r.maxUpdatedMs).toBe(null);
    // ...and a record whose discriminator was junk classifies as unknown, not ok.
    expect(classifyFeedHealth({ ok: true, record: r }, { now: NOW }).reason).toBe("frame-unknown");
  });

  test("genuineStall is strictly boolean — a truthy string does not arm it, a true does", () => {
    expect(buildFeedProgressRecord({ genuineStall: "yes" }).genuineStall).toBe(false);
    expect(buildFeedProgressRecord({ genuineStall: true }).genuineStall).toBe(true);
  });
});
