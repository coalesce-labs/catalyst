// event-envelope.test.mjs — CTL-1819 guard for the envelope schema.
//
// Run: cd plugins/dev/scripts/execution-core && bun test event-envelope.test.mjs
//
// The fixtures below are not invented — each is the minimal form of a shape
// measured on the live log. The census itself (frozen-snapshot methodology, the
// per-shape counts, the positive controls) lives in ONE place, lib/event-envelope.mjs's
// header, and is deliberately not restated here: it is volatile, and duplicated
// copies have drifted apart across three separate review rounds.
//
// LIVE-CORPUS CHECK. CI cannot reach ~/catalyst/events/*.jsonl, so the
// "schema describes reality" AC is served two ways: the fixture set here, and
// an opt-in scan of a real log that an operator (or a fleet host) can run —
//
//   CATALYST_EVENT_LOG_SAMPLE=<log> bun test event-envelope.test.mjs
//
// ⚠️ SCOPE: the CALLER bounds the sample; this scan does not sample. It validates
// every line of whatever it is given and REFUSES a file over the cap (default
// 64 MiB, CATALYST_EVENT_LOG_SAMPLE_MAX_BYTES) with the exact command to bound it.
// The live log is ~1 GB and a whole-file read is a recorded stall incident here,
// so an oversized sample is a hard failure rather than a silent partial pass.
//
// It used to do the tail read itself. That byte arithmetic produced four separate
// false-passes (Codex rounds 7, 9, 11, 12) and existed only to save a `tail -c`,
// so it was deleted along with the ALLOW_TRUNCATION flag it needed.
//
// One optional flag remains: CATALYST_EVENT_LOG_SAMPLE_ALLOW_TAIL_FRAGMENT=1
// waives an unterminated FINAL record, for a log being appended to right now. It
// is off by default — on a stable file that record is corruption, not a race.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, statSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { scanEventsSince, tailParsedEvents, scanEventsChunked } from "./event-tail.mjs";
import {
  ENVELOPE_SHAPES,
  classifyEnvelope,
  validateEnvelope,
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
const V2_FULL = {
  ts: "2026-08-14T20:44:34Z",
  id: "11111111-2222-4333-8444-555555555555",
  observedTs: "2026-08-14T20:44:34Z",
  severityText: "INFO",
  severityNumber: 9,
  traceId: "3de0f145b2191d8994e04440dddb9ab5",
  spanId: "0ae3c4b1ac1c080d",
  caused_by: null,
  attributes: { "event.name": "github.pr.merged" },
  body: { payload: {} },
  resource: { "service.name": "catalyst.monitor" },
};
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

const DEAD_SCHEMA_REQUIRED = ["ts", "orchestrator", "event"];
// Codex round 21: the COMPLETE 23-name enum, copied verbatim from
// templates/global-event.json as it stands on origin/main. The first cut listed
// THREE of them, so a conforming record using any of the other twenty — say
// `worker-done` — would have been rejected by the restatement, and the test could
// report zero matches while the real schema would have matched. A control that
// models a subset of the thing it stands for is not a control for that thing.
const DEAD_SCHEMA_ENUM = [
  "orchestrator-started",
  "orchestrator-completed",
  "orchestrator-failed",
  "orchestrator-paused",
  "orchestrator-resumed",
  "orchestrator-heartbeat",
  "wave-started",
  "wave-completed",
  "worker-dispatched",
  "worker-phase-advanced",
  "worker-status-terminal",
  "worker-pr-created",
  "worker-done",
  "worker-failed",
  "worker-stalled",
  "verification-started",
  "verification-passed",
  "verification-failed",
  "remediation-started",
  "attention-raised",
  "attention-resolved",
  "worker-usage-captured",
  "archive",
];

const passesDeadSchema = (ev) =>
  ev !== null &&
  typeof ev === "object" &&
  !Array.isArray(ev) &&
  DEAD_SCHEMA_REQUIRED.every((k) => Object.hasOwn(ev, k)) &&
  DEAD_SCHEMA_ENUM.includes(ev.event);

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

  // Codex round 20: the "0 live events passed the dead schema" claim is evidence
  // for deleting it, and the old test only checked that fixtures lacked an
  // `orchestrator` key — which a broken or misapplied validator would also report.
  // The deleted schema's contract, restated from templates/global-event.json as it
  // stands on origin/main: required {ts, orchestrator, event}, with `event` drawn
  // from a closed 23-name enum.
  test("POSITIVE CONTROL: the dead-schema validator recognises a conforming event", () => {
    // Without this, "zero live events passed" is satisfiable by a validator that
    // passes nothing at all — the instrument could not have shown otherwise.
    // Every one of the 23 names must be recognised, not just the first — that is
    // exactly the gap the three-name version had.
    expect(DEAD_SCHEMA_ENUM.length).toBe(23);
    const rejected = DEAD_SCHEMA_ENUM.filter(
      (name) => !passesDeadSchema({ ts: "2026-08-14T00:00:00Z", orchestrator: "orch-1", event: name })
    );
    expect(rejected).toEqual([]);
  });

  test("the dead global-event.json contract passes none of the real shapes", () => {
    for (const ev of [V1, V2, V3, DUAL]) expect(passesDeadSchema(ev)).toBe(false);
  });

  test("ENVELOPE_SHAPES is frozen and holds exactly the four measured shapes", () => {
    expect(Object.isFrozen(ENVELOPE_SHAPES)).toBe(true);
    expect([...ENVELOPE_SHAPES].sort()).toEqual(["dual", "v1", "v2", "v3"]);
  });
});

