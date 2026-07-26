// parity-harness.test.mjs — CTL-1534.
//
// Unit tests for the PURE comparison functions. These run offline with no credential and no
// network — same constraint as `--self-test` (rule 8: the negative control must run where it
// is needed, which is CI).
//
// The tests are written against the defect list that produced the harness rules: each block
// names the false-green it exists to prevent.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_TYPE_CENSUS,
  EXIT_CANNOT_EVALUATE,
  EXIT_HEALTHY,
  EXIT_PROBLEM,
  censusExpectationFor,
  checkSeqAdjacency,
  compareEnvelope,
  compareTypeCounts,
  countBySource,
  deliveryIdOf,
  envelopeSource,
  evaluate,
  indexByDelivery,
  ingestText,
  isControlRecord,
  joinDeliveries,
  monthFilesFor,
  parseArgs,
  parseIntStrict,
  parseIsoStrict,
  perTypeCounts,
  selfTest,
  seqOf,
  tsBounds,
  windowSpanSlice,
} from "./parity-harness.mjs";

// ── helpers ─────────────────────────────────────────────────────────────────────────────

const opts = (over = {}) => ({ ...parseArgs([]).opts, ...over });

function envelope({ name = "github.pr.opened", id = "d1", ts = "2026-07-26T22:11:00.000Z", seq = null, attrs = {}, version = "12.37.0", host = "mini", severity = "INFO" } = {}) {
  const attributes = { "event.name": name, "event.entity": name.split(".")[1], "event.action": name.split(".")[2] ?? "", ...attrs };
  if (id !== null) attributes["webhook.delivery.id"] = id;
  if (seq !== null) attributes["catalyst.cloud.event.seq"] = seq;
  return {
    ts, id: `uuid-${id}`, observedTs: ts, severityText: severity, severityNumber: 9,
    traceId: null, spanId: null,
    resource: { "service.name": "catalyst.github", "service.namespace": "catalyst", "service.version": version, "host.name": host, "host.id": "h" },
    attributes, body: { message: name, payload: {} },
  };
}
const line = (e) => JSON.stringify(e);
const entry = (obj, i = 0, inWindow = true) => ({
  file: "<m>", lineNo: i + 1, fileOrderIndex: i, obj,
  source: envelopeSource(obj), ts: Date.parse(obj.ts), inWindow,
  deliveryId: deliveryIdOf(obj),
});

// ── strict input parsing (defects 3 + 9: never repair the input) ─────────────────────────

describe("parseIsoStrict — rejects, never coerces", () => {
  test("accepts strict ISO-8601 with Z and with an offset", () => {
    expect(parseIsoStrict("2026-07-26T22:11:00Z").ok).toBe(true);
    expect(parseIsoStrict("2026-07-26T22:11:00.123Z").ok).toBe(true);
    expect(parseIsoStrict("2026-07-26T22:11:00+02:00").ok).toBe(true);
  });

  test.each([
    ["banana"], ["2026-07-26"], ["2026-07-26 22:11:00Z"], ["Jul 26 2026"], [""], ["0"],
  ])("rejects %p", (v) => {
    expect(parseIsoStrict(v).ok).toBe(false);
  });

  test("rejects non-strings rather than stringifying them", () => {
    expect(parseIsoStrict(1753567860000).ok).toBe(false);
    expect(parseIsoStrict(null).ok).toBe(false);
    expect(parseIsoStrict(undefined).ok).toBe(false);
  });
});

describe("parseIntStrict — the `--since banana -> NaN -> scanned everything` defect", () => {
  test("accepts non-negative integers", () => {
    expect(parseIntStrict("0")).toEqual({ ok: true, value: 0 });
    expect(parseIntStrict("1766")).toEqual({ ok: true, value: 1766 });
  });

  test.each([["banana"], ["-1"], ["1.5"], [""], [" 7"], ["7 "], ["0x10"], ["1e3"], ["007"]])(
    "rejects %p (Number() would have coerced or silently accepted it)", (v) => {
      expect(parseIntStrict(v).ok).toBe(false);
    });
});

