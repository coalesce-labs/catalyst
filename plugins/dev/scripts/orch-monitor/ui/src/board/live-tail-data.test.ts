// live-tail-data.test.ts — units for the worker [● live] + ticket active-node
// live tail derivations (CTL-918 / DETAIL7). Each describe maps to a Gherkin
// scenario in the DETAIL7 ticket spec; the live tail's acceptance surface IS
// these pure functions (the React skin is a thin renderer over them).
//
// Pure module — no DOM (mirrors worker-burn-data.test.ts style). Run from ui:
//   cd ui && bun test src/board/live-tail-data.test.ts
import { describe, it, expect } from "bun:test";
import {
  appendLiveRows,
  resolvePausedView,
  deriveFooterCounters,
  deriveTailDiagnostics,
  deriveActiveNodeTail,
  deriveMvpRow,
  resolveLiveTerminalRows,
  resolveActivePhaseSession,
  parseStreamEvent,
  LIVE_BUFFER_CAP,
  ACTIVE_NODE_TAIL_LINES,
} from "./live-tail-data";
import type { StreamEvent } from "@/lib/types";
import type { BoardWorker } from "./types";

function bw(over: Partial<BoardWorker>): BoardWorker {
  return {
    name: "CTL-845:imp",
    ticket: "CTL-845",
    tickets: ["CTL-845"],
    phase: "implement",
    status: "running",
    activeState: "active",
    working: true,
    lastActiveMs: Date.now(),
    repo: "plugins/dev",
    team: "CTL",
    runtimeMs: 1000,
    costUSD: 0.1,
    sessionId: "uuid-imp",
    ...over,
  };
}

// ── row fixtures (the SSE wire shape from lib/ec-worker-stream) ──────────────
const toolStart = (tool: string, ts = 1000): StreamEvent => ({
  ts,
  type: "tool_start",
  tool,
  toolInput: `${tool} input`,
});
const text = (s: string, ts = 1000): StreamEvent => ({ ts, type: "text", text: s });
const reasoning = (s: string, ts = 1000): StreamEvent => ({
  ts,
  type: "reasoning",
  text: s,
});
const turn = (tools: string[], ts = 1000): StreamEvent => ({
  ts,
  type: "turn",
  turnTools: tools.length ? tools : undefined,
});
const retry = (error: string, ts = 1000): StreamEvent => ({
  ts,
  type: "retry",
  retryInfo: { attempt: 1, maxRetries: 5, error },
});
const rateLimit = (ts = 1000): StreamEvent => ({
  ts,
  type: "rate_limit",
  rateLimitInfo: { status: "rate_limited" },
});

// ── SSE frame parsing (the wire boundary into the live buffer) ───────────────
describe("parseStreamEvent — defensive SSE frame parsing", () => {
  it("parses a well-formed tool_start frame, copying only the known fields", () => {
    const row = parseStreamEvent(
      JSON.stringify({ ts: 1000, type: "tool_start", tool: "Edit", toolInput: "x", extra: "ignored" }),
    );
    expect(row).toEqual({ ts: 1000, type: "tool_start", tool: "Edit", toolInput: "x" });
  });

  it("parses retry / rate_limit / turn frames with their nested info", () => {
    const r = parseStreamEvent(
      JSON.stringify({ ts: 1, type: "retry", retryInfo: { attempt: 2, maxRetries: 5, error: "overloaded" } }),
    );
    expect(r?.retryInfo).toEqual({ attempt: 2, maxRetries: 5, error: "overloaded" });
    const rl = parseStreamEvent(JSON.stringify({ ts: 1, type: "rate_limit", rateLimitInfo: { status: "rl", resetsAt: 99 } }));
    expect(rl?.rateLimitInfo).toEqual({ status: "rl", resetsAt: 99 });
    const t = parseStreamEvent(JSON.stringify({ ts: 1, type: "turn", turnTools: ["Edit", "Bash"], usage: { context_pct: 33 } }));
    expect(t?.turnTools).toEqual(["Edit", "Bash"]);
    expect(t?.usage).toEqual({ context_pct: 33 });
  });

  it("returns null for malformed / off-shape frames (a bad line never crashes the tail)", () => {
    expect(parseStreamEvent("not json")).toBeNull();
    expect(parseStreamEvent("null")).toBeNull();
    expect(parseStreamEvent("42")).toBeNull();
    expect(parseStreamEvent(JSON.stringify({ type: "tool_start" }))).toBeNull(); // no ts
    expect(parseStreamEvent(JSON.stringify({ ts: 1 }))).toBeNull(); // no type
    expect(parseStreamEvent(JSON.stringify({ ts: 1, type: "bogus" }))).toBeNull(); // unknown type
  });
});

