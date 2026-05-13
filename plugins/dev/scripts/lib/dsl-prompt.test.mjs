// dsl-prompt.test.mjs — system prompt schema + builder tests for CTL-365.
// Run: bun test plugins/dev/scripts/lib/dsl-prompt.test.mjs

import { describe, test, expect } from "bun:test";

import {
  SYSTEM_PROMPT,
  FEW_SHOT_EXAMPLES,
  buildSystemPrompt,
} from "./dsl-prompt.mjs";

describe("SYSTEM_PROMPT schema reflects live emitters (CTL-365)", () => {
  test("service.name enum lists catalyst.broker", () => {
    expect(SYSTEM_PROMPT).toContain("catalyst.broker");
  });

  test("service.name enum lists catalyst.orchestrator", () => {
    expect(SYSTEM_PROMPT).toContain("catalyst.orchestrator");
  });

  test("service.name enum does NOT list catalyst.filter (dead service name)", () => {
    // catalyst.filter has no live emitter; filter.* events come from catalyst.broker.
    expect(SYSTEM_PROMPT).not.toMatch(/catalyst\.filter\b/);
  });

  test("rule 5 worked examples include {NOW-24h}", () => {
    expect(SYSTEM_PROMPT).toContain("{NOW-24h}");
  });
});

describe("FEW_SHOT_EXAMPLES covers post-CTL-313 event names (CTL-365)", () => {
  const block = JSON.stringify(FEW_SHOT_EXAMPLES);

  test("includes a filter.wake example", () => {
    expect(block).toContain("filter.wake");
  });

  test("includes a broker.daemon example", () => {
    expect(block).toContain("broker.daemon");
  });

  test("includes a session.phase or session.* example", () => {
    expect(block).toMatch(/session\.(phase|started|ended|iteration)/);
  });

  test("includes an orchestrator.worker.* example", () => {
    expect(block).toMatch(/orchestrator\.worker\./);
  });

  test("includes an orchestrator.attention.* example", () => {
    expect(block).toMatch(/orchestrator\.attention\./);
  });

  test("includes a github.deployment.* or deployment_status example", () => {
    expect(block).toMatch(/github\.deployment(_status)?\./);
  });

  test("includes a linear.cycle.* or linear.issue_label.* example", () => {
    expect(block).toMatch(/linear\.(cycle|issue_label|reaction)\./);
  });

  test("includes a {NOW-24h} worked example", () => {
    expect(block).toContain("{NOW-24h}");
  });
});

describe("buildSystemPrompt() injects current time (CTL-365)", () => {
  test("returns the static SYSTEM_PROMPT prefix verbatim", () => {
    const out = buildSystemPrompt({ now: new Date("2026-05-13T15:30:00.000Z") });
    // The schema block (cache-friendly prefix) must be present unchanged.
    expect(out.startsWith(SYSTEM_PROMPT)).toBe(true);
  });

  test("appends a 'Current time:' line with an ISO 8601 timestamp", () => {
    const fixed = new Date("2026-05-13T15:30:00.000Z");
    const out = buildSystemPrompt({ now: fixed });
    expect(out).toContain("Current time:");
    expect(out).toContain("2026-05-13T15:30:00.000Z");
  });

  test("defaults to new Date() when now is omitted", () => {
    const before = Date.now();
    const out = buildSystemPrompt();
    const after = Date.now();
    // Extract the ISO timestamp from the "Current time:" line.
    const match = out.match(/Current time:\s*(\S+)/);
    expect(match).not.toBeNull();
    const ts = new Date(match[1]).getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });

  test("the static SYSTEM_PROMPT does NOT contain a current-time line (cache-friendly)", () => {
    expect(SYSTEM_PROMPT).not.toContain("Current time:");
  });

  test("buildSystemPrompt output is distinct from SYSTEM_PROMPT", () => {
    const out = buildSystemPrompt({ now: new Date("2026-05-13T15:30:00.000Z") });
    expect(out).not.toBe(SYSTEM_PROMPT);
    expect(out.length).toBeGreaterThan(SYSTEM_PROMPT.length);
  });
});