// Codex rounds 8 + 10: the top-level key layer is gone. Both an allowlist and a
// completeness check were falsified by measurement (see the module header). What
// remains is the measured, universal contract — which is what the corpus of REAL
// producer output is for.
describe("real producer output", () => {
  // Codex round 15: this loader still dropped blank records — the round-14 fix
  // covered the live scan and missed the committed-corpus one, so a blank row in
  // the fixture would still have read clean. Only the synthetic final element from
  // a trailing newline is not a record.
  const corpusText = readFileSync(
    new URL("./__fixtures__/event-envelope-corpus.jsonl", import.meta.url),
    "utf8"
  );
  const corpusRaw = corpusText.split("\n");
  if (corpusText.endsWith("\n")) corpusRaw.pop();
  const corpus = corpusRaw.map((l, i) => {
    try {
      return JSON.parse(l);
    } catch {
      throw new Error(`corpus line ${i + 1} is not valid JSON (blank or corrupt): ${JSON.stringify(l.slice(0, 80))}`);
    }
  });

  test("the corpus is non-empty and covers all four shapes", () => {
    // A zero-line corpus would make every assertion below vacuously true.
    expect(corpus.length).toBeGreaterThan(0);
    expect(new Set(corpus.map(classifyEnvelope))).toEqual(new Set(["v1", "v2", "v3", "dual"]));
  });

  test("the dead schema passes NO real producer line either", () => {
    // Round 20 claimed this test ran; it was never inserted, because that edit
    // used a stale anchor name and the replace silently matched nothing. The claim
    // outlived the code for a full round. Presence is now verified by mutation
    // rather than asserted: a predicate that passes everything turns this red.
    expect(corpus.filter((ev) => passesDeadSchema(ev))).toEqual([]);
  });

  test("every real line validates — this is the drift check that survived", () => {
    // A producer emitting a line with no `ts`, or no resolvable name, or a dual
    // envelope whose two names disagree, reddens CI here. Those are the three
    // properties measured to hold on 100% of lines.
    expect(corpus.map((ev) => validateEnvelope(ev)).filter((r) => !r.ok)).toEqual([]);
  });

  test("every real line resolves a non-empty name", () => {
    expect(corpus.filter((ev) => getEventName(ev) === "")).toEqual([]);
  });

  test("producer-added top-level keys are not a defect", () => {
    // The keys two review rounds flagged as drift, asserted as ACCEPTABLE so the
    // allowlist cannot be reintroduced without this failing.
    for (const ev of [
      { ts: "t", event: "a.b", orchestrator: "o", worker: "w" },
      { ts: "t", event: "a.b", quiet_ms: 1, orch_id: "o" },
      { ...V2_FULL, channel: "c" },
    ]) {
      expect(validateEnvelope(ev).ok).toBe(true);
    }
  });
});

