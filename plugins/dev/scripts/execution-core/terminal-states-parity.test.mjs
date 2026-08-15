import { expect, test } from "bun:test";
import {
  TERMINAL_AGENT_STATES,
  TERMINAL_JOB_STATES as FROM_CLAUDE_AGENTS,
} from "./claude-agents.mjs";
import { TERMINAL_JOB_STATES as FROM_RECOVERY } from "./recovery.mjs";
import { TERMINAL_JOB_STATES as FROM_BOARD_DATA } from "../orch-monitor/lib/board-data.mjs";

const sorted = (states) => [...states].sort();

test("the three TERMINAL_JOB_STATES copies are identical", () => {
  expect(sorted(FROM_CLAUDE_AGENTS)).toEqual(sorted(FROM_RECOVERY));
  expect(sorted(FROM_CLAUDE_AGENTS)).toEqual(sorted(FROM_BOARD_DATA));
});

test("TERMINAL_JOB_STATES is the documented Tier-2 vocabulary", () => {
  expect(sorted(FROM_CLAUDE_AGENTS)).toEqual(["blocked", "done", "failed", "stopped"]);
});

test("TERMINAL_AGENT_STATES is a strict, deliberate subset", () => {
  expect(sorted(TERMINAL_AGENT_STATES)).toEqual(["blocked"]);
  for (const state of TERMINAL_AGENT_STATES) expect(FROM_CLAUDE_AGENTS.has(state)).toBe(true);
  expect(TERMINAL_AGENT_STATES.size).toBeLessThan(FROM_CLAUDE_AGENTS.size);
});
