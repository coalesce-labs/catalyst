// event-envelope.test.mjs — CTL-1819 guard for the envelope schema.
//
// Run: cd plugins/dev/scripts/execution-core && bun test event-envelope.test.mjs
//
// The fixtures below are not invented. Each is the minimal form of a shape
// MEASURED on mini's 2026-08 log (1,194,150 lines, 100% parsed):
//
//   v2-only  1,167,253   v1-only  25,355   dual  951   v3-only  532
//
// LIVE-CORPUS CHECK. CI cannot reach ~/catalyst/events/*.jsonl, so the
// "schema describes reality" AC is served two ways: the fixture set here, and
// an opt-in scan of a real log that an operator (or a fleet host) can run —
//
//   CATALYST_EVENT_LOG_SAMPLE=~/catalyst/events/2026-08.jsonl bun test event-envelope.test.mjs
//
// which validates every line and fails naming the first offenders. That is the
// test that would actually catch a schema drifting away from the log; the
// fixtures only catch a schema drifting away from itself.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import {
  ENVELOPE_SHAPES,
  KNOWN_TOP_LEVEL_KEYS,
  classifyEnvelope,
  validateEnvelope,
  unknownTopLevelKeys,
  checkEnvelope,
  malformedEventCount,
  malformedCountsByShape,
  resetMalformedEventCount,
} from "../lib/event-envelope.mjs";
import { getEventName } from "../lib/event-name.mjs";

const V2 = {
  ts: "2026-08-14T20:44:34Z",
  attributes: { "event.name": "github.pr.merged", "vcs.pr.number": 436 },
  body: { payload: {} },
  resource: { "service.name": "catalyst.monitor" },
};
const V1 = { ts: "2026-08-14T20:10:01Z", event: "phase.implement.abandoned.CTC-487" };
const V3 = { ts: "2026-08-14T19:57:49Z", name: "phase.rescue.attempted.CTC-495" };
const DUAL = {
  ts: "2026-08-14T20:28:40Z",
  event: "phase.pr.complete.CTC-494",
  attributes: { "event.name": "phase.pr.complete.CTC-494" },
  body: {},
  resource: {},
};

beforeEach(() => {
  delete process.env.CATALYST_EVENT_SCHEMA_OFF;
  resetMalformedEventCount();
});
afterEach(() => {
  delete process.env.CATALYST_EVENT_SCHEMA_OFF;
});

describe("the schema describes reality", () => {
  test("every shape measured on the live log validates", () => {
    for (const [label, ev] of [
      ["v2", V2],
      ["v1", V1],
      ["v3", V3],
      ["dual", DUAL],
    ]) {
      const r = validateEnvelope(ev);
      expect(`${label}:${r.ok}`).toBe(`${label}:true`);
      expect(r.shape).toBe(label);
      expect(r.errors).toEqual([]);
    }
  });

  test("classification agrees with the event-name boundary about which key wins", () => {
    // If these two modules disagree, an event is classified as one shape and
    // named from another — the exact class of bug CTL-1834 existed to close.
    expect(getEventName(V1)).toBe("phase.implement.abandoned.CTC-487");
    expect(getEventName(V2)).toBe("github.pr.merged");
    expect(getEventName(V3)).toBe("phase.rescue.attempted.CTC-495");
    expect(getEventName(DUAL)).toBe("phase.pr.complete.CTC-494");
    for (const ev of [V1, V2, V3, DUAL]) {
      expect(classifyEnvelope(ev)).not.toBe("unknown");
      expect(getEventName(ev)).not.toBe("");
    }
  });

  test("the dead global-event.json contract passes none of them", () => {
    // The schema this replaces required {ts, orchestrator, event}. Asserting the
    // reason it was deleted, so a future reader does not restore it.
    for (const ev of [V1, V2, V3, DUAL]) {
      expect(Object.hasOwn(ev, "orchestrator")).toBe(false);
    }
  });

  test("ENVELOPE_SHAPES and the vocabulary are frozen and sorted", () => {
    expect(Object.isFrozen(ENVELOPE_SHAPES)).toBe(true);
    expect(Object.isFrozen(KNOWN_TOP_LEVEL_KEYS)).toBe(true);
    expect([...KNOWN_TOP_LEVEL_KEYS]).toEqual([...KNOWN_TOP_LEVEL_KEYS].sort());
    expect(new Set(KNOWN_TOP_LEVEL_KEYS).size).toBe(KNOWN_TOP_LEVEL_KEYS.length);
  });
});