// ── Scenario: Worker [live] tab streams the running transcript ───────────────
describe("Scenario: Worker [live] tab streams the running transcript", () => {
  it("appends tool/text/turn/retry/rate_limit rows in arrival order", () => {
    let buf: StreamEvent[] = [];
    buf = appendLiveRows(buf, [turn(["Edit"]), toolStart("Edit")]);
    buf = appendLiveRows(buf, [text("done"), retry("overloaded")]);
    expect(buf.map((r) => r.type)).toEqual([
      "turn",
      "tool_start",
      "text",
      "retry",
    ]);
  });

  it("preserves thinking rows as reasoning rows (rendered as ◌ thinking…)", () => {
    const buf = appendLiveRows([], [reasoning("reconcile schema")]);
    expect(buf[0].type).toBe("reasoning");
    expect(buf[0].text).toBe("reconcile schema");
  });

  it("an empty incoming batch returns the SAME buffer reference (no re-render)", () => {
    const buf = [toolStart("Read")];
    expect(appendLiveRows(buf, [])).toBe(buf);
  });

  it("caps the rolling buffer, dropping the OLDEST rows (a tail, not a transcript)", () => {
    const many = Array.from({ length: LIVE_BUFFER_CAP + 50 }, (_, i) =>
      toolStart(`t${i}`, i),
    );
    const buf = appendLiveRows([], many);
    expect(buf.length).toBe(LIVE_BUFFER_CAP);
    // oldest 50 dropped → first retained row is t50
    expect(buf[0].tool).toBe("t50");
    expect(buf[buf.length - 1].tool).toBe(`t${LIVE_BUFFER_CAP + 49}`);
  });

  it("toggling [history] does NOT lose the live buffer (the buffer is owned by the hook, not the tab)", () => {
    // The buffer is a plain array the caller holds across tab switches; appending
    // is pure so the live buffer survives any number of history toggles.
    const buf = appendLiveRows([], [toolStart("Edit"), text("ok")]);
    // a history view does not touch the buffer; re-show live → same rows.
    expect(buf.length).toBe(2);
    expect(resolvePausedView(buf, false, 0).rows).toEqual(buf);
  });
});

// ── Scenario: Pause decouples view from data ─────────────────────────────────
describe("Scenario: Pause decouples view from data", () => {
  it("while paused the view freezes at the pause-time length while the buffer keeps growing", () => {
    let buf = appendLiveRows([], [toolStart("a", 1), toolStart("b", 2)]);
    const frozenLength = buf.length; // pause here (2 rows visible)
    // SSE keeps buffering behind the freeze
    buf = appendLiveRows(buf, [toolStart("c", 3), toolStart("d", 4)]);
    const view = resolvePausedView(buf, true, frozenLength);
    expect(view.rows.map((r) => r.tool)).toEqual(["a", "b"]); // frozen view
    expect(view.bufferedWhilePaused).toBe(2); // c, d streamed in behind the freeze
  });

  it("resume replays the gap — the full buffer becomes visible again", () => {
    let buf = appendLiveRows([], [toolStart("a", 1)]);
    const frozenLength = buf.length;
    buf = appendLiveRows(buf, [toolStart("b", 2), toolStart("c", 3)]);
    const resumed = resolvePausedView(buf, false, frozenLength);
    expect(resumed.rows.map((r) => r.tool)).toEqual(["a", "b", "c"]);
    expect(resumed.bufferedWhilePaused).toBe(0);
  });

  it("a buffer trimmed under the freeze can never produce a negative gap", () => {
    const buf = appendLiveRows([], [toolStart("a", 1)]);
    // frozenLength captured when buffer was larger, but it shrank (cap/trim)
    const view = resolvePausedView(buf, true, 99);
    expect(view.bufferedWhilePaused).toBe(0);
    expect(view.rows).toEqual(buf);
  });
});