describe("parseArgs", () => {
  test("rejects an unknown flag rather than ignoring it", () => {
    const r = parseArgs(["--frmo", "x"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unknown argument");
  });

  test("rejects a flag with no value", () => {
    expect(parseArgs(["--from"]).ok).toBe(false);
    expect(parseArgs(["--from", "--json"]).ok).toBe(false);
  });

  test("rejects a non-ISO --from and a non-integer --expect-head-seq", () => {
    expect(parseArgs(["--from", "banana"]).ok).toBe(false);
    expect(parseArgs(["--expect-head-seq", "banana"]).ok).toBe(false);
  });

  test("rejects an inverted window", () => {
    const r = parseArgs(["--from", "2026-07-26T23:00:00Z", "--to", "2026-07-26T22:00:00Z"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("after");
  });

  test("rejects an unknown --sources value", () => {
    expect(parseArgs(["--sources", "gitlab"]).ok).toBe(false);
    expect(parseArgs(["--sources", "github"]).opts.sources).toEqual(["github"]);
  });

  test("collects repeatable inputs", () => {
    const { opts: o } = parseArgs(["--live", "a", "--live", "b", "--ignore-attr", "x", "--ignore-attr", "y"]);
    expect(o.live).toEqual(["a", "b"]);
    expect(o.ignoreAttrs).toEqual(["x", "y"]);
  });

  test("defaults do not silently pick a cursor of 0", () => {
    const { opts: o } = parseArgs([]);
    expect(o.expectFirstSeq).toBeNull();
    expect(o.expectHeadSeq).toBeNull();
    expect(o.fromMs).toBeNull();
  });
});

// ── record classification ───────────────────────────────────────────────────────────────

describe("isControlRecord — structural discrimination (`error` and no `seq`)", () => {
  test("a control record is detected", () => {
    expect(isControlRecord({ error: "cursor_underflow", resync: true })).toBe(true);
    expect(isControlRecord({ error: "cursor_ahead_of_head", resync: true, head: 113 })).toBe(true);
  });

  test("an event line carrying seq is never a control record", () => {
    expect(isControlRecord({ seq: 5, error: "weird", payload: {} })).toBe(false);
  });

  test("a provider body with its own `error` key cannot collide (it nests under payload)", () => {
    expect(isControlRecord({ seq: 5, payload: { error: "provider-side" } })).toBe(false);
    expect(isControlRecord(envelope())).toBe(false);
  });

  test("non-objects are not control records", () => {
    expect(isControlRecord(null)).toBe(false);
    expect(isControlRecord(["error"])).toBe(false);
    expect(isControlRecord("error")).toBe(false);
  });
});

describe("envelopeSource / deliveryIdOf / seqOf", () => {
  test("source comes from the event.name prefix", () => {
    expect(envelopeSource(envelope({ name: "github.pr.opened" }))).toBe("github");
    expect(envelopeSource(envelope({ name: "linear.comment.created" }))).toBe("linear");
  });

  test("non-webhook events are not a source", () => {
    expect(envelopeSource(envelope({ name: "phase.implement.complete.CTL-1" }))).toBeNull();
    expect(envelopeSource(envelope({ name: "broker.daemon.start" }))).toBeNull();
    expect(envelopeSource({ attributes: {} })).toBeNull();
    expect(envelopeSource({})).toBeNull();
  });

  test("an empty delivery id is treated as absent, not as a joinable key", () => {
    expect(deliveryIdOf(envelope({ id: "abc" }))).toBe("abc");
    expect(deliveryIdOf(envelope({ id: null }))).toBeNull();
    expect(deliveryIdOf({ attributes: { "webhook.delivery.id": "" } })).toBeNull();
  });

  test("seqOf is strict: absent vs invalid vs valid are three different answers", () => {
    expect(seqOf(envelope({ seq: 101 }), "catalyst.cloud.event.seq")).toEqual({ ok: true, seq: 101 });
    expect(seqOf(envelope({ seq: "101" }), "catalyst.cloud.event.seq")).toEqual({ ok: true, seq: 101 });
    expect(seqOf(envelope({}), "catalyst.cloud.event.seq").ok).toBeNull();
    expect(seqOf(envelope({ seq: "banana" }), "catalyst.cloud.event.seq").ok).toBe(false);
    expect(seqOf(envelope({ seq: 1.5 }), "catalyst.cloud.event.seq").ok).toBe(false);
  });
});

// ── adjacency (defect 4: never sort) ────────────────────────────────────────────────────

describe("checkSeqAdjacency — WIRE ORDER, never sorted", () => {
  const seqs = (list) => list.map((s, i) => ({ seq: s, lineNo: i + 1 }));

  test("a contiguous ascending run is clean", () => {
    expect(checkSeqAdjacency(seqs([101, 102, 103]))).toEqual({ descents: [], gaps: [] });
  });

  test("1,3,2 is a DESCENT — sorting would have turned it into a clean pass", () => {
    const r = checkSeqAdjacency(seqs([1, 3, 2]));
    expect(r.descents.length).toBe(1);
    expect(r.descents[0]).toMatchObject({ prev: 3, cur: 2 });
  });

  test("a repeated seq is a descent, not a gap", () => {
    const r = checkSeqAdjacency(seqs([5, 5]));
    expect(r.descents.length).toBe(1);
    expect(r.gaps.length).toBe(0);
  });

  test("a gap is reported with the count of missing seqs", () => {
    const r = checkSeqAdjacency(seqs([101, 104]));
    expect(r.gaps).toEqual([{ after: 101, before: 104, missing: 2, curLine: 2 }]);
    expect(r.descents.length).toBe(0);
  });

  test("order and contiguity are INDEPENDENT properties", () => {
    const r = checkSeqAdjacency(seqs([1, 5, 3, 4]));
    expect(r.gaps.length).toBe(1); // 1 -> 5
    expect(r.descents.length).toBe(1); // 5 -> 3
  });

  test("empty and single-element runs assert nothing", () => {
    expect(checkSeqAdjacency([])).toEqual({ descents: [], gaps: [] });
    expect(checkSeqAdjacency(seqs([42]))).toEqual({ descents: [], gaps: [] });
  });
});

describe("windowSpanSlice — seq adjacency must not be computed over a ts-filtered subset", () => {
  test("returns the contiguous FILE-ORDER slice bracketing the in-window records", () => {
    const all = [
      entry(envelope({ id: "a", seq: 1 }), 0, false),
      entry(envelope({ id: "b", seq: 2 }), 1, true),
      entry(envelope({ id: "c", seq: 3 }), 2, false), // interior, ts outside the window
      entry(envelope({ id: "d", seq: 4 }), 3, true),
      entry(envelope({ id: "e", seq: 5 }), 4, false),
    ];
    const span = windowSpanSlice(all);
    // c is KEPT: seq is commit order while ts is receipt order, so dropping it would
    // manufacture a gap that does not exist on the feed.
    expect(span.map((e) => e.obj.attributes["webhook.delivery.id"])).toEqual(["b", "c", "d"]);
  });

  test("no in-window records yields an empty span", () => {
    expect(windowSpanSlice([entry(envelope(), 0, false)])).toEqual([]);
  });
});

describe("tsBounds — file order is NOT time order on the shadow side", () => {
  test("min/max ignore file position", () => {
    const b = tsBounds([
      entry(envelope({ ts: "2026-07-26T22:30:00.000Z" })),
      entry(envelope({ ts: "2026-07-26T22:10:00.000Z" })), // commit-order inversion
      entry(envelope({ ts: "2026-07-26T22:20:00.000Z" })),
    ]);
    expect(new Date(b.min).toISOString()).toBe("2026-07-26T22:10:00.000Z");
    expect(new Date(b.max).toISOString()).toBe("2026-07-26T22:30:00.000Z");
  });
});

// ── join ────────────────────────────────────────────────────────────────────────────────

describe("indexByDelivery / joinDeliveries", () => {
  test("duplicates are recorded, never merged away", () => {
    const idx = indexByDelivery([entry(envelope({ id: "a" }), 0), entry(envelope({ id: "a" }), 1)]);
    expect(idx.byId.size).toBe(1);
    expect(idx.duplicates.length).toBe(1);
    expect(idx.duplicates[0]).toMatchObject({ deliveryId: "a", firstLine: 1, dupLine: 2 });
  });

  test("join splits matched / live-only / shadow-only", () => {
    const live = indexByDelivery([entry(envelope({ id: "a" }), 0), entry(envelope({ id: "b" }), 1)]);
    const shadow = indexByDelivery([entry(envelope({ id: "b" }), 0), entry(envelope({ id: "c" }), 1)]);
    const j = joinDeliveries(live.byId, shadow.byId);
    expect(j.matched.map((m) => m.id)).toEqual(["b"]);
    expect(j.liveOnly.map((e) => e.deliveryId)).toEqual(["a"]);
    expect(j.shadowOnly.map((e) => e.deliveryId)).toEqual(["c"]);
  });

  test("disjoint ids produce ZERO matches — the case a mismatch-only harness cannot see", () => {
    const live = indexByDelivery([entry(envelope({ id: "a" }), 0)]);
    const shadow = indexByDelivery([entry(envelope({ id: "z" }), 0)]);
    const j = joinDeliveries(live.byId, shadow.byId);
    expect(j.matched.length).toBe(0);
    expect(j.liveOnly.length).toBe(1);
    expect(j.shadowOnly.length).toBe(1);
  });

  test("countBySource counts per source, so a per-source zero cannot hide behind a total", () => {
    const c = countBySource([
      entry(envelope({ name: "github.pr.opened" })),
      entry(envelope({ name: "github.pr.closed" })),
    ]);
    expect(c).toEqual({ github: 2, linear: 0 });
  });
});

// ── per-type counts (rule 9: counts, never presence) ────────────────────────────────────

describe("compareTypeCounts", () => {
  const rowFor = (rows, type) => rows.find((r) => r.type === type);

  test("live > shadow on a shared type is a DEFICIT", () => {
    const rows = compareTypeCounts(new Map([["github.pr.opened", 5]]), new Map([["github.pr.opened", 3]]));
    expect(rowFor(rows, "github.pr.opened")).toMatchObject({ live: 5, shadow: 3, verdict: "shadow-deficit", expectation: "both" });
  });

  test("shadow > live on a cloud-only type is the EXPECTED superset, not an error", () => {
    const rows = compareTypeCounts(new Map(), new Map([["github.check_suite.completed", 44]]));
    expect(rowFor(rows, "github.check_suite.completed")).toMatchObject({ shadow: 44, verdict: "cloud-superset", expectation: "cloud-only" });
  });

  test("a FILED cloud gap is classified against its ticket, not as an unexplained deficit", () => {
    const rows = compareTypeCounts(new Map([["linear.reaction.created", 2]]), new Map());
    expect(rowFor(rows, "linear.reaction.created")).toMatchObject({ verdict: "known-gap-deficit", expectation: "known-gap", ticket: "CTC-297" });
  });

  test("expected-zero rows are PRINTED — an omitted row is indistinguishable from nobody looking", () => {
    const rows = compareTypeCounts(new Map(), new Map());
    const zeroRows = rows.filter((r) => r.verdict.startsWith("expected-zero"));
    expect(zeroRows.length).toBe(DEFAULT_TYPE_CENSUS.length + 3);
    expect(rowFor(rows, "github.push.*")).toMatchObject({ live: 0, shadow: 0, verdict: "expected-zero" });
  });

  test("unmappable provider types are declared structurally invisible, not silently absent", () => {
    const rows = compareTypeCounts(new Map(), new Map());
    for (const t of ["workflow_job", "check_run", "Attachment"]) {
      const row = rows.find((r) => r.type.startsWith(t));
      expect(row).toBeDefined();
      expect(row.verdict).toBe("expected-zero-structural");
      expect(row.expectation).toBe("unmappable");
    }
  });

  test("equal counts on a real type are `equal`, not `expected-zero`", () => {
    const rows = compareTypeCounts(new Map([["linear.issue.updated", 7]]), new Map([["linear.issue.updated", 7]]));
    expect(rowFor(rows, "linear.issue.updated").verdict).toBe("equal");
  });

  test("an uncensused type still gets a row and still fails on deficit", () => {
    const rows = compareTypeCounts(new Map([["github.brand_new.thing", 2]]), new Map());
    expect(rowFor(rows, "github.brand_new.thing")).toMatchObject({ expectation: "uncensused", verdict: "shadow-deficit" });
  });

  test("censusExpectationFor matches by prefix", () => {
    expect(censusExpectationFor("github.pr.opened").expectation).toBe("both");
    expect(censusExpectationFor("github.workflow_run.completed").expectation).toBe("cloud-only");
    expect(censusExpectationFor("mystery.thing").expectation).toBe("uncensused");
  });

  test("perTypeCounts counts, it does not merely record presence", () => {
    const m = perTypeCounts([
      entry(envelope({ name: "github.pr.opened" })),
      entry(envelope({ name: "github.pr.opened" })),
      entry(envelope({ name: "github.pr.closed" })),
    ]);
    expect(m.get("github.pr.opened")).toBe(2);
    expect(m.get("github.pr.closed")).toBe(1);
  });
});

// ── envelope equivalence ────────────────────────────────────────────────────────────────

describe("compareEnvelope", () => {
  test("identical envelopes have no differences", () => {
    expect(compareEnvelope(envelope(), envelope())).toEqual([]);
  });

  test("a different mapped event.name is a CORE difference", () => {
    const d = compareEnvelope(envelope({ name: "github.pr.opened" }), envelope({ name: "github.pr.closed" }));
    expect(d.some((x) => x.field === "attributes.event.name" && x.class === "core")).toBe(true);
  });

  test("a value disagreement on a locally-enriched attribute is still CORE", () => {
    const d = compareEnvelope(
      envelope({ attrs: { "vcs.pr.number": 1 } }),
      envelope({ attrs: { "vcs.pr.number": 2 } }));
    expect(d.find((x) => x.field === "attributes.vcs.pr.number").class).toBe("core");
  });

  test("a PRESENCE-only difference on a locally-enriched attribute is not core", () => {
    const d = compareEnvelope(envelope({ attrs: { "catalyst.orchestrator.id": "orch-1" } }), envelope());
    expect(d.find((x) => x.field === "attributes.catalyst.orchestrator.id").class).toBe("local-enrichment-presence");
  });

  test("--strict-attrs promotes an enrichment presence difference to core", () => {
    const d = compareEnvelope(envelope({ attrs: { "catalyst.orchestrator.id": "orch-1" } }), envelope(), { strictAttrs: true });
    expect(d.find((x) => x.field === "attributes.catalyst.orchestrator.id").class).toBe("core");
  });

  test("ignoreAttrs excludes a declared transport annotation (the cloud seq)", () => {
    const withSeq = envelope({ seq: 101 });
    expect(compareEnvelope(envelope(), withSeq).length).toBe(1);
    expect(compareEnvelope(envelope(), withSeq, { ignoreAttrs: new Set(["catalyst.cloud.event.seq"]) })).toEqual([]);
  });

  test("an UNDECLARED consumer-added attribute still surfaces as a difference", () => {
    const d = compareEnvelope(envelope(), envelope({ attrs: { "some.new.attr": 1 } }));
    expect(d.find((x) => x.field === "attributes.some.new.attr").class).toBe("core");
  });

  test("severity differences are caught", () => {
    const d = compareEnvelope(envelope({ severity: "INFO" }), envelope({ severity: "ERROR" }));
    expect(d.some((x) => x.field === "severityText")).toBe(true);
  });

  test("ts / id / resource differences are NOT differences (declared policy)", () => {
    const live = envelope({ ts: "2026-07-26T22:11:00.000Z", version: "12.37.0", host: "mini" });
    const shadow = envelope({ ts: "2026-07-26T22:10:48.000Z", version: "0.1.0", host: "mini" });
    shadow.id = "different-uuid";
    expect(compareEnvelope(live, shadow)).toEqual([]);
  });
});

// ── ingestion ───────────────────────────────────────────────────────────────────────────

describe("ingestText", () => {
  test("counts malformed lines rather than skipping them", () => {
    const acc = ingestText("live", `${line(envelope())}\n{not json`, opts());
    expect(acc.malformed.length).toBe(1);
    expect(acc.selected.length).toBe(1);
  });

  test("captures control records separately from events", () => {
    const acc = ingestText("shadow", `${line(envelope())}\n${JSON.stringify({ error: "cursor_underflow", resync: true })}`, opts());
    expect(acc.control.length).toBe(1);
    expect(acc.malformed.length).toBe(0);
  });

  test("non-webhook events are excluded from the comparison but counted", () => {
    const acc = ingestText("live", [line(envelope()), line(envelope({ name: "phase.implement.complete.CTL-1" }))].join("\n"), opts());
    expect(acc.nonWebhook).toBe(1);
    expect(acc.webhookTotal).toBe(1);
  });

  test("blank lines and a trailing newline are not malformed", () => {
    const acc = ingestText("live", `${line(envelope())}\n\n`, opts());
    expect(acc.malformed.length).toBe(0);
    expect(acc.blank).toBe(2);
  });

  test("the window filters on ts, inclusive at both ends", () => {
    const o = opts({ fromMs: Date.parse("2026-07-26T22:00:00Z"), toMs: Date.parse("2026-07-26T23:00:00Z") });
    const acc = ingestText("live", [
      line(envelope({ id: "before", ts: "2026-07-26T21:59:59.000Z" })),
      line(envelope({ id: "start", ts: "2026-07-26T22:00:00.000Z" })),
      line(envelope({ id: "end", ts: "2026-07-26T23:00:00.000Z" })),
      line(envelope({ id: "after", ts: "2026-07-26T23:00:01.000Z" })),
    ].join("\n"), o);
    expect(acc.selected.map((e) => e.deliveryId)).toEqual(["start", "end"]);
    expect(acc.outOfWindow).toBe(2);
  });

  test("an envelope with no delivery id is recorded as a join-key gap, not silently dropped", () => {
    const acc = ingestText("live", line(envelope({ id: null })), opts());
    expect(acc.missingDeliveryId.length).toBe(1);
    expect(acc.selected.length).toBe(0);
  });

  test("--repos filters GitHub only; Linear is never repo-filtered", () => {
    const o = opts({ repos: ["coalesce-labs/catalyst"] });
    const acc = ingestText("live", [
      line(envelope({ id: "in", attrs: { "vcs.repository.name": "coalesce-labs/catalyst" } })),
      line(envelope({ id: "out", attrs: { "vcs.repository.name": "ryanrozich/slides" } })),
      line(envelope({ id: "lin", name: "linear.comment.created" })),
    ].join("\n"), o);
    expect(acc.selected.map((e) => e.deliveryId).sort()).toEqual(["in", "lin"]);
    expect(acc.repoFiltered).toBe(1);
  });
});

describe("monthFilesFor", () => {
  test("covers every month the window spans", () => {
    const f = monthFilesFor("/d", Date.parse("2026-06-20T00:00:00Z"), Date.parse("2026-08-02T00:00:00Z"));
    expect(f).toEqual(["/d/2026-06.jsonl", "/d/2026-07.jsonl", "/d/2026-08.jsonl"]);
  });

  test("a single-month window yields one file", () => {
    expect(monthFilesFor("/d", Date.parse("2026-07-01T00:00:00Z"), Date.parse("2026-07-31T00:00:00Z")))
      .toEqual(["/d/2026-07.jsonl"]);
  });
});

// ── the exit contract (defect 1: the worst one) ─────────────────────────────────────────

describe("evaluate — three-way exit contract", () => {
  const window = { fromMs: Date.parse("2026-07-26T22:00:00Z"), fromIso: "2026-07-26T22:00:00Z", toMs: Date.parse("2026-07-26T23:00:00Z"), toIso: "2026-07-26T23:00:00Z", edgeMarginMs: 0 };
  const clean = [
    line(envelope({ id: "gh-1", ts: "2026-07-26T22:11:00.000Z" })),
    line(envelope({ id: "gh-2", ts: "2026-07-26T22:12:00.000Z" })),
    line(envelope({ id: "li-1", name: "linear.comment.created", ts: "2026-07-26T22:13:00.000Z" })),
  ].join("\n");
  const cleanShadow = [
    line(envelope({ id: "gh-1", ts: "2026-07-26T22:11:00.000Z", seq: 1 })),
    line(envelope({ id: "gh-2", ts: "2026-07-26T22:12:00.000Z", seq: 2 })),
    line(envelope({ id: "li-1", name: "linear.comment.created", ts: "2026-07-26T22:13:00.000Z", seq: 3 })),
  ].join("\n");

  const run = (liveText, shadowText, over = {}) => {
    const o = opts({ ...window, ...over });
    return evaluate({ live: ingestText("live", liveText, o), shadow: ingestText("shadow", shadowText, o), opts: o, generatedAt: "1970-01-01T00:00:00.000Z" });
  };

  test("clean parity exits 0 and reports matched pairs per source", () => {
    const r = run(clean, cleanShadow);
    expect(r.exitCode).toBe(EXIT_HEALTHY);
    expect(r.verdict).toBe("healthy");
    expect(r.join.matchedBySource).toEqual({ github: 2, linear: 1 });
  });

  test("a zero-match join is a LOUD failure, never a pass", () => {
    const shadow = cleanShadow.replaceAll("gh-", "zz-").replaceAll("li-", "yy-");
    const r = run(clean, shadow);
    expect(r.exitCode).toBe(EXIT_PROBLEM);
    for (const s of ["github", "linear"]) {
      expect(r.checks.find((c) => c.id === `MATCHED_NONZERO_${s}`).status).toBe("fail");
    }
  });

  test("a control record makes the run NOT EVALUABLE (exit 2), never healthy", () => {
    const r = run(clean, `${cleanShadow}\n${JSON.stringify({ error: "cursor_underflow", resync: true })}`);
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "CONTROL_RECORD")).toBe(true);
  });

  test("when the run is not evaluable, EVERY assertion is `not_run` — none is a pass", () => {
    const r = run(clean, `${cleanShadow}\n${JSON.stringify({ error: "cursor_underflow" })}`);
    expect(r.checks.length).toBeGreaterThan(0);
    expect(r.checks.every((c) => c.status === "not_run")).toBe(true);
    expect(r.counts.pass).toBe(0);
  });

  test("cannot_evaluate takes precedence over problem — a partial evaluation is never a verdict", () => {
    const broken = `${cleanShadow.split("\n").slice(0, 1).join("\n")}\n${JSON.stringify({ error: "cursor_underflow" })}`;
    const r = run(clean, broken);
    expect(r.verdict).toBe("cannot_evaluate");
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
  });

  test("a window spanning two producer versions is not evaluable (deploy boundary)", () => {
    const shadow = [
      line(envelope({ id: "gh-1", ts: "2026-07-26T22:11:00.000Z", seq: 1, version: "0.1.0" })),
      line(envelope({ id: "gh-2", ts: "2026-07-26T22:12:00.000Z", seq: 2, version: "0.2.0" })),
      line(envelope({ id: "li-1", name: "linear.comment.created", ts: "2026-07-26T22:13:00.000Z", seq: 3, version: "0.2.0" })),
    ].join("\n");
    const r = run(clean, shadow);
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "DEPLOY_BOUNDARY")).toBe(true);
  });

  test("--allow-version-span converts the deploy gate into a printed waiver", () => {
    const shadow = [
      line(envelope({ id: "gh-1", ts: "2026-07-26T22:11:00.000Z", seq: 1, version: "0.1.0" })),
      line(envelope({ id: "gh-2", ts: "2026-07-26T22:12:00.000Z", seq: 2, version: "0.2.0" })),
      line(envelope({ id: "li-1", name: "linear.comment.created", ts: "2026-07-26T22:13:00.000Z", seq: 3, version: "0.2.0" })),
    ].join("\n");
    const r = run(clean, shadow, { allowVersionSpan: true });
    expect(r.blockers.some((b) => b.id === "DEPLOY_BOUNDARY")).toBe(false);
    expect(r.waivers.some((w) => w.includes("--allow-version-span"))).toBe(true);
  });

  test("a missing seq attribute is exit 2, not a silently skipped check", () => {
    const r = run(clean, clean);
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "SEQ_ATTR_ABSENT")).toBe(true);
  });

  test("--no-seq-checks waives the ordering ASSERTIONS when the seqs are actually there", () => {
    const r = run(clean, cleanShadow, { seqChecks: false });
    expect(r.exitCode).toBe(EXIT_HEALTHY);
    expect(r.notAsserted.map((n) => n.id)).toContain("SEQ_WIRE_ORDER");
    expect(r.waivers.some((w) => w.includes("--no-seq-checks"))).toBe(true);
  });

  // C1/C3/H15/M4: the seq attribute is a PRODUCER CONTRACT, not an operator preference.
  // When it is absent the three seq questions cannot ever be asked, so waiving them would
  // manufacture a permanent green with the whole ordering/coverage subsystem switched off.
  test("--no-seq-checks does NOT waive a shadow log carrying no seq attribute at all", () => {
    const r = run(clean, clean, { seqChecks: false });
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    const blocker = r.blockers.find((b) => b.id === "SEQ_ATTR_ABSENT");
    expect(blocker).toBeDefined();
    expect(blocker.evidence.waivableByNoSeqChecks).toBe(false);
  });

  test("a shadow log with no seq attribute is exit 2 with the seq checks ON as well", () => {
    const r = run(clean, clean);
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "SEQ_ATTR_ABSENT")).toBe(true);
    expect(r.checks.every((c) => c.status === "not_run")).toBe(true);
  });

  test("coverage is NOT asserted by default, and says so (integrity never implies coverage)", () => {
    const r = run(clean, cleanShadow);
    const cov = r.notAsserted.find((n) => n.id === "SEQ_COVERAGE");
    expect(cov).toBeDefined();
    expect(cov.reason).toContain("feed-health");
    expect(r.checks.some((c) => c.id === "SEQ_COVERAGE")).toBe(false);
  });

  test("coverage expectations without a complete ledger are refused, not weakened", () => {
    const r = run(clean, cleanShadow, { expectFirstSeq: 1, expectHeadSeq: 3 });
    expect(r.notAsserted.some((n) => n.id === "SEQ_COVERAGE")).toBe(true);
    expect(r.checks.some((c) => c.id === "SEQ_COVERAGE")).toBe(false);
  });

  test("a SHORT READ fails coverage while contiguity passes — the two are independent", () => {
    const r = run(clean, cleanShadow, { seqLedgerComplete: true, expectFirstSeq: 1, expectHeadSeq: 99 });
    expect(r.checks.find((c) => c.id === "SEQ_CONTIGUITY").status).toBe("pass");
    expect(r.checks.find((c) => c.id === "SEQ_COVERAGE").status).toBe("fail");
    expect(r.exitCode).toBe(EXIT_PROBLEM);
  });

  test("--require-coverage without expectations is exit 2", () => {
    const r = run(clean, cleanShadow, { requireCoverage: true });
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "COVERAGE_REQUIRED")).toBe(true);
  });

  test("a known-gap loss (CTC-297) is warned against its ticket, not silently ignored", () => {
    // interior ts on purpose: both sides keep the same min/max, so the (separate) overlap
    // gate stays quiet and the known-gap classifier is what is under test.
    const live = [clean, line(envelope({ id: "rx-1", name: "linear.reaction.created", ts: "2026-07-26T22:12:30.000Z" }))].join("\n");
    const r = run(live, cleanShadow, { edgeMarginMs: 0 });
    const kg = r.checks.find((c) => c.id === "KNOWN_GAP_LOSSES");
    expect(kg.status).toBe("warn");
    expect(r.checks.find((c) => c.id === "MISSING_FROM_SHADOW").status).toBe("pass");
  });

  test("--strict-known-gaps promotes a filed gap to a failure", () => {
    const live = [clean, line(envelope({ id: "rx-1", name: "linear.reaction.created", ts: "2026-07-26T22:12:30.000Z" }))].join("\n");
    const r = run(live, cleanShadow, { edgeMarginMs: 0, strictKnownGaps: true });
    expect(r.checks.find((c) => c.id === "KNOWN_GAP_LOSSES").status).toBe("fail");
    expect(r.exitCode).toBe(EXIT_PROBLEM);
  });

  test("shadow-only of a type the live side ALSO carries is flagged (smee-side drop shape)", () => {
    const live = clean;
    const shadow = [cleanShadow, line(envelope({ id: "gh-9", ts: "2026-07-26T22:12:30.000Z", seq: 4 }))].join("\n");
    const r = run(live, shadow, { edgeMarginMs: 0 });
    const c = r.checks.find((c2) => c2.id === "SHADOW_ONLY");
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("smee-side drop");
  });

  test("shadow-only of a CLOUD-ONLY type is the expected superset and stays green", () => {
    const shadow = [cleanShadow, line(envelope({ id: "wf-1", name: "github.workflow_run.completed", ts: "2026-07-26T22:12:30.000Z", seq: 4 }))].join("\n");
    const r = run(clean, shadow, { edgeMarginMs: 0 });
    expect(r.checks.find((c) => c.id === "SHADOW_ONLY").status).toBe("pass");
    expect(r.exitCode).toBe(EXIT_HEALTHY);
  });

  test("blind spots are reported on EVERY run, including a healthy one", () => {
    const r = run(clean, cleanShadow);
    expect(r.blindSpots.length).toBeGreaterThanOrEqual(5);
    expect(r.blindSpots.join(" ")).toContain("workflow_job");
  });

  test("the report declares its own comparison policy (nothing excluded silently)", () => {
    const r = run(clean, cleanShadow);
    expect(r.policy.ignoredAttrs).toContain("catalyst.cloud.event.seq");
    expect(r.policy.uncomparedEnvelopeFields.length).toBeGreaterThan(0);
    expect(r.policy.joinKey).toContain("webhook.delivery.id");
  });

  test("an interior live-only delivery fails, and the failure lists the delivery id", () => {
    const shadow = [
      line(envelope({ id: "gh-1", ts: "2026-07-26T22:11:00.000Z", seq: 1 })),
      line(envelope({ id: "li-1", name: "linear.comment.created", ts: "2026-07-26T22:13:00.000Z", seq: 3 })),
    ].join("\n");
    const r = run(clean, shadow);
    const c = r.checks.find((c2) => c2.id === "MISSING_FROM_SHADOW");
    expect(c.status).toBe("fail");
    expect(JSON.stringify(c.evidence)).toContain("gh-2");
  });
});

