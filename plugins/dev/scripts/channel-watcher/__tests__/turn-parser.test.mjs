import { test, expect } from "bun:test";
import { countTurns, latestTurn } from "../lib/turn-parser.mjs";

const TURN_HEADER =
  "### 1 | FROM: alice | TO: ALL | 2026-07-03T10:00:00Z | INFO — hello";
const TURN_HEADER_2 =
  "### 2 | FROM: bob | TO: alice | 2026-07-03T10:01:00Z | ACK — ok";

test("counts sequential turn headers, ignores prose lines", () => {
  const md = `prose\n${TURN_HEADER}\nbody\n${TURN_HEADER_2}\n`;
  expect(countTurns(md)).toBe(2);
  expect(latestTurn(md)).toBe(2);
});

test("counts a single turn header", () => {
  expect(countTurns(TURN_HEADER)).toBe(1);
  expect(latestTurn(TURN_HEADER)).toBe(1);
});

test("empty / headerless file → 0", () => {
  expect(countTurns("no turns here")).toBe(0);
  expect(latestTurn("")).toBe(0);
});

test("prose lines that contain ### but not the turn-header pattern are not counted", () => {
  const md = "### Heading\n### 1 | FROM: a | TO: b | t | INFO — msg\n";
  expect(countTurns(md)).toBe(1);
  expect(latestTurn(md)).toBe(1);
});
