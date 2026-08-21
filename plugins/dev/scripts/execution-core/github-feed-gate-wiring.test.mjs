// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-gate-wiring.test.mjs
//
// ⚠️ SOURCE-LEVEL, AND THAT IS A COMPROMISE WORTH NAMING. The two properties below
// are ORDERING invariants in the broker process, and both files' comments call them
// load-bearing. Importing `broker/tailer.mjs` here to assert them behaviourally
// pulls in `broker/config.mjs`, whose pino import is unresolvable in this checkout
// (execution-core/config.mjs carries a console shim; the broker's does not), so
// `bun test` cannot load it at all — a gap that predates this change and fails
// identically on an unmodified main.
//
// A structural assertion is weaker than a behavioural one: it proves the call sites
// are ordered as written, not that the ordering has the effect claimed. It is here
// because the alternative was asserting nothing about the wiring, and an ordering
// bug in either file is silent — a gate armed after the tail routes real events
// through the window it was supposed to close.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const brokerDir = join(import.meta.dir, "..", "broker");

/**
 * ⛔ COMMENTS ARE STRIPPED BEFORE MATCHING, and this is not tidiness.
 *
 * My first version searched the raw source and the ordering assertion FAILED on
 * correctly-ordered code: `index.mjs:432` mentions "startTailing() below" inside a
 * comment 100 lines above the real call, so `indexOf` found the prose. A structural
 * test that reads comments is measuring the documentation, not the program — the
 * same class of false reading as counting event names with `grep` over payloads that
 * quote them (CTL-50).
 *
 * Block comments are stripped too, since both files use them heavily.
 */
const read = (f) =>
  readFileSync(join(brokerDir, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

describe("⛔ the gate decides BEFORE the router runs", () => {
  const tailer = read("tailer.mjs");

  test("the suppression block precedes every processEvent call", () => {
    const gate = tailer.indexOf("decideGithubDispatch(event");
    expect(gate).toBeGreaterThan(-1);
    const firstRoute = tailer.indexOf("processEvent(event)");
    expect(firstRoute).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(firstRoute);
  });

  test("⚠️ and before the route-timing block, so the two instruments agree", () => {
    // A suppressed event that still appeared in the slow-route histogram would make
    // the timing counter and the capture file disagree about what the broker did.
    expect(tailer.indexOf("decideGithubDispatch(event")).toBeLessThan(tailer.indexOf("BROKER_ROUTE_TIMING) {"));
  });

  test("a suppressed event is CAPTURED, never dropped", () => {
    const block = tailer.slice(tailer.indexOf("decideGithubDispatch(event"));
    const head = block.slice(0, block.indexOf("continue;"));
    expect(head).toContain("capture?.append(event, verdict)");
  });
});

describe("⛔ the gate is installed BEFORE the tail starts", () => {
  const index = read("index.mjs");

  test("initGithubFeedGate precedes startTailing", () => {
    const init = index.indexOf("initGithubFeedGate()");
    const start = index.indexOf("startTailing()");
    expect(init).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    expect(init).toBeLessThan(start);
  });
});