// ── the negative control itself ─────────────────────────────────────────────────────────

describe("selfTest — the negative control must be OBSERVED to go red", () => {
  test("every seeded detector fires and the positive control stays green", () => {
    const r = selfTest();
    const failed = r.cases.filter((c) => !c.ok).map((c) => `${c.name} (exit ${c.exitCode}, expected ${c.expectedExit})`);
    expect(failed).toEqual([]);
    expect(r.fired).toBe(r.negatives);
    expect(r.positiveOk).toBe(true);
    expect(r.allOk).toBe(true);
  });

  test("it covers the five scenarios the harness contract names, plus a positive control", () => {
    const names = selfTest().cases.map((c) => c.name).join(" | ");
    for (const needle of ["dropped delivery", "zero-match join", "out-of-order seq", "control record", "envelope mismatch", "positive control"]) {
      expect(names).toContain(needle);
    }
  });
});

// ── the torn-tail waiver (narrow by construction) ───────────────────────────────────────

describe("--tolerate-torn-tail", () => {
  const window = { fromMs: Date.parse("2026-07-26T22:00:00Z"), toMs: Date.parse("2026-07-26T23:00:00Z"), edgeMarginMs: 0 };
  const good = [
    line(envelope({ id: "a", ts: "2026-07-26T22:11:00.000Z" })),
    line(envelope({ id: "b", name: "linear.comment.created", ts: "2026-07-26T22:12:00.000Z" })),
  ].join("\n");
  const goodShadow = [
    line(envelope({ id: "a", ts: "2026-07-26T22:11:00.000Z", seq: 1 })),
    line(envelope({ id: "b", name: "linear.comment.created", ts: "2026-07-26T22:12:00.000Z", seq: 2 })),
  ].join("\n");
  const run = (liveText, shadowText, over = {}) => {
    const o = opts({ ...window, ...over });
    return evaluate({ live: ingestText("live", liveText, o), shadow: ingestText("shadow", shadowText, o), opts: o, generatedAt: "1970-01-01T00:00:00.000Z" });
  };

  test("a torn FINAL line is exit 2 unless the waiver is passed", () => {
    expect(run(good, `${goodShadow}\n{"attributes":`).exitCode).toBe(EXIT_CANNOT_EVALUATE);
  });

  test("the waiver covers the last CONTENT line even with a trailing newline", () => {
    const r = run(good, `${goodShadow}\n{"attributes":\n`, { tolerateTornTail: true });
    expect(r.exitCode).toBe(EXIT_HEALTHY);
    expect(r.waivers.some((w) => w.includes("torn final line"))).toBe(true);
  });

  test("the waiver does NOT cover a malformed line in the middle of a file", () => {
    const r = run(good, `${line(envelope({ id: "a", ts: "2026-07-26T22:11:00.000Z", seq: 1 }))}\n{"broken":\n${line(envelope({ id: "b", name: "linear.comment.created", ts: "2026-07-26T22:12:00.000Z", seq: 2 }))}`, { tolerateTornTail: true });
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "MALFORMED_INPUT")).toBe(true);
  });
});

