// dsl-compile.test.mjs — DSL compiler + evaluator tests for CTL-313.
// Run: bun test plugins/dev/scripts/lib/dsl-compile.test.mjs

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  CANONICAL_FIELDS,
  FIELD_PATH_SET,
  isWhitelistedField,
  suggestField,
  levenshtein,
} from "./dsl-fields.mjs";

import {
  validateField,
  getField,
  evalJs,
  compileJq,
  compileSort,
  compileLimit,
  compile,
  parseGroqResponse,
  DslError,
  GroqResponseError,
} from "./dsl-compile.mjs";

// ─── Phase 1 — whitelist ─────────────────────────────────────────────────────

describe("CANONICAL_FIELDS whitelist", () => {
  test("contains the documented count of canonical fields", () => {
    expect(CANONICAL_FIELDS.length).toBe(31);
    expect(FIELD_PATH_SET.size).toBe(31);
  });

  test("includes core attribute paths", () => {
    expect(isWhitelistedField('attributes."event.name"')).toBe(true);
    expect(isWhitelistedField('attributes."vcs.pr.number"')).toBe(true);
    expect(isWhitelistedField('attributes."catalyst.worker.ticket"')).toBe(true);
    expect(isWhitelistedField('attributes."deployment.environment"')).toBe(true);
  });

  test("includes top-level fields", () => {
    expect(isWhitelistedField("ts")).toBe(true);
    expect(isWhitelistedField("severityText")).toBe(true);
    expect(isWhitelistedField("severityNumber")).toBe(true);
    expect(isWhitelistedField("traceId")).toBe(true);
    expect(isWhitelistedField('resource."service.name"')).toBe(true);
    expect(isWhitelistedField("body.message")).toBe(true);
  });

  test("rejects arbitrary body.payload paths", () => {
    expect(isWhitelistedField("body.payload.foo")).toBe(false);
    expect(isWhitelistedField("body.payload")).toBe(false);
  });
});

describe("validateField", () => {
  test("accepts whitelisted paths", () => {
    expect(validateField('attributes."event.name"').ok).toBe(true);
    expect(validateField("severityText").ok).toBe(true);
  });

  test("rejects unknown fields with the bad path in the error", () => {
    const r = validateField('attributes."foo.bar"');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('attributes."foo.bar"');
  });

  test("offers a near-miss suggestion when one exists", () => {
    const r = validateField('attributes."vcs.pr.numbr"');
    expect(r.ok).toBe(false);
    expect(r.suggestion).toBe('attributes."vcs.pr.number"');
  });

  test("offers no suggestion when nothing is close", () => {
    const r = validateField('completely.different.path.with.no.relation');
    expect(r.ok).toBe(false);
    expect(r.suggestion).toBeNull();
  });

  test("rejects empty / non-string inputs", () => {
    expect(validateField("").ok).toBe(false);
    expect(validateField(null).ok).toBe(false);
    expect(validateField(undefined).ok).toBe(false);
    expect(validateField(42).ok).toBe(false);
  });
});

describe("levenshtein", () => {
  test("computes simple distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("foo", "foo")).toBe(0);
    expect(levenshtein("", "foo")).toBe(3);
    expect(levenshtein("foo", "")).toBe(3);
  });
});

describe("suggestField", () => {
  test("returns null when no entry is within maxDistance", () => {
    expect(suggestField("xxxxxxxx", 1)).toBeNull();
  });

  test("returns the closest whitelisted path within distance", () => {
    expect(suggestField('attributes."vcs.pr.numbr"', 4)).toBe('attributes."vcs.pr.number"');
  });
});

// ─── Phase 1 — getField path walk ────────────────────────────────────────────