describe("drift reddens CI", () => {
  test("an unrecognised top-level key is named", () => {
    const drifted = { ...V2, brandNewProducerField: "surprise" };
    expect(unknownTopLevelKeys(drifted)).toEqual(["brandNewProducerField"]);
  });

  test("every key of every known shape is in the vocabulary", () => {
    for (const ev of [V1, V2, V3, DUAL]) {
      expect(unknownTopLevelKeys(ev)).toEqual([]);
    }
  });

  test("the vocabulary holds the measured key set at snapshot equality", () => {
    // 36 distinct keys, measured `jq -rc 'keys[]' | sort -u` over 2026-08.
    // Fails in BOTH directions: adding a producer key without recording it here
    // fails, and deleting a key that is still on the log fails too.
    expect(KNOWN_TOP_LEVEL_KEYS.length).toBe(36);
    expect(KNOWN_TOP_LEVEL_KEYS).toContain("attributes");
    expect(KNOWN_TOP_LEVEL_KEYS).toContain("event");
    expect(KNOWN_TOP_LEVEL_KEYS).toContain("name");
    expect(KNOWN_TOP_LEVEL_KEYS).toContain("ts");
  });
});

describe("a malformed event is counted, never thrown", () => {
  test("missing ts is counted and the shape is named", () => {
    const bad = { attributes: { "event.name": "x.y" } };
    expect(() => checkEnvelope(bad)).not.toThrow();
    expect(malformedEventCount()).toBe(1);
    expect(malformedCountsByShape()).toEqual({ v2: 1 });
  });

  test("an unnameable event is counted as unknown", () => {
    expect(() => checkEnvelope({ ts: "2026-08-14T00:00:00Z" })).not.toThrow();
    expect(malformedCountsByShape()).toEqual({ unknown: 1 });
  });

  test("a disagreeing dual envelope is caught", () => {
    const bad = { ...DUAL, attributes: { "event.name": "something.else" } };
    const r = checkEnvelope(bad);
    expect(r.ok).toBe(false);
    expect(r.shape).toBe("dual");
    expect(r.errors.join(" ")).toContain("dual envelope disagrees");
  });

  test("non-objects never throw", () => {
    for (const junk of [null, undefined, 42, "str", [], true]) {
      expect(() => checkEnvelope(junk)).not.toThrow();
    }
    expect(malformedEventCount()).toBe(6);
  });
});

describe("positive control — the validator can observe the defect", () => {
  // The whole point: assert BOTH directions with the SAME fixture. A test that
  // only checked "good input does not move the counter" would still pass with
  // validateEnvelope deleted and replaced by `() => ({ok: true})`.
  const MALFORMED = { attributes: { "event.name": "x.y" } }; // no ts

  test("with validation ON the counter moves", () => {
    checkEnvelope(MALFORMED);
    expect(malformedEventCount()).toBe(1);
  });

  test("with the bypass ON the counter does NOT move", () => {
    process.env.CATALYST_EVENT_SCHEMA_OFF = "1";
    const r = checkEnvelope(MALFORMED);
    expect(r.ok).toBe(true);
    expect(r.shape).toBe("bypassed");
    expect(malformedEventCount()).toBe(0);
  });

  test("MUST FAIL if validation is removed: the same input differs by mode", () => {
    checkEnvelope(MALFORMED);
    const withValidation = malformedEventCount();
    resetMalformedEventCount();
    process.env.CATALYST_EVENT_SCHEMA_OFF = "1";
    checkEnvelope(MALFORMED);
    const withBypass = malformedEventCount();
    expect(withValidation).toBeGreaterThan(withBypass);
  });
});

describe("live corpus (opt-in)", () => {
  const sample = process.env.CATALYST_EVENT_LOG_SAMPLE;
  test.skipIf(!sample || !existsSync(sample ?? ""))(
    "every line of a real log validates",
    () => {
      // BOUNDED TAIL, never a whole-file read. The live log is ~1.0 GB on a
      // fleet host (measured, mini 2026-08), and whole-log readFileSync is a
      // recorded incident shape here — it produced multi-second-to-115s stalls.
      // The AC asks for a 24h SAMPLE, and the tail is that sample. Cap mirrors
      // event-tail.mjs's DEFAULT_TAIL_MAX_BYTES.
      const MAX = 64 * 1024 * 1024;
      const fd = openSync(sample, "r");
      let text;
      try {
        const size = statSync(sample).size;
        const start = Math.max(0, size - MAX);
        const buf = Buffer.allocUnsafe(Math.min(size, MAX));
        readSync(fd, buf, 0, buf.length, start);
        text = buf.toString("utf8");
        // Drop the leading partial line when we started mid-file — the same
        // reason every reader in this repo holds its fragment back.
        if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      } finally {
        closeSync(fd);
      }

      const lines = text.split("\n").filter(Boolean);
      const failures = [];
      let torn = 0;
      for (const line of lines) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          torn += 1; // a torn line is event-tail.mjs's detector, not this one
          continue;
        }
        const r = validateEnvelope(ev);
        if (!r.ok && failures.length < 10) failures.push({ errors: r.errors, line: line.slice(0, 160) });
      }
      // A zero-line sample must not read as a pass — `[].every(p)` is `true`,
      // and a loop that never ran printing an all-clear is this repo's
      // signature false-clean shape.
      expect(lines.length - torn).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    }
  );
});