// ── shadow-log markers (consumer declarations about its own coverage) ───────────────────

describe("shadow markers", () => {
  const window = { fromMs: Date.parse("2026-07-26T22:00:00Z"), toMs: Date.parse("2026-07-26T23:00:00Z"), edgeMarginMs: 0 };
  const live = [
    line(envelope({ id: "a", ts: "2026-07-26T22:11:00.000Z" })),
    line(envelope({ id: "big", ts: "2026-07-26T22:12:00.000Z" })),
    line(envelope({ id: "c", name: "linear.comment.created", ts: "2026-07-26T22:13:00.000Z" })),
  ].join("\n");
  const shadow = [
    line(envelope({ id: "a", ts: "2026-07-26T22:11:00.000Z", seq: 1 })),
    line(envelope({ id: "c", name: "linear.comment.created", ts: "2026-07-26T22:13:00.000Z", seq: 3 })),
  ].join("\n");
  const elisionMarker = JSON.stringify({
    marker: "unmappable-payload", ts: "2026-07-26T22:12:01.000Z",
    attributes: { "event.name": "catalyst.cloud_feed.unmappable_payload", "webhook.delivery.id": "big" },
    seq: 2, deliveryId: "big", source: "github", eventType: "pull_request", payloadBytes: 120000,
    reason: "payloadOmitted",
  });
  const run = (liveText, shadowText, over = {}) => {
    const o = opts({ ...window, ...over });
    return evaluate({ live: ingestText("live", liveText, o), shadow: ingestText("shadow", shadowText, o), opts: o, generatedAt: "1970-01-01T00:00:00.000Z" });
  };

  test("without a marker the elided delivery is UNEXPLAINED loss", () => {
    const r = run(live, shadow);
    expect(r.checks.find((c) => c.id === "MISSING_FROM_SHADOW").status).toBe("fail");
    expect(r.join.liveOnly.unexplained).toBe(1);
  });

  test("an elision marker ATTRIBUTES the live-only delivery instead of hiding or failing it", () => {
    const r = run(live, `${shadow}\n${elisionMarker}`);
    expect(r.checks.find((c) => c.id === "MISSING_FROM_SHADOW").status).toBe("pass");
    expect(r.join.liveOnly.elided).toBe(1);
    expect(r.join.liveOnly.unexplained).toBe(0);
    const el = r.checks.find((c) => c.id === "ELIDED_PAYLOADS");
    expect(el.status).toBe("warn");
    expect(JSON.stringify(el.evidence)).toContain("big");
    // the attributed delivery must not resurface as a per-type deficit (the two checks
    // have to agree about the same delivery) ...
    expect(r.checks.find((c) => c.id === "TYPE_COUNTS").status).toBe("pass");
    // ... but H1: an elided delivery genuinely never reached the shadow log, and the
    // consumer grades it EXIT_PROBLEM. A `warn` is NON-GREEN, so the two halves of this
    // deliverable cannot give opposite verdicts on the same event any more.
    expect(r.exitCode).toBe(EXIT_PROBLEM);
    expect(r.verdict).toBe("problem");
  });

  test("an UNCORROBORATED elision marker cannot excuse a loss (exit 2, not attribution)", () => {
    // Same marker, but the payload is nowhere near the 96KB cap it claims to have hit.
    const bogus = JSON.stringify({
      marker: "unmappable-payload", ts: "2026-07-26T22:12:01.000Z",
      attributes: { "event.name": "catalyst.cloud_feed.unmappable_payload", "webhook.delivery.id": "big" },
      deliveryId: "big", reason: "payloadOmitted", payloadBytes: 12,
    });
    const r = run(live, `${shadow}\n${bogus}`);
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "UNCORROBORATED_ELISION")).toBe(true);
  });

  test("an elision marker with no reason/payloadBytes cannot attribute either", () => {
    const bare = JSON.stringify({
      ts: "2026-07-26T22:12:01.000Z",
      attributes: { "event.name": "catalyst.cloud_feed.unmappable_payload", "webhook.delivery.id": "big" },
    });
    const r = run(live, `${shadow}\n${bare}`);
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "UNCORROBORATED_ELISION")).toBe(true);
  });

  test("the ELIDED_PAYLOADS row is emitted even at zero (expected-zero is a result)", () => {
    const clean = [line(envelope({ id: "a", ts: "2026-07-26T22:11:00.000Z", seq: 1 })), line(envelope({ id: "c", name: "linear.comment.created", ts: "2026-07-26T22:13:00.000Z", seq: 3 }))].join("\n");
    const liveClean = [line(envelope({ id: "a", ts: "2026-07-26T22:11:00.000Z" })), line(envelope({ id: "c", name: "linear.comment.created", ts: "2026-07-26T22:13:00.000Z" }))].join("\n");
    const r = run(liveClean, clean);
    const el = r.checks.find((c) => c.id === "ELIDED_PAYLOADS");
    expect(el.status).toBe("pass");
    expect(el.detail).toContain("never fired in production");
  });

  test("a consumer-declared feed gap makes the run NOT evaluable", () => {
    const gap = JSON.stringify({ ts: "2026-07-26T22:12:00.000Z", attributes: { "event.name": "catalyst.cloud_feed.gap" }, marker: "feed-gap" });
    const r = run(live, `${shadow}\n${gap}`);
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "FEED_GAP_DECLARED")).toBe(true);
    expect(r.checks.every((c) => c.status === "not_run")).toBe(true);
  });

  test("an UNRECOGNISED marker is exit 2, not silence (a consumer rename must surface)", () => {
    const unknown = JSON.stringify({ ts: "2026-07-26T22:12:00.000Z", attributes: { "event.name": "catalyst.cloud_feed.renamed_thing" } });
    const r = run(live, `${shadow}\n${unknown}`);
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "UNKNOWN_SHADOW_MARKER")).toBe(true);
  });

  test("a marker with an unparseable ts is treated as IN window, never dropped", () => {
    const gap = JSON.stringify({ ts: "not-a-timestamp", attributes: { "event.name": "catalyst.cloud_feed.gap" } });
    const r = run(live, `${shadow}\n${gap}`);
    expect(r.blockers.some((b) => b.id === "FEED_GAP_DECLARED")).toBe(true);
  });

  test("markers are not counted as webhook envelopes and are surfaced in the report", () => {
    const r = run(live, `${shadow}\n${elisionMarker}`);
    expect(r.scanned.shadow.webhookEnvelopes).toBe(2);
    expect(r.scanned.shadow.markers.byKind).toEqual({ elided: 1 });
    expect(r.markers.some((m) => m.kind === "elided" && m.deliveryId === "big")).toBe(true);
  });
});

