// CTL-938: unit tests for the live SCREEN poller — the pre-transcript wedge
// window. `claude logs <shortId>` dumps a bg session's rendered screen buffer
// (ANSI, no follow flag), so the poller's whole contract is poll → normalize →
// diff → emit-on-change, with terminal outcomes for a gone session and an
// absent claude CLI. Everything here runs against an INJECTED exec fn — no
// real `claude`, no subprocess.
import { describe, it, expect } from "bun:test";
import {
  stripAnsi,
  normalizeScreen,
  deriveScreenShortId,
  ScreenPoller,
  SCREEN_POLL_MS,
  type ScreenLogsResult,
} from "../lib/ec-worker-screen.mjs";

// ── ANSI normalization ───────────────────────────────────────────────────────
describe("stripAnsi / normalizeScreen", () => {
  it("strips CSI colour/cursor sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m plain \x1b[2J\x1b[H")).toBe(
      "red plain ",
    );
  });

  it("strips OSC title sequences (BEL- and ST-terminated)", () => {
    expect(stripAnsi("\x1b]0;my title\x07body")).toBe("body");
    expect(stripAnsi("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
  });

  it("strips lone two-byte ESC sequences but keeps text", () => {
    expect(stripAnsi("\x1b(Bhello \x1b=world")).toBe("hello world");
  });

  it("normalizeScreen converts CRLF, trims trailing line whitespace and trailing blank lines", () => {
    const raw = "\x1b[1mline one\x1b[0m   \r\nline two\t \r\n\r\n   \r\n";
    expect(normalizeScreen(raw)).toBe("line one\nline two");
  });

  it("normalizeScreen is identical for two renders that differ only in ANSI styling", () => {
    const a = "\x1b[32m> waiting\x1b[0m\n";
    const b = "\x1b[2m> waiting\x1b[0m\n";
    expect(normalizeScreen(a)).toBe(normalizeScreen(b));
  });
});

// ── shortId derivation (claude logs only accepts the 8-char form) ────────────
describe("deriveScreenShortId", () => {
  it("passes an 8-char hex short id through", () => {
    expect(deriveScreenShortId("abcd1234")).toBe("abcd1234");
  });

  it("truncates a full session/job UUID to its 8-char prefix", () => {
    expect(deriveScreenShortId("abcd1234-9d9c-4ef2-aaaa-bbbbccccdddd")).toBe(
      "abcd1234",
    );
  });

  it("rejects malformed input with null (never throws)", () => {
    expect(deriveScreenShortId("not a uuid!")).toBeNull();
    expect(deriveScreenShortId("..%2Fetc")).toBeNull();
    expect(deriveScreenShortId("")).toBeNull();
    expect(deriveScreenShortId(null)).toBeNull();
    expect(deriveScreenShortId(undefined)).toBeNull();
    expect(deriveScreenShortId("ABCD1234")).toBeNull(); // claude ids are lowercase hex
  });
});

// ── poll + diff (emit only on change) ────────────────────────────────────────
function execQueue(results: ScreenLogsResult[]): (shortId: string) => Promise<ScreenLogsResult> {
  let i = 0;
  return () => Promise.resolve(results[Math.min(i++, results.length - 1)]);
}

describe("ScreenPoller — change-driven frames", () => {
  it("emits a frame on the first successful poll", async () => {
    const poller = new ScreenPoller("abcd1234", {
      exec: execQueue([{ status: "ok", stdout: "\x1b[1m> idle prompt\x1b[0m\n" }]),
    });
    const res = await poller.poll();
    expect(res).toEqual({ kind: "frame", screen: "> idle prompt" });
  });

  it("same screen → no emit (unchanged), even when ANSI styling differs", async () => {
    const poller = new ScreenPoller("abcd1234", {
      exec: execQueue([
        { status: "ok", stdout: "\x1b[32mscreen A\x1b[0m" },
        { status: "ok", stdout: "\x1b[2mscreen A\x1b[0m" },
      ]),
    });
    expect((await poller.poll()).kind).toBe("frame");
    expect(await poller.poll()).toEqual({ kind: "unchanged" });
    expect(poller.unchangedPolls).toBe(1);
  });

  it("changed screen → emits the full new screen and resets the unchanged counter", async () => {
    const poller = new ScreenPoller("abcd1234", {
      exec: execQueue([
        { status: "ok", stdout: "screen A" },
        { status: "ok", stdout: "screen A" },
        { status: "ok", stdout: "screen B\nline 2" },
      ]),
    });
    await poller.poll();
    await poller.poll();
    expect(poller.unchangedPolls).toBe(1);
    const res = await poller.poll();
    expect(res).toEqual({ kind: "frame", screen: "screen B\nline 2" });
    expect(poller.unchangedPolls).toBe(0);
  });

  it("session gone → terminal { kind: 'gone' } (exec reports a non-zero claude logs)", async () => {
    const poller = new ScreenPoller("abcd1234", {
      exec: execQueue([
        { status: "ok", stdout: "screen A" },
        { status: "gone", detail: "No such job: abcd1234" },
      ]),
    });
    await poller.poll();
    const res = await poller.poll();
    expect(res).toEqual({ kind: "gone", reason: "No such job: abcd1234" });
  });

  it("claude CLI absent → terminal { kind: 'unavailable' }", async () => {
    const poller = new ScreenPoller("abcd1234", {
      exec: execQueue([{ status: "unavailable", detail: "claude: ENOENT" }]),
    });
    expect(await poller.poll()).toEqual({
      kind: "unavailable",
      reason: "claude: ENOENT",
    });
  });

  it("an exec that THROWS is contained as unavailable (the poller never throws)", async () => {
    const poller = new ScreenPoller("abcd1234", {
      exec: () => Promise.reject(new Error("boom")),
    });
    expect(await poller.poll()).toEqual({ kind: "unavailable", reason: "boom" });
  });

  it("exposes the production poll cadence (~2s) for the route to reuse", () => {
    expect(SCREEN_POLL_MS).toBe(2000);
  });
});
