import { describe, expect, test } from "bun:test";
import {
  RECOVERY_CORRELATION_MIN_GROUP,
  RECOVERY_CORRELATION_WINDOW_MS,
  correlationId,
  groupCandidates,
  normalizeSignature,
} from "./escalation-correlation.mjs";

describe("normalizeSignature (CAT-170)", () => {
  test("missing and blank reasons never correlate", () => {
    for (const value of [null, undefined, "", " \n\t "]) {
      expect(normalizeSignature(value)).toBeNull();
    }
  });

  test("normalizes case and whitespace", () => {
    expect(normalizeSignature("Hit your session limit")).toBe(
      normalizeSignature("hit your   session   limit"),
    );
  });

  test("removes ticket-specific identifiers", () => {
    expect(normalizeSignature("CAT-47 stalled: usage limit")).toBe(
      normalizeSignature("CAT-135 stalled: usage limit"),
    );
  });

  test("removes absolute timestamps and epoch-millisecond runs", () => {
    expect(normalizeSignature("failed at 2026-08-09T15:42:31.123Z after 1723218151123 ms")).toBe(
      normalizeSignature("failed at 2026-08-10T03:01:02Z after 1723258862000 ms"),
    );
  });

  test("is stable and bounds long reasons with distinct hashes", () => {
    const first = `failure ${"a".repeat(200)}`;
    const second = `failure ${"b".repeat(200)}`;
    const signature = normalizeSignature(first);
    expect(signature).toBe(normalizeSignature(first));
    expect(signature).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(signature.length).toBeLessThanOrEqual(96);
    expect(normalizeSignature(second)).not.toBe(signature);
  });

  test("correlation ids are short and stable per signature and anchor", () => {
    expect(correlationId("usage limit", "CAT-1")).toBe(correlationId("usage limit", "CAT-1"));
    expect(correlationId("usage limit", "CAT-1")).toMatch(/^corr-[0-9a-f]{12}$/);
    expect(correlationId("usage limit", "CAT-2")).not.toBe(correlationId("usage limit", "CAT-1"));
  });
});

describe("groupCandidates (CAT-170)", () => {
  const opts = { windowMs: 60_000, minGroup: 2, now: 1_000_000 };

  test("groups three matching candidates inside the window", () => {
    expect(groupCandidates([
      { ticket: "CAT-3", signature: "limit", lastTs: 30_000 },
      { ticket: "CAT-1", signature: "limit", lastTs: 10_000 },
      { ticket: "CAT-2", signature: "limit", lastTs: 20_000 },
    ], opts)).toEqual([{
      signature: "limit",
      anchor: "CAT-1",
      members: ["CAT-2", "CAT-3"],
      tickets: ["CAT-1", "CAT-2", "CAT-3"],
      correlated: true,
    }]);
  });

  test("different signatures remain uncorrelated singletons", () => {
    expect(groupCandidates([
      { ticket: "CAT-1", signature: "one", lastTs: 10 },
      { ticket: "CAT-2", signature: "two", lastTs: 20 },
    ], opts)).toEqual([
      { signature: "one", anchor: "CAT-1", members: [], tickets: ["CAT-1"], correlated: false },
      { signature: "two", anchor: "CAT-2", members: [], tickets: ["CAT-2"], correlated: false },
    ]);
  });

  test("null signatures never group with each other", () => {
    const groups = groupCandidates([
      { ticket: "CAT-3", signature: null, lastTs: 30 },
      { ticket: "CAT-1", signature: null, lastTs: 10 },
      { ticket: "CAT-2", signature: null, lastTs: 20 },
    ], opts);
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => !group.correlated && group.tickets.length === 1)).toBe(true);
  });

  test("splits a candidate outside the newest member's window", () => {
    const groups = groupCandidates([
      { ticket: "CAT-1", signature: "limit", lastTs: 0 },
      { ticket: "CAT-2", signature: "limit", lastTs: 59_000 },
      { ticket: "CAT-3", signature: "limit", lastTs: 60_001 },
    ], opts);
    expect(groups.map((group) => group.tickets)).toEqual([["CAT-1", "CAT-2"], ["CAT-3"]]);
  });

  test("groups below minGroup are emitted as singletons", () => {
    const groups = groupCandidates([
      { ticket: "CAT-1", signature: "limit", lastTs: 10 },
      { ticket: "CAT-2", signature: "limit", lastTs: 20 },
    ], { ...opts, minGroup: 3 });
    expect(groups.map((group) => group.tickets)).toEqual([["CAT-1"], ["CAT-2"]]);
    expect(groups.every((group) => !group.correlated)).toBe(true);
  });

  test("anchor is earliest, tie-broken by ticket, regardless of input order", () => {
    const candidates = [
      { ticket: "CAT-9", signature: "limit", lastTs: 10 },
      { ticket: "CAT-2", signature: "limit", lastTs: 10 },
      { ticket: "CAT-5", signature: "limit", lastTs: 20 },
    ];
    const forward = groupCandidates(candidates, opts)[0];
    const shuffled = groupCandidates([candidates[2], candidates[0], candidates[1]], opts)[0];
    expect(forward.anchor).toBe("CAT-2");
    expect(shuffled.anchor).toBe("CAT-2");
    expect(forward.members).toEqual(["CAT-5", "CAT-9"]);
    expect(shuffled).toEqual(forward);
  });

  test("empty input is empty and malformed candidates are dropped", () => {
    expect(groupCandidates([], opts)).toEqual([]);
    expect(() => groupCandidates([null, {}, { signature: "limit", lastTs: 1 }], opts)).not.toThrow();
    expect(groupCandidates([null, {}, { signature: "limit", lastTs: 1 }], opts)).toEqual([]);
  });
});

describe("correlation tunables (CAT-170)", () => {
  test("use documented defaults", () => {
    expect(RECOVERY_CORRELATION_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(RECOVERY_CORRELATION_MIN_GROUP).toBe(2);
  });

  test("NaN and zero environment values fall through to defaults", () => {
    const moduleUrl = new URL("./escalation-correlation.mjs", import.meta.url).href;
    for (const value of ["not-a-number", "0"]) {
      const result = Bun.spawnSync({
        cmd: [process.execPath, "-e", `import(${JSON.stringify(moduleUrl)}).then(m => console.log(JSON.stringify([m.RECOVERY_CORRELATION_WINDOW_MS, m.RECOVERY_CORRELATION_MIN_GROUP])))`],
        env: {
          ...process.env,
          CATALYST_RECOVERY_CORRELATION_WINDOW_MIN: value,
          CATALYST_RECOVERY_CORRELATION_MIN_GROUP: value,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual([60 * 60 * 1000, 2]);
    }
  });
});