describe("elision attribution cannot be used to hide a real deficit", () => {
  test("attribution discounts EXACTLY the marked deliveries, not the whole type", () => {
    // 3 live of one type, 1 shadow, 1 marked elided -> still a net deficit of 1.
    const rows = compareTypeCounts(
      new Map([["github.pr.opened", 3]]),
      new Map([["github.pr.opened", 1]]),
      DEFAULT_TYPE_CENSUS,
      new Map([["github.pr.opened", 1]]));
    const row = rows.find((r) => r.type === "github.pr.opened");
    expect(row).toMatchObject({ live: 3, shadow: 1, attributedElided: 1, verdict: "shadow-deficit" });
  });

  test("raw counts are never rewritten by the attribution (Gate B evidence stays raw)", () => {
    const rows = compareTypeCounts(
      new Map([["github.pr.opened", 2]]),
      new Map([["github.pr.opened", 1]]),
      DEFAULT_TYPE_CENSUS,
      new Map([["github.pr.opened", 1]]));
    const row = rows.find((r) => r.type === "github.pr.opened");
    expect(row.live).toBe(2);
    expect(row.shadow).toBe(1);
    expect(row.verdict).toBe("equal-after-attribution");
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// CTL-1534 review remediation — each block names the false green it prevents.
// ────────────────────────────────────────────────────────────────────────────────────────

const W = { fromMs: Date.parse("2026-07-26T22:00:00Z"), fromIso: "2026-07-26T22:00:00Z", toMs: Date.parse("2026-07-26T23:00:00Z"), toIso: "2026-07-26T23:00:00Z" };
const ev = (id, ts, seq, name = "github.pr.opened") => line(envelope({ id, ts, seq, name }));
const runW = (liveText, shadowText, over = {}) => {
  const o = opts({ ...W, ...over });
  return evaluate({ live: ingestText("live", liveText, o), shadow: ingestText("shadow", shadowText, o), opts: o, generatedAt: "1970-01-01T00:00:00.000Z" });
};

// C2 / H7 / H14 — a margin that can swallow the whole window is a detector that cannot fire
describe("the edge margin can never swallow the window", () => {
  const live = [ev("a", "2026-07-26T22:01:00.000Z"), ev("b", "2026-07-26T22:01:30.000Z"), ev("c", "2026-07-26T22:02:00.000Z", null, "linear.comment.created")].join("\n");
  const shadow = [ev("a", "2026-07-26T22:01:00.000Z", 1), ev("d", "2026-07-26T22:01:30.000Z", 2), ev("c", "2026-07-26T22:02:00.000Z", 3, "linear.comment.created")].join("\n");

  test("a 3-minute window at the DEFAULT 120s margin is exit 2, not a green with two vacuous detectors", () => {
    const r = runW(live, shadow, { fromMs: Date.parse("2026-07-26T22:00:00Z"), toMs: Date.parse("2026-07-26T22:03:00Z"), toIso: "2026-07-26T22:03:00Z" });
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "EDGE_MARGIN_SWALLOWS_WINDOW")).toBe(true);
    expect(r.checks.every((c) => c.status === "not_run")).toBe(true);
  });

  test("the same bytes with a wide-enough window DO fail the loss detector (the check works)", () => {
    const r = runW(live, shadow, { edgeMarginMs: 0 });
    expect(r.exitCode).toBe(EXIT_PROBLEM);
    expect(r.checks.find((c) => c.id === "MISSING_FROM_SHADOW").status).toBe("fail");
  });

  test("an UNBOUNDED window with a non-zero margin refuses to derive the boundary from the data", () => {
    const o = opts({ fromMs: null, fromIso: null, toMs: null, toIso: null });
    const r = evaluate({ live: ingestText("live", live, o), shadow: ingestText("shadow", shadow, o), opts: o, generatedAt: "1970-01-01T00:00:00.000Z" });
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "UNBOUNDED_WINDOW")).toBe(true);
  });

  test("unbounded is allowed only with --edge-margin 0 (nothing is edge-excluded then)", () => {
    const o = opts({ fromMs: null, fromIso: null, toMs: null, toIso: null, edgeMarginMs: 0 });
    const r = evaluate({ live: ingestText("live", live, o), shadow: ingestText("shadow", shadow, o), opts: o, generatedAt: "1970-01-01T00:00:00.000Z" });
    expect(r.blockers.some((b) => b.id === "UNBOUNDED_WINDOW")).toBe(false);
    expect(r.checks.find((c) => c.id === "MISSING_FROM_SHADOW").status).toBe("fail");
  });

  test("a detector whose every candidate was edge-excluded is not_run — never a pass", () => {
    // one matched pair near the end keeps the overlap gate quiet; the single one-sided
    // delivery sits inside the trailing 120s margin.
    const l = [ev("a", "2026-07-26T22:10:00.000Z"), ev("z", "2026-07-26T22:59:00.000Z"), ev("edge", "2026-07-26T22:59:30.000Z"), ev("li", "2026-07-26T22:11:00.000Z", null, "linear.comment.created")].join("\n");
    const s = [ev("a", "2026-07-26T22:10:00.000Z", 1), ev("z", "2026-07-26T22:59:00.000Z", 2), ev("li", "2026-07-26T22:11:00.000Z", 3, "linear.comment.created")].join("\n");
    const r = runW(l, s);
    const c = r.checks.find((x) => x.id === "MISSING_FROM_SHADOW");
    expect(c.status).toBe("not_run");
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
  });
});