// ── Scenario: Footer counters and diagnostics derive from received rows ──────
describe("Scenario: Footer counters and diagnostics derive from received rows", () => {
  it("footer shows events / tools / retries derived client-side", () => {
    const rows = [
      turn(["Edit", "Bash"]),
      toolStart("Edit"),
      toolStart("Bash"),
      text("ok"),
      retry("overloaded"),
    ];
    const f = deriveFooterCounters(rows);
    expect(f.events).toBe(5);
    expect(f.tools).toBe(2); // two tool_start rows (turn's turnTools not double-counted)
    expect(f.retries).toBe(1);
  });

  it("stream-size is the JSON byte length of the received rows (client-derived)", () => {
    const rows = [toolStart("Edit"), text("hello")];
    const f = deriveFooterCounters(rows);
    expect(f.streamBytes).toBeGreaterThan(0);
    // monotonic: more rows → at least as many bytes
    expect(deriveFooterCounters([...rows, text("more")]).streamBytes).toBeGreaterThan(
      f.streamBytes,
    );
  });

  it("DIAGNOSTICS retries/rate-limit/turn/tool-errors light up from the same rows", () => {
    const rows = [
      turn(["Edit"]),
      turn(["Bash"]),
      retry("overloaded_error"), // generic retry → tool/exec-error tell
      rateLimit(),
      retry("rate_limit_error"), // a retry naming rate-limit → counts as rate-limit
    ];
    const d = deriveTailDiagnostics(rows);
    expect(d.turn).toBe(2);
    expect(d.retries).toBe(2); // both retry rows
    expect(d.rateLimit).toBe(2); // explicit rate_limit + the rate-limit retry
    expect(d.toolErrors).toBe(1); // the one non-rate-limit retry
    expect(d.plumbed).toBe(true);
  });

  it("with zero received rows the rail stays DIMMED (plumbed:false), never a fabricated 0", () => {
    const d = deriveTailDiagnostics([]);
    expect(d.plumbed).toBe(false);
    expect(d).toMatchObject({ retries: 0, rateLimit: 0, turn: 0, toolErrors: 0 });
  });
});