// Codex round 16: references/event-schema.md publishes a jq name ladder and claims
// it matches lib/event-name.mjs. Nothing enforced that — the claim was itself an
// unverified assertion, and the first version diverged (it threw on a scalar
// `.attributes` where the JS returns a name, and a jq error aborts the whole
// drain). This extracts the ladder FROM THE DOC and runs it against the JS, so the
// doc is the source and drift fails here.
describe("the documented jq ladder matches the JS boundary", () => {
  const docPath = new URL("../../references/event-schema.md", import.meta.url);
  const doc = readFileSync(docPath, "utf8");
  // Codex round 20: the ladder is published TWICE — as the standalone blockquote
  // and inside the runnable `catalyst-events tail --filter '...'` example. The test
  // extracted only the first, so the copy users actually PASTE could drift (or
  // abort a drain) with CI green. Every published copy is now extracted and they
  // must be byte-identical.
  const LADDER_RE = /if type=="object" then \[\.event,.*?else "" end/g;
  const allCopies = doc.match(LADDER_RE) ?? [];
  const m = [null, allCopies[0]];
  const jqAvailable = (() => {
    try {
      return spawnSync("jq", ["--version"]).status === 0;
    } catch {
      return false;
    }
  })();

  test("the doc publishes a ladder, in every place, identically", () => {
    // Fails loudly if the expression is renamed or removed, so the parity test
    // below can never pass by matching nothing — and fails if the two published
    // copies drift apart, which is the one CI could previously miss.
    expect(allCopies.length).toBeGreaterThanOrEqual(2);
    expect(new Set(allCopies).size).toBe(1);
  });

  test.skipIf(!jqAvailable)("jq and JS agree on every shape, including the edge cases", () => {
    const cases = [
      // Codex round 17: every case here used an OBJECT root, which is why the
      // top-level scalar gap survived a round. Non-object records come first now.
      42,
      "a string",
      [1, 2, 3],
      true,
      null,
      { ts: "t", event: "v1.only" },
      { ts: "t", attributes: { "event.name": "v2.only" } },
      { ts: "t", name: "v3.only" },
      { ts: "t", event: "dual.same", attributes: { "event.name": "dual.same" } },
      { ts: "t", event: "phase.ok", attributes: "payload" }, // scalar attributes
      { ts: "t", attributes: null, name: "v3.via.null.attrs" },
      { ts: "t", event: "", attributes: { "event.name": "v2.wins.over.empty" } },
      { ts: "t", attributes: { "event.name": 123 }, name: "v3.wins.over.nonstring" },
      { ts: "t" },
    ];
    const input = cases.map((c) => JSON.stringify(c)).join("\n") + "\n";
    const r = spawnSync("jq", ["-rc", m[1]], { input, encoding: "utf8" });
    expect(r.status).toBe(0); // a jq ERROR would abort a real drain — never acceptable
    // Compare EXACTLY, empties included: filtering them out would hide a record
    // that jq dropped, which is the very failure mode being guarded against.
    const out = r.stdout.split("\n");
    if (out[out.length - 1] === "") out.pop();
    expect(out).toEqual(cases.map((c) => getEventName(c)));
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
  // Codex round 14: `!sample` treated an explicitly EMPTY value as unset, so
  // CATALYST_EVENT_LOG_SAMPLE='' skipped and exited 0 — an operator whose shell
  // expanded a variable to nothing got a green run over nothing inspected. Absent
  // and present-but-unusable are different states and must not share a branch.
  const sampleRaw = process.env.CATALYST_EVENT_LOG_SAMPLE;
  const sampleAbsent = sampleRaw === undefined;
  const sample = sampleRaw;
  // Codex round 6: skip ONLY when the variable is unset. A mistyped path used to
  // skip and exit 0 — an operator pointing this at a real log and getting a green
  // run would conclude the log was validated when nothing was inspected. That is
  // the check-that-cannot-fail shape, in the test written to prevent it.
  test.skipIf(sampleAbsent)(
    "every line of the scanned region of a real log validates (bounded tail)",
    () => {
      if (sample === "") {
        throw new Error(
          `CATALYST_EVENT_LOG_SAMPLE is set but EMPTY. Refusing to report success ` +
            `without inspecting anything — unset it to skip deliberately.`
        );
      }
      if (!existsSync(sample)) {
        throw new Error(
          `CATALYST_EVENT_LOG_SAMPLE was set to "${sample}" but that path does not exist. ` +
            `Refusing to report success without inspecting anything.`
        );
      }
      // ── NO INTERNAL TRUNCATION (Codex rounds 7, 9, 11, 12) ────────────────
      //
      // This used to read a bounded TAIL of an oversized sample. That byte work
      // produced FOUR separate false-passes, every one of them a boundary case:
      //   • start landing exactly on a record boundary discarded a whole record
      //   • the fragment identified by TEXT exempted an identical earlier line
      //   • an unterminated corrupt record at EOF was waived as a race
      //   • a window containing NO newline kept the entire partial suffix, so a
      //     corrupt record passed whenever its retained tail happened to parse
      //
      // All four existed only to save the caller a `tail -c`. So the truncation is
      // gone: an oversized sample now FAILS with instructions instead of being
      // silently sampled. The caller bounds it, the file read here is small by
      // contract, and the entire class of boundary bugs goes with it.
      const MAX = Number(process.env.CATALYST_EVENT_LOG_SAMPLE_MAX_BYTES) || 64 * 1024 * 1024;
      const fileSize = statSync(sample).size;
      if (fileSize > MAX) {
        throw new Error(
          `CATALYST_EVENT_LOG_SAMPLE is ${fileSize} bytes, over the ${MAX}-byte cap. ` +
            `This scan does NOT sample — a partial pass would say nothing about the rest. ` +
            `Bound it first:  tail -c ${MAX} <log> > /tmp/sample.jsonl  (and note that a tail ` +
            `may begin mid-record, so drop its first line).`
        );
      }
      const text = readFileSync(sample, "utf8");

      // Only the final line can be an unterminated fragment, and only when the
      // text does not end in a newline. Waiving it is opt-in — on a stable file an
      // unterminated corrupt record at EOF is corruption, not a race (round 11).
      const endsWithNewline = text.endsWith("\n");
      const waiveFragment = process.env.CATALYST_EVENT_LOG_SAMPLE_ALLOW_TAIL_FRAGMENT === "1";
      const rawLines = text.split("\n");
      const fragmentIndex = endsWithNewline || !waiveFragment ? -1 : rawLines.length - 1;
      // Codex round 14: `.filter(Boolean)` silently dropped BLANK records. Under an
      // "every line" check a newline-terminated blank line is a malformed record —
      // swapping it for `{not json}` failed, so blanks were the one corruption that
      // passed. The ONLY empty element that is not a record is the synthetic final
      // one produced by a trailing newline.
      const syntheticFinalIndex = endsWithNewline ? rawLines.length - 1 : -1;
      const lines = [];
      for (let i = 0; i < rawLines.length; i++) {
        if (i === syntheticFinalIndex && rawLines[i] === "") continue;
        lines.push({ line: rawLines[i], isFragment: i === fragmentIndex, i });
      }
      const failures = [];
      let torn = 0;
      for (const { line, isFragment, i } of lines) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          if (isFragment) {
            torn += 1; // waived by explicit opt-in — assumed mid-write
            continue;
          }
          if (failures.length < 10) {
            failures.push({
              errors: [
                "line did not parse — torn record in the scanned region" +
                  (i === rawLines.length - 1 && !endsWithNewline
                    ? " (unterminated final record; set CATALYST_EVENT_LOG_SAMPLE_ALLOW_TAIL_FRAGMENT=1 only if this log is being appended to right now)"
                    : ""),
              ],
              line: line.slice(0, 160),
            });
          }
          torn += 1;
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