// C4 — --require-coverage must guard EVERY route to an unasserted coverage answer
describe("--require-coverage cannot be satisfied by a demotion to not-asserted", () => {
  const live = [ev("a", "2026-07-26T22:11:00.000Z"), ev("c", "2026-07-26T22:13:00.000Z", null, "linear.comment.created")].join("\n");
  const shadow = [ev("a", "2026-07-26T22:11:00.000Z", 101), ev("c", "2026-07-26T22:13:00.000Z", 102, "linear.comment.created")].join("\n");

  test("with expectations but WITHOUT --seq-ledger-complete it is exit 2, not healthy", () => {
    const r = runW(live, shadow, { requireCoverage: true, expectFirstSeq: 101, expectHeadSeq: 200 });
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    const b = r.blockers.find((x) => x.id === "COVERAGE_REQUIRED");
    expect(b.evidence.missing.join(" ")).toContain("--seq-ledger-complete");
  });

  test("with --no-seq-checks it is exit 2, not healthy", () => {
    const r = runW(live, shadow, { requireCoverage: true, expectFirstSeq: 101, expectHeadSeq: 200, seqLedgerComplete: true, seqChecks: false });
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((x) => x.id === "COVERAGE_REQUIRED")).toBe(true);
  });

  test("with every precondition met the coverage question is actually ANSWERED (and red here)", () => {
    const r = runW(live, shadow, { requireCoverage: true, expectFirstSeq: 101, expectHeadSeq: 200, seqLedgerComplete: true });
    expect(r.blockers.some((x) => x.id === "COVERAGE_REQUIRED")).toBe(false);
    expect(r.checks.find((c) => c.id === "SEQ_COVERAGE").status).toBe("fail");
    expect(r.exitCode).toBe(EXIT_PROBLEM);
  });
});

