import { describe, expect, test } from "bun:test";
import { parseSinceSpec } from "../cli/lib/since-spec.ts";

describe("parseSinceSpec", () => {
  test("parses minutes to an ISO string roughly N minutes ago", () => {
    const before = Date.now();
    const out = parseSinceSpec("5m");
    const after = Date.now();
    expect(out).not.toBeNull();
    const t = new Date(out!).getTime();
    expect(t).toBeGreaterThanOrEqual(before - 5 * 60_000 - 50);
    expect(t).toBeLessThanOrEqual(after - 5 * 60_000 + 50);
  });

  test("parses hours", () => {
    const out = parseSinceSpec("24h");
    expect(out).not.toBeNull();
    const ageMs = Date.now() - new Date(out!).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(24 * 3_600_000 - 100);
    expect(ageMs).toBeLessThanOrEqual(24 * 3_600_000 + 100);
  });

  test("parses days", () => {
    const out = parseSinceSpec("7d");
    expect(out).not.toBeNull();
    const ageMs = Date.now() - new Date(out!).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(7 * 86_400_000 - 100);
    expect(ageMs).toBeLessThanOrEqual(7 * 86_400_000 + 100);
  });

  test("parses seconds", () => {
    const out = parseSinceSpec("30s");
    expect(out).not.toBeNull();
    const ageMs = Date.now() - new Date(out!).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(30_000 - 100);
    expect(ageMs).toBeLessThanOrEqual(30_000 + 100);
  });

  test("parses long-form units like 'minute', 'hour', 'day'", () => {
    const out = parseSinceSpec("2hours");
    expect(out).not.toBeNull();
    const ageMs = Date.now() - new Date(out!).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(2 * 3_600_000 - 100);
    expect(ageMs).toBeLessThanOrEqual(2 * 3_600_000 + 100);
  });

  test("parses an ISO date string", () => {
    const out = parseSinceSpec("2026-05-01");
    expect(out).not.toBeNull();
    expect(new Date(out!).toISOString().startsWith("2026-05-01")).toBe(true);
  });

  test("strips leading ~ prefix", () => {
    const out = parseSinceSpec("~30m");
    expect(out).not.toBeNull();
    const ageMs = Date.now() - new Date(out!).getTime();
    expect(ageMs).toBeGreaterThanOrEqual(30 * 60_000 - 100);
    expect(ageMs).toBeLessThanOrEqual(30 * 60_000 + 100);
  });

  test("parses compound duration 2h30m", () => {
    const out = parseSinceSpec("2h30m");
    expect(out).not.toBeNull();
    const ageMs = Date.now() - new Date(out!).getTime();
    const expected = (2 * 3600 + 30 * 60) * 1000;
    expect(ageMs).toBeGreaterThanOrEqual(expected - 100);
    expect(ageMs).toBeLessThanOrEqual(expected + 100);
  });

  test("parses compound duration 1h30m45s", () => {
    const out = parseSinceSpec("1h30m45s");
    expect(out).not.toBeNull();
    const ageMs = Date.now() - new Date(out!).getTime();
    const expected = (3600 + 30 * 60 + 45) * 1000;
    expect(ageMs).toBeGreaterThanOrEqual(expected - 100);
    expect(ageMs).toBeLessThanOrEqual(expected + 100);
  });

  test("returns null for unparseable spec", () => {
    expect(parseSinceSpec("garbage")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseSinceSpec("")).toBeNull();
  });
});
