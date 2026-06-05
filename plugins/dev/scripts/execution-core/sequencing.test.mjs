// sequencing.test.mjs — CTL-537 sequencing-seam unit tests.
// Run: cd plugins/dev/scripts/execution-core && bun test sequencing.test.mjs
import { describe, test, expect, beforeEach } from "bun:test";
import {
  buildSequencingContext,
  buildSequencingPrompt,
  parseSequencingVerdict,
  sequencingCacheKey,
  defaultCheckSequencing,
  __resetSequencingCacheForTests,
} from "./sequencing.mjs";

// ── Phase 2: pure core ──

describe("buildSequencingContext", () => {
  test("present triage contributes classification + summary", () => {
    const readTriage = (_orchDir, id) =>
      id === "CTL-1"
        ? { classification: "feature", summary: "Add auth" }
        : null;
    const ctx = buildSequencingContext({
      candidate: "CTL-1",
      inFlightTickets: ["CTL-2", "CTL-3"],
      orchDir: "/fake",
      readTriage,
    });
    expect(ctx.candidate).toEqual({ id: "CTL-1", classification: "feature", summary: "Add auth" });
    expect(ctx.inFlight).toEqual([{ id: "CTL-2" }, { id: "CTL-3" }]);
  });

  test("missing triage degrades to id-only", () => {
    const readTriage = () => null;
    const ctx = buildSequencingContext({
      candidate: "CTL-1",
      inFlightTickets: ["CTL-2"],
      orchDir: "/fake",
      readTriage,
    });
    expect(ctx.candidate).toEqual({ id: "CTL-1" });
    expect(ctx.inFlight).toEqual([{ id: "CTL-2" }]);
  });

  test("empty inFlightTickets → empty inFlight array", () => {
    const readTriage = () => null;
    const ctx = buildSequencingContext({
      candidate: "CTL-1",
      inFlightTickets: [],
      orchDir: "/fake",
      readTriage,
    });
    expect(ctx.inFlight).toEqual([]);
  });
});

describe("buildSequencingPrompt", () => {
  test("deterministic — same input yields identical output", () => {
    const ctx = { candidate: { id: "CTL-1" }, inFlight: [{ id: "CTL-2" }] };
    expect(buildSequencingPrompt(ctx)).toBe(buildSequencingPrompt(ctx));
  });

  test("contains candidate id, in-flight ids, and JSON key instruction", () => {
    const ctx = { candidate: { id: "CTL-1" }, inFlight: [{ id: "CTL-2" }] };
    const prompt = buildSequencingPrompt(ctx);
    expect(prompt).toContain("CTL-1");
    expect(prompt).toContain("CTL-2");
    expect(prompt).toContain("hard_dependencies");
    expect(prompt).toContain("verdict");
  });
});

describe("parseSequencingVerdict", () => {
  test("valid hold verdict parsed verbatim", () => {
    const raw = JSON.stringify({ verdict: "hold", reason: "same area", hard_dependencies: [] });
    expect(parseSequencingVerdict(raw)).toEqual({ verdict: "hold", reason: "same area", hard_dependencies: [] });
  });

  test("valid verdict with hard_dependencies preserved", () => {
    const raw = JSON.stringify({
      verdict: "go",
      reason: "",
      hard_dependencies: [{ candidate: "CTL-1", blocked_by: "CTL-2", reason: "needs merge" }],
    });
    const v = parseSequencingVerdict(raw);
    expect(v.verdict).toBe("go");
    expect(v.hard_dependencies).toHaveLength(1);
    expect(v.hard_dependencies[0]).toMatchObject({ candidate: "CTL-1", blocked_by: "CTL-2" });
  });

  test("unknown verdict value → fail-open go", () => {
    const raw = JSON.stringify({ verdict: "unknown", reason: "", hard_dependencies: [] });
    expect(parseSequencingVerdict(raw)).toEqual({ verdict: "go", hard_dependencies: [] });
  });

  test("missing keys → fail-open go", () => {
    expect(parseSequencingVerdict(JSON.stringify({}))).toEqual({ verdict: "go", hard_dependencies: [] });
  });

  test("non-JSON → fail-open go", () => {
    expect(parseSequencingVerdict("not json")).toEqual({ verdict: "go", hard_dependencies: [] });
  });

  test("empty string → fail-open go", () => {
    expect(parseSequencingVerdict("")).toEqual({ verdict: "go", hard_dependencies: [] });
  });

  test("claude --output-format json envelope (result field) → unwraps inner verdict", () => {
    const inner = { verdict: "hold", reason: "x", hard_dependencies: [] };
    const envelope = JSON.stringify({ result: JSON.stringify(inner) });
    expect(parseSequencingVerdict(envelope)).toEqual({ verdict: "hold", reason: "x", hard_dependencies: [] });
  });

  test("claude --output-format json envelope (text field) → unwraps inner verdict", () => {
    const inner = { verdict: "go", reason: "", hard_dependencies: [] };
    const envelope = JSON.stringify({ text: JSON.stringify(inner) });
    const v = parseSequencingVerdict(envelope);
    expect(v.verdict).toBe("go");
  });

  test("non-extractable envelope → fail-open go", () => {
    const envelope = JSON.stringify({ result: "not json" });
    expect(parseSequencingVerdict(envelope)).toEqual({ verdict: "go", hard_dependencies: [] });
  });

  test("hard_dependencies with missing fields filtered out", () => {
    const raw = JSON.stringify({
      verdict: "go",
      reason: "",
      hard_dependencies: [
        { candidate: "CTL-1", blocked_by: "CTL-2", reason: "ok" },
        { candidate: "CTL-3" }, // missing blocked_by → filtered
        { blocked_by: "CTL-4" }, // missing candidate → filtered
      ],
    });
    const v = parseSequencingVerdict(raw);
    expect(v.hard_dependencies).toHaveLength(1);
  });
});

