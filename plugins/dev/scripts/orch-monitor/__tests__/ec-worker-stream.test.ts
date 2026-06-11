// CTL-887 (BFF5): unit tests for the live EC-worker transcript tail. Encodes the
// ticket's Gherkin acceptance scenarios against the RESTING-transcript JSONL
// format that every Claude Code session writes to
// ~/.claude/projects/<dir>/<sessionId>.jsonl — pure parser + incremental tail,
// no live worker, no network.
//
//   • "A running worker streams its live transcript" — tool calls, text,
//      turns, retries, rate-limits are emitted as the file grows.
//   • "And reasoning rows (◌ thinking…) are emitted" — assistant `thinking`
//      blocks surface as `reasoning` StreamEvents.
//   • "Footer counters and diagnostics derive from the stream" — event/tool/
//      retry counts are derivable client-side from the emitted rows.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  parseTranscriptLine,
  TranscriptTail,
  INITIAL_TAIL_BYTES,
  type StreamEvent,
} from "../lib/ec-worker-stream.mjs";

const TS = "2026-06-08T14:02:11.000Z";
const TS_MS = Date.parse(TS);

function assistant(content: unknown[], timestamp = TS): string {
  return JSON.stringify({
    type: "assistant",
    timestamp,
    sessionId: "sess-uuid",
    message: { role: "assistant", model: "claude-opus-4-8", content },
  });
}