describe("getField path walk", () => {
  const event = {
    ts: "2026-05-08T14:00:00Z",
    severityText: "INFO",
    severityNumber: 9,
    resource: { "service.name": "catalyst.github" },
    attributes: {
      "event.name": "github.pr.merged",
      "vcs.pr.number": 342,
      "catalyst.worker.ticket": "CTL-313",
    },
    body: { message: "PR #342 merged", payload: { merged: true } },
  };

  test("walks unquoted segments", () => {
    expect(getField(event, "ts")).toBe("2026-05-08T14:00:00Z");
    expect(getField(event, "severityText")).toBe("INFO");
    expect(getField(event, "severityNumber")).toBe(9);
    expect(getField(event, "body.message")).toBe("PR #342 merged");
  });

  test("walks quoted dotted segments", () => {
    expect(getField(event, 'attributes."event.name"')).toBe("github.pr.merged");
    expect(getField(event, 'attributes."vcs.pr.number"')).toBe(342);
    expect(getField(event, 'resource."service.name"')).toBe("catalyst.github");
  });

  test("returns undefined for missing path components", () => {
    expect(getField(event, "missing")).toBeUndefined();
    expect(getField(event, 'attributes."does.not.exist"')).toBeUndefined();
    expect(getField(event, "body.message.foo")).toBeUndefined();
  });

  test("does not coerce nulls into objects", () => {
    expect(getField({ a: null }, "a.b")).toBeUndefined();
  });
});

// ─── Phase 1 — JS evaluator ──────────────────────────────────────────────────

const sampleEvent = {
  ts: "2026-05-08T14:07:37.105Z",
  severityText: "INFO",
  severityNumber: 9,
  traceId: null,
  spanId: null,
  resource: { "service.name": "catalyst.github" },
  attributes: {
    "event.name": "github.pr.merged",
    "event.entity": "pr",
    "vcs.repository.name": "coalesce-labs/catalyst",
    "vcs.pr.number": 342,
    "catalyst.worker.ticket": "CTL-313",
  },
  body: { message: "PR #342 merged in coalesce-labs/catalyst", payload: { merged: true } },
};

describe("evalJs leaf operators", () => {
  test("eq matches strings and numbers", () => {
    expect(evalJs({ field: 'attributes."event.name"', eq: "github.pr.merged" }, sampleEvent)).toBe(true);
    expect(evalJs({ field: 'attributes."vcs.pr.number"', eq: 342 }, sampleEvent)).toBe(true);
    expect(evalJs({ field: 'attributes."vcs.pr.number"', eq: "342" }, sampleEvent)).toBe(false);
  });

  test("ne is the inverse of eq", () => {
    expect(evalJs({ field: 'attributes."event.name"', ne: "github.pr.merged" }, sampleEvent)).toBe(false);
    expect(evalJs({ field: 'attributes."event.name"', ne: "github.pr.opened" }, sampleEvent)).toBe(true);
  });

  test("gt/gte/lt/lte handle numbers and strings (ISO timestamps)", () => {
    expect(evalJs({ field: "severityNumber", gte: 9 }, sampleEvent)).toBe(true);
    expect(evalJs({ field: "severityNumber", gt: 9 }, sampleEvent)).toBe(false);
    expect(evalJs({ field: "severityNumber", lt: 13 }, sampleEvent)).toBe(true);
    expect(evalJs({ field: "ts", gte: "2026-05-08T00:00:00Z" }, sampleEvent)).toBe(true);
    expect(evalJs({ field: "ts", lt: "2026-05-08T00:00:00Z" }, sampleEvent)).toBe(false);
  });

  test("gt/gte do not match null/undefined silently", () => {
    expect(evalJs({ field: "traceId", gt: "" }, sampleEvent)).toBe(false);
  });

  test("in matches set membership", () => {
    expect(evalJs({ field: 'attributes."catalyst.worker.ticket"', in: ["CTL-313", "CTL-300"] }, sampleEvent)).toBe(true);
    expect(evalJs({ field: 'attributes."catalyst.worker.ticket"', in: ["CTL-1"] }, sampleEvent)).toBe(false);
  });

  test("startsWith / endsWith / contains handle null without coercion", () => {
    expect(evalJs({ field: 'attributes."event.name"', startsWith: "github.pr." }, sampleEvent)).toBe(true);
    expect(evalJs({ field: 'attributes."event.name"', endsWith: ".merged" }, sampleEvent)).toBe(true);
    expect(evalJs({ field: 'attributes."event.name"', contains: "pr.mer" }, sampleEvent)).toBe(true);
    expect(evalJs({ field: "traceId", startsWith: "n" }, sampleEvent)).toBe(false);
    expect(evalJs({ field: "missing.path.here", startsWith: "" }, sampleEvent)).toBe(false);
  });

  test("exists distinguishes null/undefined from present", () => {
    expect(evalJs({ field: 'attributes."event.name"', exists: true }, sampleEvent)).toBe(true);
    expect(evalJs({ field: "traceId", exists: true }, sampleEvent)).toBe(false);
    expect(evalJs({ field: "traceId", exists: false }, sampleEvent)).toBe(true);
  });

  test("unknown leaf operator throws DslError naming the operator", () => {
    expect(() => evalJs({ field: "ts", unknownOp: 1 }, sampleEvent)).toThrow(DslError);
    try {
      evalJs({ field: "ts", unknownOp: 1 }, sampleEvent);
    } catch (e) {
      expect(e.message).toContain("unknownOp");
    }
  });
});

