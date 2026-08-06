import { describe, it, expect } from "bun:test";
import {
  validatePredicate,
  createFilterStream,
} from "../lib/event-filter";

async function collect(
  predicate: string,
  lines: string[],
): Promise<string[]> {
  const out: string[] = [];
  const f = createFilterStream(predicate);
  f.onMatch((l) => out.push(l));
  for (const l of lines) f.write(l);
  await f.flush();
  f.close();
  return out;
}

describe("validatePredicate", () => {
  it("accepts a valid jq predicate", () => {
    expect(validatePredicate('.event == "github.pr.merged"')).toEqual({
      ok: true,
    });
  });

  it("accepts a startswith predicate", () => {
    expect(validatePredicate('.event | startswith("github.")')).toEqual({
      ok: true,
    });
  });

  it("rejects a syntactically invalid predicate", () => {
    const r = validatePredicate(".event ===");
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it("rejects an empty predicate", () => {
    expect(validatePredicate("").ok).toBe(false);
    expect(validatePredicate("   ").ok).toBe(false);
  });
});

describe("createFilterStream", () => {
  it("filters streaming JSON lines by predicate", async () => {
    const out = await collect('.event == "x"', [
      '{"event":"x"}',
      '{"event":"y"}',
      '{"event":"x","extra":1}',
    ]);
    expect(out.length).toBe(2);
    for (const l of out) {
      expect(JSON.parse(l).event).toBe("x");
    }
  });

  it("supports startswith predicates", async () => {
    const out = await collect('.event | startswith("github.")', [
      '{"event":"github.pr.merged"}',
      '{"event":"linear.issue.created"}',
      '{"event":"github.push"}',
    ]);
    expect(out.length).toBe(2);
    expect(JSON.parse(out[0]).event).toBe("github.pr.merged");
    expect(JSON.parse(out[1]).event).toBe("github.push");
  });

  it("empty predicate is a passthrough", async () => {
    const out = await collect("", [
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
    ]);
    expect(out.length).toBe(3);
  });

  it("silently drops invalid JSON lines", async () => {
    const out = await collect(".a == 1", [
      "not-json",
      '{"a":1}',
      "also not json",
      '{"a":2}',
    ]);
    expect(out.length).toBe(1);
    expect(JSON.parse(out[0]).a).toBe(1);
  });

  it("write after close is a no-op", () => {
    const f = createFilterStream(".a == 1");
    f.close();
    expect(() => f.write('{"a":1}')).not.toThrow();
  });

  it("close is idempotent", () => {
    const f = createFilterStream(".a == 1");
    f.close();
    expect(() => f.close()).not.toThrow();
  });

  it("write returns a boolean and drain() resolves (backpressure contract, CTL-1515)", async () => {
    const f = createFilterStream(".a == 1");
    // The chunked predicate scan relies on write's return value + drain() to stay
    // memory-bounded: await drain() only when write returns false.
    expect(typeof f.write('{"a":1}')).toBe("boolean");
    await f.drain(); // resolves immediately when not backpressured — must not hang
    expect(typeof f.write('{"a":2}')).toBe("boolean");
    f.close();
    // After close, write is a no-op returning true (never asks the caller to wait).
    expect(f.write('{"a":3}')).toBe(true);
    await f.drain();
  });

  it("passthrough (empty predicate) write returns true and drain resolves", async () => {
    const f = createFilterStream("");
    expect(f.write('{"a":1}')).toBe(true);
    await f.drain();
    f.close();
  });
});