describe("parseTranscriptLine — typed StreamEvents from the resting transcript", () => {
  it("emits a tool_start (with a one-line input preview) for an assistant tool_use block", () => {
    const events = parseTranscriptLine(
      assistant([
        { type: "tool_use", name: "Bash", input: { command: "bun test board", description: "run tests" } },
      ]),
    );
    const tool = events.find((e) => e.type === "tool_start");
    expect(tool).toBeDefined();
    expect(tool!.tool).toBe("Bash");
    expect(tool!.toolInput).toBe("bun test board");
    expect(tool!.ts).toBe(TS_MS);
  });

  it("emits a text row for an assistant text block", () => {
    const events = parseTranscriptLine(assistant([{ type: "text", text: "Editing board-data.mjs now" }]));
    const text = events.find((e) => e.type === "text");
    expect(text).toBeDefined();
    expect(text!.text).toBe("Editing board-data.mjs now");
  });

  it("emits a reasoning row (◌ thinking…) for an assistant thinking block", () => {
    const events = parseTranscriptLine(
      assistant([{ type: "thinking", thinking: "I should reconcile the phase signal schema first" }]),
    );
    const reasoning = events.find((e) => e.type === "reasoning");
    expect(reasoning).toBeDefined();
    expect(reasoning!.text).toContain("reconcile the phase signal schema");
  });

  it("anchors every assistant message with one turn row carrying its turnTools", () => {
    const events = parseTranscriptLine(
      assistant([
        { type: "text", text: "Running two tools" },
        { type: "tool_use", name: "Read", input: { file_path: "/a/types.ts" } },
        { type: "tool_use", name: "Edit", input: { file_path: "/a/board.tsx" } },
      ]),
    );
    const turns = events.filter((e) => e.type === "turn");
    expect(turns).toHaveLength(1);
    expect(turns[0].turnTools).toEqual(["Read", "Edit"]);
    expect(turns[0].text).toBe("Running two tools");
  });

  it("emits a retry row from a system api_error (generic overloaded)", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "api_error",
      timestamp: TS,
      retryAttempt: 2,
      maxRetries: 10,
      retryInMs: 1109,
      error: { error: { error: { type: "overloaded_error" } } },
    });
    const events = parseTranscriptLine(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("retry");
    expect(events[0].retryInfo).toEqual({ attempt: 2, maxRetries: 10, error: "overloaded_error" });
  });

  it("emits a rate_limit row (not a retry) when the api_error is a rate-limit", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "api_error",
      timestamp: TS,
      retryAttempt: 1,
      maxRetries: 10,
      retryInMs: 8000,
      error: { error: { error: { type: "rate_limit_error" } } },
    });
    const events = parseTranscriptLine(line);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("rate_limit");
    expect(events[0].rateLimitInfo?.status).toContain("rate_limit");
    // resetsAt is epoch-SECONDS = (ts + retryInMs) / 1000
    expect(events[0].rateLimitInfo?.resetsAt).toBe(Math.round((TS_MS + 8000) / 1000));
  });

  it("falls back to `now` when a record carries no timestamp", () => {
    const now = 1_700_000_000_000;
    const events = parseTranscriptLine(
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
      now,
    );
    expect(events.every((e) => e.ts === now)).toBe(true);
  });

  it("returns [] for malformed JSON and for user/tool_result records (no own row)", () => {
    expect(parseTranscriptLine("not json")).toEqual([]);
    expect(parseTranscriptLine("")).toEqual([]);
    expect(
      parseTranscriptLine(
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }),
      ),
    ).toEqual([]);
  });

  it("footer counters are derivable client-side from the emitted rows", () => {
    // Scenario: "event/tool/retry counts are derivable client-side from received rows".
    const lines = [
      assistant([{ type: "text", text: "starting" }]),
      assistant([{ type: "tool_use", name: "Read", input: { file_path: "/x" } }]),
      assistant([{ type: "tool_use", name: "Edit", input: { file_path: "/y" } }]),
      JSON.stringify({
        type: "system",
        subtype: "api_error",
        timestamp: TS,
        retryAttempt: 1,
        maxRetries: 10,
        error: { error: { error: { type: "overloaded_error" } } },
      }),
    ];
    const events: StreamEvent[] = lines.flatMap((l) => parseTranscriptLine(l));
    const toolCalls = events.filter((e) => e.type === "tool_start").length;
    const retries = events.filter((e) => e.type === "retry").length;
    const turns = events.filter((e) => e.type === "turn").length;
    expect(toolCalls).toBe(2);
    expect(retries).toBe(1);
    expect(turns).toBe(3);
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("TranscriptTail — incremental file-growth tail", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ec-worker-stream-"));
    file = join(dir, "session.jsonl");
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns [] for a missing file", async () => {
    const tail = new TranscriptTail(join(dir, "absent.jsonl"));
    expect(await tail.poll()).toEqual([]);
  });

  it("emits StreamEvents as the file grows across polls (the live tail)", async () => {
    writeFileSync(file, assistant([{ type: "text", text: "first turn" }]) + "\n");
    const tail = new TranscriptTail(file);
    const first = await tail.poll();
    expect(first.some((e) => e.type === "text" && e.text === "first turn")).toBe(true);

    // No growth → no new events.
    expect(await tail.poll()).toEqual([]);

    // Append a new record; only the delta is parsed.
    appendFileSync(file, assistant([{ type: "tool_use", name: "Bash", input: { command: "ls" } }]) + "\n");
    const second = await tail.poll();
    expect(second.some((e) => e.type === "tool_start" && e.tool === "Bash")).toBe(true);
    expect(second.some((e) => e.type === "text" && e.text === "first turn")).toBe(false);
  });

  it("carries a partial trailing line forward until its newline arrives", async () => {
    const tail = new TranscriptTail(file);
    const full = assistant([{ type: "tool_use", name: "Read", input: { file_path: "/z" } }]);
    // Write the record WITHOUT a trailing newline → partial, not yet parseable.
    writeFileSync(file, full);
    expect(await tail.poll()).toEqual([]);
    // Now complete the line.
    appendFileSync(file, "\n");
    const events = await tail.poll();
    expect(events.some((e) => e.type === "tool_start" && e.tool === "Read")).toBe(true);
  });

  it("primes from the tail of a large existing file without replaying the whole thing", async () => {
    // A resting transcript larger than INITIAL_TAIL_BYTES: only the recent
    // window should be replayed on first poll.
    const filler = assistant([{ type: "text", text: "old line" }]) + "\n";
    const repeats = Math.ceil((INITIAL_TAIL_BYTES * 2) / filler.length);
    writeFileSync(file, filler.repeat(repeats));
    const tail = new TranscriptTail(file);
    const first = await tail.poll();
    // It replayed *some* recent rows, but far fewer than the full file.
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(repeats);

    // A brand-new appended record is still picked up cleanly afterwards.
    appendFileSync(file, assistant([{ type: "tool_use", name: "Grep", input: { pattern: "foo" } }]) + "\n");
    const second = await tail.poll();
    expect(second.some((e) => e.type === "tool_start" && e.tool === "Grep")).toBe(true);
  });

  it("restarts cleanly if the file is truncated/rotated under it", async () => {
    // Seed with several records so the offset advances well past a later, smaller file.
    const big =
      assistant([{ type: "text", text: "before one with a fairly long body so the offset advances" }]) +
      "\n" +
      assistant([{ type: "text", text: "before two also long enough to move the read offset forward" }]) +
      "\n";
    writeFileSync(file, big);
    const tail = new TranscriptTail(file);
    await tail.poll();
    // Truncate to a strictly smaller size (size < offset) → the tail must reset.
    writeFileSync(file, assistant([{ type: "text", text: "after" }]) + "\n");
    const events = await tail.poll();
    expect(events.some((e) => e.type === "text" && e.text === "after")).toBe(true);
  });
});
