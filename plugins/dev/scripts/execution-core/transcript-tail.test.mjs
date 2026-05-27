// transcript-tail.test.mjs — CTL-650 Phase 2. Per-session transcript state
// tracker built on the CTL-673 scanEventsChunked primitive. The pure
// applyEntry() reducer is tested directly (cheap); poll()'s incremental read,
// cross-poll leftover stitching, and truncation reset are exercised against
// real temp files (the scanEventsChunked contract opens the fd itself).

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTranscriptTracker, applyEntry, freshState } from "./transcript-tail.mjs";

const assistant = (stop_reason, lastBlock) => ({
  type: "assistant",
  message: { stop_reason, content: [{ type: "text", text: "preamble" }, lastBlock] },
});
const assistantText = (text, stop_reason = "end_turn") =>
  assistant(stop_reason, { type: "text", text });
const assistantTool = (name) => assistant(null, { type: "tool_use", name });
const userMsg = () => ({ type: "user", message: { content: [{ type: "text", text: "go" }] } });
const toolResult = () => ({
  type: "user",
  message: { content: [{ type: "tool_result", content: "ok" }] },
});

// ─── applyEntry (pure reducer) ────────────────────────────────────────────────

describe("applyEntry", () => {
  test("tracks last assistant block type, tool, stop_reason, text", () => {
    const s = freshState();
    applyEntry(s, assistantTool("AskUserQuestion"));
    expect(s.lastBlockType).toBe("tool_use");
    expect(s.lastTool).toBe("AskUserQuestion");
    expect(s.stopReason).toBe(null);

    applyEntry(s, assistantText("Should I proceed?"));
    expect(s.lastBlockType).toBe("text");
    expect(s.lastText).toBe("Should I proceed?");
    expect(s.stopReason).toBe("end_turn");
  });

  test("counts user + tool_result entries after the last assistant", () => {
    const s = freshState();
    applyEntry(s, assistantText("done"));
    applyEntry(s, userMsg());
    applyEntry(s, toolResult());
    expect(s.postUserOrResultCount).toBe(2);
  });

  test("a new assistant entry resets postUserOrResultCount to 0", () => {
    const s = freshState();
    applyEntry(s, assistantText("a"));
    applyEntry(s, userMsg());
    applyEntry(s, userMsg());
    expect(s.postUserOrResultCount).toBe(2);
    applyEntry(s, assistantText("b"));
    expect(s.postUserOrResultCount).toBe(0);
  });

  test("standalone tool_result-typed entry also counts", () => {
    const s = freshState();
    applyEntry(s, assistantTool("Bash"));
    applyEntry(s, { type: "tool_result" });
    expect(s.postUserOrResultCount).toBe(1);
  });
});

// ─── createTranscriptTracker.snapshot ─────────────────────────────────────────

describe("createTranscriptTracker.snapshot", () => {
  test("snapshot() returns the classifier input shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl650-tt-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, `${JSON.stringify(assistantText("Ready?"))}\n`);
    const tracker = createTranscriptTracker({ path });
    tracker.poll();
    const snap = tracker.snapshot();
    expect(snap).toMatchObject({
      hasTranscript: true,
      lastBlockType: "text",
      stopReason: "end_turn",
      lastText: "Ready?",
      postUserOrResultCount: 0,
    });
  });
});

// ─── createTranscriptTracker.poll (real FS) ───────────────────────────────────

describe("createTranscriptTracker.poll", () => {
  test("incremental poll picks up only newly-appended lines", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl650-tt-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(path, `${JSON.stringify(assistantTool("Bash"))}\n`);
    const tracker = createTranscriptTracker({ path });
    tracker.poll();
    expect(tracker.snapshot().lastBlockType).toBe("tool_use");
    expect(tracker.snapshot().postUserOrResultCount).toBe(0);

    appendFileSync(path, `${JSON.stringify(toolResult())}\n`);
    tracker.poll();
    expect(tracker.snapshot().postUserOrResultCount).toBe(1);
  });

  test("a line split across two polls is reassembled via leftover", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl650-tt-"));
    const path = join(dir, "s.jsonl");
    const line = JSON.stringify(assistantText("partial line test"));
    const half = Math.floor(line.length / 2);
    writeFileSync(path, line.slice(0, half)); // no newline yet — partial
    const tracker = createTranscriptTracker({ path });
    tracker.poll();
    // Nothing complete yet.
    expect(tracker.snapshot().lastText).toBe(null);
    appendFileSync(path, `${line.slice(half)}\n`); // complete the line
    tracker.poll();
    expect(tracker.snapshot().lastText).toBe("partial line test");
  });

  test("truncation (size < cursor) resets the cursor and re-reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl650-tt-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(
      path,
      `${JSON.stringify(assistantText("first"))}\n${JSON.stringify(userMsg())}\n`,
    );
    const tracker = createTranscriptTracker({ path });
    tracker.poll();
    expect(tracker.snapshot().postUserOrResultCount).toBe(1);

    // Rotate: replace with a shorter file whose size < the old cursor.
    truncateSync(path, 0);
    writeFileSync(path, `${JSON.stringify(assistantTool("Edit"))}\n`);
    tracker.poll();
    const snap = tracker.snapshot();
    expect(snap.lastBlockType).toBe("tool_use");
    expect(snap.lastTool).toBe("Edit");
    expect(snap.postUserOrResultCount).toBe(0);
  });

  test("malformed JSON line is skipped (parseEventTailChunk contract)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl650-tt-"));
    const path = join(dir, "s.jsonl");
    writeFileSync(
      path,
      `{not json\n${JSON.stringify(assistantText("after bad line"))}\n`,
    );
    const tracker = createTranscriptTracker({ path });
    tracker.poll();
    expect(tracker.snapshot().lastText).toBe("after bad line");
  });

  test("snapshot() before any poll on a missing file still reports hasTranscript", () => {
    const tracker = createTranscriptTracker({ path: "/nonexistent/never.jsonl" });
    tracker.poll(); // no throw
    expect(tracker.snapshot().hasTranscript).toBe(true);
    expect(tracker.snapshot().lastBlockType).toBe(null);
  });
});
