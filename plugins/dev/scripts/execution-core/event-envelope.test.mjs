// event-envelope.test.mjs — CTL-1819 guard for the envelope schema.
//
// Run: cd plugins/dev/scripts/execution-core && bun test event-envelope.test.mjs
//
// The fixtures below are not invented. Each is the minimal form of a shape
// MEASURED on ONE FROZEN BYTE SNAPSHOT of mini's 2026-08 log (1,117,890,759 B;
// 1,202,573 lines, 100% parsed). The shape counts SUM to the total exactly, so
// "every line has a discriminator" is arithmetic, not a separate query:
//
//   v2-only 1,175,708 + v1-only 25,355 + dual 978 + v3-only 532 = 1,202,573
//
// LIVE-CORPUS CHECK. CI cannot reach ~/catalyst/events/*.jsonl, so the
// "schema describes reality" AC is served two ways: the fixture set here, and
// an opt-in scan of a real log that an operator (or a fleet host) can run —
//
//   CATALYST_EVENT_LOG_SAMPLE=<log> bun test event-envelope.test.mjs
//
// ⚠️ SCOPE (Codex round 5): it scans a BOUNDED TAIL, not the whole file — the
// live log is ~1 GB and a whole-file read is a recorded stall incident here. A
// sample larger than the cap therefore leaves earlier bytes unexamined, and a
// pass over the tail must NOT read as whole-file coverage. So the test REFUSES
// to truncate silently: point it at an already-bounded sample, or set
// CATALYST_EVENT_LOG_SAMPLE_ALLOW_TRUNCATION=1 to accept tail-only scope
// knowingly. Either way it reports the bytes it actually read.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanEventsSince, tailParsedEvents, scanEventsChunked } from "./event-tail.mjs";
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
const V1 = { ts: "2026-08-14T20:10:01Z", event: "phase.implement.abandoned.PROJ-101" };
const V3 = { ts: "2026-08-14T19:57:49Z", name: "phase.rescue.attempted.PROJ-102" };
const DUAL = {
  ts: "2026-08-14T20:28:40Z",
  event: "phase.pr.complete.PROJ-103",
  attributes: { "event.name": "phase.pr.complete.PROJ-103" },
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
    expect(getEventName(V1)).toBe("phase.implement.abandoned.PROJ-101");
    expect(getEventName(V2)).toBe("github.pr.merged");
    expect(getEventName(V3)).toBe("phase.rescue.attempted.PROJ-102");
    expect(getEventName(DUAL)).toBe("phase.pr.complete.PROJ-103");
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

  // Codex P2: the four fixtures above prove `unknownTopLevelKeys` works when
  // called by hand; they prove nothing about what producers actually emit, and
  // the live-log test is opt-in and skipped in CI. So the vocabulary check is
  // applied IN CI to a committed corpus of REAL producer output — 25 lines
  // captured from the live log by greedy key-coverage, carrying all 36 keys and
  // all four shapes (12 v1, 3 dual, 7 v2, 3 v3).
  //
  // SANITIZED (Codex round 2, P1) per AGENTS.md → Version Control, which forbids
  // committing specific ticket prefixes: the 14 real ticket ids are mapped to
  // stable PROJ-N, `/Users/ryanrozich` → `/Users/dev`, and the org/repo and PR
  // URL are generic. Only VALUES were rewritten — key shapes are untouched, which
  // is what these assertions actually read, and the mapping is deterministic so
  // the fixture stays diff-friendly.
  //
  // ⚠️ Honest bound, stated so nobody over-trusts this: a corpus is a SNAPSHOT.
  // A brand-new producer field appears here only when the corpus is refreshed.
  // What this does catch is the vocabulary drifting away from the corpus in
  // either direction, in CI, with no live log. Closing the gap fully needs the
  // opt-in live check below run on a fleet host on a schedule.
  describe("real producer output", () => {
    const corpus = readFileSync(
      new URL("./__fixtures__/event-envelope-corpus.jsonl", import.meta.url),
      "utf8"
    )
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    test("the corpus is non-empty and covers all four shapes", () => {
      // A zero-line corpus would make every assertion below vacuously true —
      // `[].every(p)` is `true`, this repo's signature false-clean shape.
      expect(corpus.length).toBeGreaterThan(0);
      expect(new Set(corpus.map(classifyEnvelope))).toEqual(new Set(["v1", "v2", "v3", "dual"]));
    });

    test("no real line carries a key outside the vocabulary", () => {
      const offenders = corpus
        .map((ev, i) => ({ i, unknown: unknownTopLevelKeys(ev) }))
        .filter((r) => r.unknown.length > 0);
      expect(offenders).toEqual([]);
    });

    test("every vocabulary key is exercised by real output — fails in BOTH directions", () => {
      // ⊆ alone would let a key be added to the vocabulary that no producer
      // emits; this equality also catches that.
      const seen = new Set(corpus.flatMap((ev) => Object.keys(ev)));
      expect([...seen].sort()).toEqual([...KNOWN_TOP_LEVEL_KEYS]);
    });

    test("every real line validates", () => {
      const bad = corpus.map((ev) => validateEnvelope(ev)).filter((r) => !r.ok);
      expect(bad).toEqual([]);
    });
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

// ── WHERE COUNTING LIVES, and why it is only two places (Codex rounds 1-3) ──
//
// Three review rounds found three layers of one defect, each a consequence of
// counting inside the SHARED byte parser:
//   r1  expanding-window probes re-parsed the same bytes → one record counted many times
//   r2  transcript-tail.mjs feeds that parser {type,message} records → valid lines
//       counted as damage
//   r3  board-health calls tailParsedEvents every 5 minutes → the same physical
//       record recounted on every scheduler pass, forever
//
// The root cause is that a byte-level parser cannot know whether its input is an
// event envelope, nor whether these bytes have been read before. So it does not
// validate at all any more — event-tail.mjs is byte-identical to main.
//
// ⭐ Counting happens at the TWO readers that see each physical record exactly
// once: the broker's live tail and the monitor's live tail, each driven by a byte
// cursor that only ever advances. Everything else — scanEventsSince,
// tailParsedEvents, transcript-tail — is a SNAPSHOT reader that re-reads history
// by design, and a detector that counts there reports how often it looked rather
// than how much damage exists.
describe("snapshot readers never count", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctl1819-"));
  const logPath = join(dir, "events.jsonl");
  const tPath = join(dir, "transcript.jsonl");
  const MALFORMED = 8;

  beforeEach(() => {
    const lines = [];
    for (let i = 0; i < MALFORMED; i++) {
      lines.push(JSON.stringify({ attributes: { "event.name": `bad.${i}` } })); // no ts
      lines.push(JSON.stringify({ ts: `2026-08-14T00:00:${String(i).padStart(2, "0")}Z`, event: `ok.${i}` }));
    }
    writeFileSync(logPath, lines.join("\n") + "\n");
    writeFileSync(
      tPath,
      Array.from({ length: 12 }, (_, i) => JSON.stringify({ type: "assistant", message: { content: [{ text: `turn ${i}` }] } })).join("\n") + "\n"
    );
    resetMalformedEventCount();
  });

  test("scanEventsSince counts nothing (it re-reads on every call)", () => {
    scanEventsSince({ path: logPath, targetSinceMs: 0, initialWindow: 64, onEvent: () => {} });
    expect(malformedEventCount()).toBe(0);
  });

  test("tailParsedEvents counts nothing, and repeat calls stay at zero", () => {
    // Codex round 3: board-health calls this every 5 minutes over the last 800
    // events. Counting here made a single stale malformed record an ever-growing
    // incident count. Two calls must move the total by zero, not by two.
    tailParsedEvents({ path: logPath, maxLines: 100, bytesPerLineEstimate: 8 });
    tailParsedEvents({ path: logPath, maxLines: 100, bytesPerLineEstimate: 8 });
    expect(malformedEventCount()).toBe(0);
  });

  test("a transcript through the shared parser counts nothing", () => {
    const seen = [];
    scanEventsChunked({ path: tPath, fromOffset: 0, onEvent: (e) => seen.push(e) });
    expect(seen.length).toBe(12); // still delivered — this was never a filter
    expect(malformedEventCount()).toBe(0);
  });

  test("CONTROL: those same records DO count at a live-tail boundary", () => {
    // Without this, every zero above is satisfiable by a validator that does
    // nothing. This is what the broker and monitor live tails actually do: one
    // checkEnvelope per record, as it arrives, exactly once.
    resetMalformedEventCount();
    const events = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const ev of events) checkEnvelope(ev);
    expect(malformedEventCount()).toBe(MALFORMED);
  });
});

describe("live corpus (opt-in)", () => {
  const sample = process.env.CATALYST_EVENT_LOG_SAMPLE;
  // Codex round 6: skip ONLY when the variable is unset. A mistyped path used to
  // skip and exit 0 — an operator pointing this at a real log and getting a green
  // run would conclude the log was validated when nothing was inspected. That is
  // the check-that-cannot-fail shape, in the test written to prevent it.
  test.skipIf(!sample)(
    "every line of the scanned region of a real log validates (bounded tail)",
    () => {
      if (!existsSync(sample)) {
        throw new Error(
          `CATALYST_EVENT_LOG_SAMPLE was set to "${sample}" but that path does not exist. ` +
            `Refusing to report success without inspecting anything.`
        );
      }
      // BOUNDED TAIL, never a whole-file read. The live log is ~1.0 GB on a
      // fleet host (measured, mini 2026-08), and whole-log readFileSync is a
      // recorded incident shape here — it produced multi-second-to-115s stalls.
      // The AC asks for a 24h SAMPLE, and the tail is that sample. Cap mirrors
      // event-tail.mjs's DEFAULT_TAIL_MAX_BYTES.
      // Overridable so the truncation guard itself is testable (below).
      const MAX = Number(process.env.CATALYST_EVENT_LOG_SAMPLE_MAX_BYTES) || 64 * 1024 * 1024;
      // Refuse to silently examine a fraction of what the caller pointed at.
      const fileSize = statSync(sample).size;
      if (fileSize > MAX && process.env.CATALYST_EVENT_LOG_SAMPLE_ALLOW_TRUNCATION !== "1") {
        throw new Error(
          `CATALYST_EVENT_LOG_SAMPLE is ${fileSize} bytes but this test scans at most ${MAX}. ` +
            `A pass would cover only the final ${MAX} bytes and say nothing about the rest. ` +
            `Bound the sample first (e.g. tail -c ${MAX}), or set ` +
            `CATALYST_EVENT_LOG_SAMPLE_ALLOW_TRUNCATION=1 to accept tail-only scope.`
        );
      }
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
        // Codex P2: also apply the VOCABULARY here. validateEnvelope deliberately
        // ignores unknown keys (it is the non-gating runtime layer), so without
        // this the live check could never surface a producer's new field — the
        // one place with enough real output to notice it first.
        const unknown = unknownTopLevelKeys(ev);
        if (unknown.length && failures.length < 10) {
          failures.push({ errors: [`unknown top-level keys: ${unknown.join(", ")}`], line: line.slice(0, 160) });
        }
      }
      // A zero-line sample must not read as a pass — `[].every(p)` is `true`,
      // and a loop that never ran printing an all-clear is this repo's
      // signature false-clean shape.
      expect(lines.length - torn).toBeGreaterThan(0);
      expect(failures).toEqual([]);
    }
  );
});