// C7 — the census is consulted in BOTH directions; presence never classifies
describe("shadow > live is classified by the CENSUS, not by presence", () => {
  test("a censused `both` type the live side lost 100% of is a live-total-loss, not a superset", () => {
    const rows = compareTypeCounts(new Map(), new Map([["github.deployment_status.success", 40]]));
    const row = rows.find((r) => r.type === "github.deployment_status.success");
    expect(row.expectation).toBe("both");
    expect(row.verdict).toBe("live-total-loss");
  });

  test("a partial live-side deficit on a `both` type is a live-deficit", () => {
    const rows = compareTypeCounts(new Map([["github.pr.opened", 2]]), new Map([["github.pr.opened", 41]]));
    expect(rows.find((r) => r.type === "github.pr.opened").verdict).toBe("live-deficit");
  });

  test("a cloud-only type is still the expected superset", () => {
    const rows = compareTypeCounts(new Map(), new Map([["github.check_suite.completed", 9]]));
    expect(rows.find((r) => r.type === "github.check_suite.completed").verdict).toBe("cloud-superset");
  });

  test("end to end: a total live-side loss of a `both` type is exit 1, not a green run", () => {
    const live = [ev("a", "2026-07-26T22:11:00.000Z"), ev("c", "2026-07-26T22:13:00.000Z", null, "linear.comment.created")].join("\n");
    const shadow = [
      ev("a", "2026-07-26T22:11:00.000Z", 1),
      ev("c", "2026-07-26T22:13:00.000Z", 2, "linear.comment.created"),
      ev("d1", "2026-07-26T22:14:00.000Z", 3, "github.deployment_status.success"),
      ev("d2", "2026-07-26T22:15:00.000Z", 4, "github.deployment_status.success"),
    ].join("\n");
    const r = runW(live, shadow);
    expect(r.exitCode).toBe(EXIT_PROBLEM);
    expect(r.checks.find((c) => c.id === "LIVE_DEFICIT_TYPES").status).toBe("fail");
    // and the shadow-only split must not have called them "expected superset"
    expect(r.join.shadowOnly.superset).toBe(0);
    expect(r.join.shadowOnly.overlapping).toBe(2);
  });
});