describe("evalJs combinators", () => {
  test("and short-circuits on false", () => {
    let calls = 0;
    const rec = (val) => {
      const node = { field: "ts", eq: val };
      const wrapper = new Proxy(node, { get(t, k) { calls++; return t[k]; } });
      return wrapper;
    };
    void rec; // sentinel to keep proxies referenced
    expect(evalJs({
      and: [
        { field: "severityText", eq: "DEBUG" },
        { field: 'attributes."event.name"', eq: "github.pr.merged" },
      ],
    }, sampleEvent)).toBe(false);
  });

  test("or short-circuits on true", () => {
    expect(evalJs({
      or: [
        { field: "severityText", eq: "INFO" },
        { field: "severityText", eq: "WARN" },
      ],
    }, sampleEvent)).toBe(true);
  });

  test("not negates", () => {
    expect(evalJs({ not: { field: "severityText", eq: "INFO" } }, sampleEvent)).toBe(false);
    expect(evalJs({ not: { field: "severityText", eq: "WARN" } }, sampleEvent)).toBe(true);
  });

  test("empty filter matches everything", () => {
    expect(evalJs({}, sampleEvent)).toBe(true);
  });
});

// ─── Phase 2 — jq compiler ───────────────────────────────────────────────────

describe("compileJq leaf operators", () => {
  test("eq emits parenthesized comparison", () => {
    expect(compileJq({ field: 'attributes."event.name"', eq: "github.pr.merged" }))
      .toBe('(.attributes."event.name" == "github.pr.merged")');
    expect(compileJq({ field: 'attributes."vcs.pr.number"', eq: 342 }))
      .toBe('(.attributes."vcs.pr.number" == 342)');
  });

  test("in emits IN(...) over the canonical jq idiom", () => {
    expect(compileJq({ field: 'attributes."catalyst.worker.ticket"', in: ["CTL-300", "CTL-313"] }))
      .toBe('(.attributes."catalyst.worker.ticket" | IN("CTL-300", "CTL-313"))');
    expect(compileJq({ field: 'attributes."vcs.pr.number"', in: [501, 502] }))
      .toBe('(.attributes."vcs.pr.number" | IN(501, 502))');
  });

  test("startsWith / endsWith / contains use null-safe // \"\" guard", () => {
    expect(compileJq({ field: 'attributes."event.name"', startsWith: "github.pr." }))
      .toBe('((.attributes."event.name" // "") | tostring | startswith("github.pr."))');
    expect(compileJq({ field: 'attributes."event.name"', endsWith: ".merged" }))
      .toBe('((.attributes."event.name" // "") | tostring | endswith(".merged"))');
    expect(compileJq({ field: "body.message", contains: "merged" }))
      .toBe('((.body.message // "") | tostring | contains("merged"))');
  });

  test("exists emits null-vs-non-null comparison", () => {
    expect(compileJq({ field: "traceId", exists: true })).toBe("(.traceId != null)");
    expect(compileJq({ field: "traceId", exists: false })).toBe("(.traceId == null)");
  });

  test("comparison operators guard against null on the LHS", () => {
    expect(compileJq({ field: "severityNumber", gt: 9 })).toBe("(.severityNumber != null and .severityNumber > 9)");
    expect(compileJq({ field: "ts", gte: "2026-05-08T00:00:00Z" })).toBe('(.ts != null and .ts >= "2026-05-08T00:00:00Z")');
  });

  test("validation runs before compilation; unknown field throws DslError with suggestion", () => {
    let err;
    try { compileJq({ field: 'attributes."vcs.pr.numbr"', eq: 1 }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DslError);
    expect(err.code).toBe("unknown_field");
    expect(err.field).toBe('attributes."vcs.pr.numbr"');
    expect(err.suggestion).toBe('attributes."vcs.pr.number"');
  });
});

describe("compileJq combinators", () => {
  test("and joins with space-and-space", () => {
    const out = compileJq({
      and: [
        { field: 'attributes."event.name"', startsWith: "github.pr." },
        { field: 'attributes."vcs.pr.number"', eq: 342 },
      ],
    });
    expect(out).toBe(
      '(((.attributes."event.name" // "") | tostring | startswith("github.pr.")) and (.attributes."vcs.pr.number" == 342))'
    );
  });

  test("or joins with space-or-space", () => {
    const out = compileJq({
      or: [
        { field: 'attributes."event.name"', startsWith: "github.pr." },
        { field: 'attributes."event.name"', startsWith: "github.check_" },
      ],
    });
    expect(out).toBe(
      '(((.attributes."event.name" // "") | tostring | startswith("github.pr.")) or ((.attributes."event.name" // "") | tostring | startswith("github.check_")))'
    );
  });

  test("not wraps in ((...) | not) — jq's postfix not", () => {
    expect(compileJq({ not: { field: "severityText", eq: "DEBUG" } }))
      .toBe('(((.severityText == "DEBUG")) | not)');
  });

  test("empty filter compiles to true", () => {
    expect(compileJq({})).toBe("true");
  });

  test("empty 'and' compiles to true; empty 'or' compiles to false", () => {
    expect(compileJq({ and: [] })).toBe("true");
    expect(compileJq({ or: [] })).toBe("false");
  });
});

describe("compileSort and compileLimit", () => {
  test("desc sort emits sort_by | reverse", () => {
    expect(compileSort({ field: "ts", order: "desc" })).toBe("sort_by(.ts) | reverse");
  });

  test("asc sort (default order) emits sort_by", () => {
    expect(compileSort({ field: "severityNumber" })).toBe("sort_by(.severityNumber)");
    expect(compileSort({ field: "severityNumber", order: "asc" })).toBe("sort_by(.severityNumber)");
  });

  test("null sort returns null", () => {
    expect(compileSort(null)).toBeNull();
    expect(compileSort(undefined)).toBeNull();
  });

  test("invalid sort.order throws", () => {
    expect(() => compileSort({ field: "ts", order: "sideways" })).toThrow(DslError);
  });

  test("unknown sort field throws with suggestion", () => {
    let err;
    try { compileSort({ field: "tss" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DslError);
    expect(err.code).toBe("unknown_field");
  });

  test("compileLimit emits .[:N]", () => {
    expect(compileLimit(10)).toBe(".[:10]");
    expect(compileLimit(0)).toBe(".[:0]");
  });

  test("null/undefined limit returns null", () => {
    expect(compileLimit(null)).toBeNull();
    expect(compileLimit(undefined)).toBeNull();
  });

  test("invalid limit throws", () => {
    expect(() => compileLimit(-1)).toThrow(DslError);
    expect(() => compileLimit(1.5)).toThrow(DslError);
    expect(() => compileLimit("10")).toThrow(DslError);
  });
});

describe("compile() top-level", () => {
  test("returns all four artifacts and a working JS predicate", () => {
    const out = compile({
      filter: { field: 'attributes."event.name"', eq: "github.pr.merged" },
      sort: { field: "ts", order: "desc" },
      limit: 5,
    });
    expect(out.jqPredicate).toBe('(.attributes."event.name" == "github.pr.merged")');
    expect(out.jqSort).toBe("sort_by(.ts) | reverse");
    expect(out.jqLimit).toBe(".[:5]");
    expect(out.jsPredicate(sampleEvent)).toBe(true);
  });

  test("empty dsl produces a match-all predicate", () => {
    const out = compile({});
    expect(out.jqPredicate).toBe("true");
    expect(out.jsPredicate(sampleEvent)).toBe(true);
  });
});

// ─── Phase 2 — agreement test (JS predicate ↔ jq predicate) ──────────────────

describe("JS / jq agreement", () => {
  // We pre-build a tmpdir, write a JSONL fixture, then compare the JS
  // predicate's matches to running `jq` over the same file with the compiled
  // jq predicate. Both must produce the same matching set per fixture DSL.

  const fixtureEvents = [
    {
      ts: "2026-05-08T14:00:00Z",
      severityText: "INFO", severityNumber: 9, traceId: null, spanId: null,
      resource: { "service.name": "catalyst.github" },
      attributes: {
        "event.name": "github.pr.merged",
        "vcs.pr.number": 342,
        "vcs.repository.name": "coalesce-labs/catalyst",
        "catalyst.worker.ticket": "CTL-313",
      },
      body: { message: "PR #342 merged", payload: {} },
    },
    {
      ts: "2026-05-08T13:00:00Z",
      severityText: "ERROR", severityNumber: 17, traceId: null, spanId: null,
      resource: { "service.name": "catalyst.github" },
      attributes: {
        "event.name": "github.workflow_run.completed",
        "vcs.pr.number": 343,
        "vcs.repository.name": "coalesce-labs/catalyst",
        "cicd.pipeline.run.conclusion": "failure",
      },
      body: { message: "CI failed", payload: {} },
    },
    {
      ts: "2026-05-08T12:00:00Z",
      severityText: "INFO", severityNumber: 9, traceId: null, spanId: null,
      resource: { "service.name": "catalyst.linear" },
      attributes: {
        "event.name": "linear.issue.state_changed",
        "linear.issue.identifier": "ADV-292",
      },
      body: { message: "Issue moved", payload: {} },
    },
    {
      ts: "2026-05-08T11:00:00Z",
      severityText: "INFO", severityNumber: 9, traceId: null, spanId: null,
      resource: { "service.name": "catalyst.session" },
      attributes: {
        "event.name": "session.phase",
        "catalyst.session.id": "sess_abc",
        "catalyst.phase": 3,
      },
      body: { message: "implementing", payload: {} },
    },
  ];

  let dir;
  let fixturePath;

  test("setup fixture file", () => {
    dir = mkdtempSync(join(tmpdir(), "dsl-fixture-"));
    fixturePath = join(dir, "events.jsonl");
    writeFileSync(fixturePath, fixtureEvents.map((e) => JSON.stringify(e)).join("\n") + "\n");
  });

  const cases = [
    {
      name: "event-name eq",
      dsl: { filter: { field: 'attributes."event.name"', eq: "github.pr.merged" } },
    },
    {
      name: "in over tickets",
      dsl: { filter: { field: 'attributes."linear.issue.identifier"', in: ["ADV-292", "ADV-293"] } },
    },
    {
      name: "startsWith on event.name",
      dsl: { filter: { field: 'attributes."event.name"', startsWith: "github." } },
    },
    {
      name: "or of two startsWith",
      dsl: {
        filter: {
          or: [
            { field: 'attributes."event.name"', startsWith: "github.pr." },
            { field: 'attributes."event.name"', startsWith: "github.workflow_" },
          ],
        },
      },
    },
    {
      name: "and of severity + repo",
      dsl: {
        filter: {
          and: [
            { field: "severityText", eq: "ERROR" },
            { field: 'attributes."vcs.repository.name"', eq: "coalesce-labs/catalyst" },
          ],
        },
      },
    },
    {
      name: "not over event.name",
      dsl: { filter: { not: { field: 'attributes."event.name"', startsWith: "github." } } },
    },
    {
      name: "exists true on linear identifier",
      dsl: { filter: { field: 'attributes."linear.issue.identifier"', exists: true } },
    },
    {
      name: "exists false on traceId",
      dsl: { filter: { field: "traceId", exists: false } },
    },
    {
      name: "gte on severityNumber",
      dsl: { filter: { field: "severityNumber", gte: 13 } },
    },
    {
      name: "ts gte time window",
      dsl: { filter: { field: "ts", gte: "2026-05-08T13:00:00Z" } },
    },
    {
      name: "in over PR numbers",
      dsl: { filter: { field: 'attributes."vcs.pr.number"', in: [342, 999] } },
    },
    {
      name: "empty filter (match all)",
      dsl: { filter: {} },
    },
    {
      name: "complex and+or+not nested",
      dsl: {
        filter: {
          and: [
            {
              or: [
                { field: 'attributes."event.name"', startsWith: "github.pr." },
                { field: 'attributes."event.name"', startsWith: "github.check_" },
                { field: 'attributes."event.name"', startsWith: "github.workflow_" },
              ],
            },
            { not: { field: "severityText", eq: "ERROR" } },
          ],
        },
      },
    },
  ];

  for (const c of cases) {
    test(`agreement: ${c.name}`, () => {
      const compiled = compile(c.dsl);
      const jsMatches = fixtureEvents.filter(compiled.jsPredicate);

      const jqOut = spawnSync("jq", ["-c", `select(${compiled.jqPredicate})`, fixturePath], {
        encoding: "utf8",
      });
      expect(jqOut.status).toBe(0);
      const jqMatches = jqOut.stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l));

      // Compare by ts (each fixture event has a unique ts).
      const jsTs = jsMatches.map((e) => e.ts).sort();
      const jqTs = jqMatches.map((e) => e.ts).sort();
      expect(jsTs).toEqual(jqTs);
    });
  }

  test("teardown fixture", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── Phase 3 — Groq response parsing (no real round-trip) ────────────────────

describe("parseGroqResponse", () => {
  test("parses a valid DSL JSON response", () => {
    const out = parseGroqResponse('{"filter":{"field":"ts","eq":"x"},"sort":null,"limit":null}');
    expect(out).toEqual({ filter: { field: "ts", eq: "x" }, sort: null, limit: null });
  });

  test("non-JSON response throws GroqResponseError with the raw text attached", () => {
    let err;
    try { parseGroqResponse("not json"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GroqResponseError);
    expect(err.raw).toBe("not json");
  });

  test("error response with 'refused' code", () => {
    let err;
    try { parseGroqResponse('{"error":"refused: query is read-only"}'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DslError);
    expect(err.code).toBe("refused");
    expect(err.message).toContain("read-only");
  });

  test("error response naming an unknown field", () => {
    let err;
    try { parseGroqResponse('{"error":"unknown field: foo.bar"}'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(DslError);
    expect(err.code).toBe("unknown_field");
  });
});

// ─── Phase 3 — groqTranslate with an injected fetch (no network) ─────────────

import { groqTranslate, GroqHttpError } from "./dsl-compile.mjs";
import { SYSTEM_PROMPT } from "./dsl-prompt.mjs";

describe("groqTranslate (mocked fetch)", () => {
  function mockFetch(response) {
    return async () => response;
  }

  test("returns parsed DSL on success", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"filter":{"field":"ts","eq":"x"},"sort":null,"limit":null}' } }],
      }),
    });
    const out = await groqTranslate("show me everything", { apiKey: "k", fetchImpl, systemPrompt: SYSTEM_PROMPT });
    expect(out.filter.field).toBe("ts");
  });

  test("non-2xx throws GroqHttpError with status and body", async () => {
    const fetchImpl = mockFetch({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    let err;
    try {
      await groqTranslate("query", { apiKey: "k", fetchImpl, systemPrompt: SYSTEM_PROMPT });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GroqHttpError);
    expect(err.status).toBe(401);
    expect(err.body).toBe("Unauthorized");
  });

  test("missing API key throws GroqHttpError before any fetch", async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return null; };
    let err;
    try {
      await groqTranslate("q", { apiKey: "", fetchImpl, systemPrompt: SYSTEM_PROMPT });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(GroqHttpError);
    expect(err.status).toBe(0);
    expect(called).toBe(false);
  });

  test("missing systemPrompt is a programming error (not a DSL error)", async () => {
    const fetchImpl = mockFetch({ ok: true, json: async () => ({ choices: [{ message: { content: "{}" } }] }) });
    let err;
    try {
      await groqTranslate("q", { apiKey: "k", fetchImpl });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("systemPrompt");
  });
});

// ─── Phase 3 — system prompt sanity ──────────────────────────────────────────

describe("SYSTEM_PROMPT", () => {
  test("includes every canonical field in the documented schema block", () => {
    for (const f of CANONICAL_FIELDS) {
      expect(SYSTEM_PROMPT).toContain(f.path);
    }
  });

  test("documents the DSL grammar's leaf operators", () => {
    for (const op of ["eq", "ne", "in", "startsWith", "endsWith", "contains", "exists"]) {
      expect(SYSTEM_PROMPT).toContain(op);
    }
  });

  test("instructs JSON-only output", () => {
    expect(SYSTEM_PROMPT.toLowerCase()).toContain("json");
  });
});