describe("sequencingCacheKey", () => {
  test("order-independent — different in-flight order yields same key", () => {
    expect(sequencingCacheKey("CTL-1", ["CTL-2", "CTL-3"])).toBe(
      sequencingCacheKey("CTL-1", ["CTL-3", "CTL-2"])
    );
  });

  test("different candidate → different key", () => {
    expect(sequencingCacheKey("CTL-1", ["CTL-2"])).not.toBe(
      sequencingCacheKey("CTL-9", ["CTL-2"])
    );
  });

  test("different in-flight set → different key", () => {
    expect(sequencingCacheKey("CTL-1", ["CTL-2"])).not.toBe(
      sequencingCacheKey("CTL-1", ["CTL-3"])
    );
  });
});

// ── Phase 3: defaultCheckSequencing ──

describe("defaultCheckSequencing", () => {
  beforeEach(() => __resetSequencingCacheForTests());

  const readTriage = () => null;
  const orchDir = "/fake";

  test("happy path — spawn returns valid verdict → returned verbatim; one spawn call", () => {
    const spawnCalls = [];
    const spawn = (_prompt) => {
      spawnCalls.push(true);
      return { status: 0, stdout: JSON.stringify({ verdict: "hold", reason: "area", hard_dependencies: [] }), stderr: "" };
    };
    const result = defaultCheckSequencing({
      candidate: "CTL-1",
      inFlightTickets: ["CTL-2"],
      orchDir,
      readTriage,
      spawn,
    });
    expect(result.verdict).toBe("hold");
    expect(spawnCalls).toHaveLength(1);
  });

  test("fail-open on non-zero spawn status → go", () => {
    const spawn = () => ({ status: 1, stdout: "", stderr: "error" });
    const result = defaultCheckSequencing({
      candidate: "CTL-1",
      inFlightTickets: ["CTL-2"],
      orchDir,
      readTriage,
      spawn,
    });
    expect(result.verdict).toBe("go");
    expect(result.hard_dependencies).toEqual([]);
  });

  test("fail-open on garbage stdout → go", () => {
    const spawn = () => ({ status: 0, stdout: "not json at all", stderr: "" });
    const result = defaultCheckSequencing({
      candidate: "CTL-1",
      inFlightTickets: ["CTL-2"],
      orchDir,
      readTriage,
      spawn,
    });
    expect(result.verdict).toBe("go");
  });

  test("fail-open on spawn throw → go, does not throw", () => {
    const spawn = () => { throw new Error("spawn died"); };
    expect(() =>
      defaultCheckSequencing({ candidate: "CTL-1", inFlightTickets: ["CTL-2"], orchDir, readTriage, spawn })
    ).not.toThrow();
    const result = defaultCheckSequencing({
      candidate: "CTL-1",
      inFlightTickets: ["CTL-2"],
      orchDir,
      readTriage,
      spawn,
    });
    expect(result.verdict).toBe("go");
  });

  test("cache hit — same (candidate, inFlightTickets) → spawn invoked once; second call served from cache", () => {
    const spawnCalls = [];
    const verdict = { verdict: "hold", reason: "area", hard_dependencies: [] };
    const spawn = () => { spawnCalls.push(true); return { status: 0, stdout: JSON.stringify(verdict), stderr: "" }; };
    const opts = { candidate: "CTL-1", inFlightTickets: ["CTL-2"], orchDir, readTriage, spawn };
    const r1 = defaultCheckSequencing(opts);
    const r2 = defaultCheckSequencing(opts);
    expect(spawnCalls).toHaveLength(1);
    expect(r1).toBe(r2); // same object reference from cache
  });

  test("cache invalidation — different in-flight set → spawn invoked twice", () => {
    const spawnCalls = [];
    const spawn = () => {
      spawnCalls.push(true);
      return { status: 0, stdout: JSON.stringify({ verdict: "go", reason: "", hard_dependencies: [] }), stderr: "" };
    };
    defaultCheckSequencing({ candidate: "CTL-1", inFlightTickets: ["CTL-2"], orchDir, readTriage, spawn });
    defaultCheckSequencing({ candidate: "CTL-1", inFlightTickets: ["CTL-3"], orchDir, readTriage, spawn });
    expect(spawnCalls).toHaveLength(2);
  });

  test("__resetSequencingCacheForTests clears the cache", () => {
    const spawnCalls = [];
    const spawn = () => {
      spawnCalls.push(true);
      return { status: 0, stdout: JSON.stringify({ verdict: "go", reason: "", hard_dependencies: [] }), stderr: "" };
    };
    const opts = { candidate: "CTL-1", inFlightTickets: ["CTL-2"], orchDir, readTriage, spawn };
    defaultCheckSequencing(opts);
    __resetSequencingCacheForTests();
    defaultCheckSequencing(opts);
    expect(spawnCalls).toHaveLength(2);
  });
});