// H1 / H11 — a detected loss must not render as evaluated-healthy
describe("warn is NON-GREEN; only info leaves the verdict alone", () => {
  test("overlapping-type shadow-only (a smee-side drop) exits 1", () => {
    const live = [ev("a", "2026-07-26T22:11:00.000Z"), ev("c", "2026-07-26T22:13:00.000Z", null, "linear.comment.created")].join("\n");
    const shadow = [ev("a", "2026-07-26T22:11:00.000Z", 1), ev("c", "2026-07-26T22:13:00.000Z", 2, "linear.comment.created"), ev("extra", "2026-07-26T22:12:00.000Z", 3)].join("\n");
    const r = runW(live, shadow);
    expect(r.checks.find((c) => c.id === "SHADOW_ONLY").status).toBe("warn");
    expect(r.verdict).toBe("problem");
    expect(r.exitCode).toBe(EXIT_PROBLEM);
  });

  test("a known-gap loss is reported AND non-green (it is still a real gap)", () => {
    const live = [ev("a", "2026-07-26T22:11:00.000Z"), ev("rx", "2026-07-26T22:12:00.000Z", null, "linear.reaction.created"), ev("c", "2026-07-26T22:13:00.000Z", null, "linear.comment.created")].join("\n");
    const shadow = [ev("a", "2026-07-26T22:11:00.000Z", 1), ev("c", "2026-07-26T22:13:00.000Z", 2, "linear.comment.created")].join("\n");
    const r = runW(live, shadow);
    expect(r.checks.find((c) => c.id === "KNOWN_GAP_LOSSES").status).toBe("warn");
    expect(r.exitCode).toBe(EXIT_PROBLEM);
  });

  test("a live-side duplicate delivery is `info` — a provider redelivery contributes no warn", () => {
    const live = [ev("a", "2026-07-26T22:11:00.000Z"), ev("a", "2026-07-26T22:11:30.000Z"), ev("c", "2026-07-26T22:13:00.000Z", null, "linear.comment.created")].join("\n");
    const shadow = [ev("a", "2026-07-26T22:11:00.000Z", 1), ev("c", "2026-07-26T22:13:00.000Z", 2, "linear.comment.created")].join("\n");
    const r = runW(live, shadow);
    expect(r.checks.find((c) => c.id === "DUPLICATE_DELIVERY_LIVE").status).toBe("info");
    // it raises no warn of its own (the per-type deficit the second copy creates is a
    // separate, genuine signal and is allowed to speak for itself)
    expect(r.counts.warn).toBe(0);
    expect(r.counts.info).toBe(1);
  });
});

// H8 — the marker prefix is a floor, not a switch
describe("marker detection cannot be turned off by a flag", () => {
  test("an empty --marker-prefix is rejected at parse time", () => {
    expect(parseArgs(["--marker-prefix", ""]).ok).toBe(false);
    expect(parseArgs(["--seq-attr", ""]).ok).toBe(false);
  });

  test("re-pointing --marker-prefix still surfaces a built-in consumer gap declaration", () => {
    const live = [ev("a", "2026-07-26T22:11:00.000Z"), ev("c", "2026-07-26T22:13:00.000Z", null, "linear.comment.created")].join("\n");
    const shadow = [ev("a", "2026-07-26T22:11:00.000Z", 1), ev("c", "2026-07-26T22:13:00.000Z", 2, "linear.comment.created"),
      JSON.stringify({ ts: "2026-07-26T22:12:00.000Z", attributes: { "event.name": "catalyst.cloud_feed.gap" }, reason: "cursor_underflow" })].join("\n");
    const r = runW(live, shadow, { markerPrefix: "something.else." });
    expect(r.exitCode).toBe(EXIT_CANNOT_EVALUATE);
    expect(r.blockers.some((b) => b.id === "FEED_GAP_DECLARED")).toBe(true);
  });
});

// M3 / M6 — zero evidence and scoped-away questions are stated, never printed as passes
describe("a question that was not answered is never a green row", () => {
  test("an empty shadow window does not print three green seq rows", () => {
    const live = [ev("a", "2026-07-26T22:11:00.000Z"), ev("c", "2026-07-26T22:13:00.000Z", null, "linear.comment.created")].join("\n");
    const r = runW(live, "", { seqLedgerComplete: true, expectHeadSeq: 500 });
    for (const id of ["SEQ_WIRE_ORDER", "SEQ_CONTIGUITY", "SEQ_COVERAGE"]) {
      expect(r.checks.some((c) => c.id === id && c.status === "pass")).toBe(false);
      expect(r.notAsserted.some((n) => n.id === id)).toBe(true);
    }
  });

  test("SEQ_COVERAGE fails on an EMPTY replay while a head was expected", () => {
    const live = [ev("a", "2026-07-26T22:11:00.000Z"), ev("c", "2026-07-26T22:13:00.000Z", null, "linear.comment.created")].join("\n");
    const shadow = [ev("a", "2026-07-26T22:11:00.000Z", 101), ev("c", "2026-07-26T22:13:00.000Z", 102, "linear.comment.created")].join("\n");
    // seqs present (so the subsystem runs) but the operator asked for head 500
    const r = runW(live, shadow, { seqLedgerComplete: true, expectHeadSeq: 500 });
    expect(r.checks.find((c) => c.id === "SEQ_COVERAGE").status).toBe("fail");
  });

  test("a source scoped out by --sources is a STATED not-asserted row, not an omission", () => {
    const live = [ev("a", "2026-07-26T22:11:00.000Z"), ev("c", "2026-07-26T22:13:00.000Z", null, "linear.comment.created")].join("\n");
    const shadow = [ev("a", "2026-07-26T22:11:00.000Z", 1), ev("c", "2026-07-26T22:13:00.000Z", 2, "linear.comment.created")].join("\n");
    const r = runW(live, shadow, { sources: ["github"] });
    expect(r.notAsserted.some((n) => n.id === "MATCHED_NONZERO_linear")).toBe(true);
  });
});