// ── Scenario: Ticket active-node live tail ───────────────────────────────────
describe("Scenario: Ticket active-node live tail", () => {
  it("shows now: <current tool> · turn N from the per-phase live rows", () => {
    const rows = [
      turn(["Read"]),
      toolStart("Read"),
      turn(["Edit"]),
      toolStart("Edit", 2000), // latest tool → the current tool
    ];
    const a = deriveActiveNodeTail(rows);
    expect(a.currentTool).toBe("Edit");
    expect(a.turn).toBe(2);
    expect(a.hasRows).toBe(true);
  });

  it("surfaces ctx% from the stream's context_pct when present, else null (never fabricated)", () => {
    const withCtx: StreamEvent = {
      ts: 3000,
      type: "turn",
      usage: { context_pct: 41 },
    };
    expect(deriveActiveNodeTail([withCtx]).contextPct).toBe(41);
    // no context_pct anywhere → honest null (skin renders `ctx —`)
    expect(deriveActiveNodeTail([turn(["Edit"])]).contextPct).toBeNull();
  });

  it("provides exactly a 3-line in-loop tail (the newest rows)", () => {
    const rows = [
      toolStart("a", 1),
      toolStart("b", 2),
      toolStart("c", 3),
      toolStart("d", 4),
      toolStart("e", 5),
    ];
    const a = deriveActiveNodeTail(rows);
    expect(a.tail.length).toBe(ACTIVE_NODE_TAIL_LINES);
    expect(a.tail.map((r) => r.tool)).toEqual(["c", "d", "e"]);
  });

  it("empty rows → a null/empty summary so the skin keeps the resident node cells (never blank)", () => {
    const a = deriveActiveNodeTail([]);
    expect(a.hasRows).toBe(false);
    expect(a.currentTool).toBeNull();
    expect(a.turn).toBeNull();
    expect(a.contextPct).toBeNull();
    expect(a.tail).toEqual([]);
  });

  it("rides the SAME per-phase live source: resolves the running phase's sessionId from the live workers", () => {
    const workers = [
      bw({ phase: "research", sessionId: "uuid-res", working: false }),
      bw({ phase: "implement", sessionId: "uuid-imp", working: true }),
    ];
    expect(resolveActivePhaseSession("CTL-845", "implement", workers)).toBe("uuid-imp");
  });

  it("matches a multi-ticket worker via its tickets[] membership", () => {
    const workers = [bw({ ticket: "CTL-900", tickets: ["CTL-900", "CTL-845"], phase: "plan", sessionId: "uuid-multi" })];
    expect(resolveActivePhaseSession("CTL-845", "plan", workers)).toBe("uuid-multi");
  });

  it("returns null when no LIVE worker matches the active phase (finished/stale → resident cells only)", () => {
    expect(resolveActivePhaseSession("CTL-845", "implement", [])).toBeNull();
    // a matching but NOT-working worker has no live transcript to tail
    expect(
      resolveActivePhaseSession("CTL-845", "implement", [bw({ working: false })]),
    ).toBeNull();
    // no active phase (the ticket is settled) → null
    expect(resolveActivePhaseSession("CTL-845", null, [bw({})])).toBeNull();
  });
});

// ── Scenario: Graceful MVP when the stream is briefly unavailable ────────────
describe("Scenario: Graceful MVP when the stream is briefly unavailable", () => {
  it("synthesizes a single derived row (current tool stamped at lastActiveMs) — never an empty terminal", () => {
    const now = 100_000;
    const lastActive = 90_000; // 10s idle
    const row = deriveMvpRow("Edit", lastActive, now);
    expect(row).not.toBeNull();
    expect(row).toEqual({ ts: lastActive, type: "tool_start", tool: "Edit" });
  });

  it("falls back to `now` (age 0) when lastActiveMs is unknown", () => {
    const now = 100_000;
    expect(deriveMvpRow("Bash", null, now)).toEqual({
      ts: now,
      type: "tool_start",
      tool: "Bash",
    });
  });

  it("returns null when there is no current tool to synthesize from (honest placeholder, not a fake row)", () => {
    expect(deriveMvpRow(null, 90_000, 100_000)).toBeNull();
    expect(deriveMvpRow(undefined, null, 100_000)).toBeNull();
  });

  it("resolveLiveTerminalRows prefers REAL rows, then the MVP row, then empty — the never-blank rule", () => {
    const real = [toolStart("Edit")];
    expect(resolveLiveTerminalRows(real, "Read", 90_000, 100_000)).toEqual({
      rows: real,
      source: "live",
    });
    const mvp = resolveLiveTerminalRows([], "Read", 90_000, 100_000);
    expect(mvp.source).toBe("mvp");
    expect(mvp.rows.length).toBe(1);
    const empty = resolveLiveTerminalRows([], null, null, 100_000);
    expect(empty.source).toBe("empty");
    expect(empty.rows).toEqual([]);
  });
});
