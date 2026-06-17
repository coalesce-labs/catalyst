// board-pr-stuck.test.ts — CTL-1158: wiring guard for the PR-stuck attention
// signal. assembleBoard() reads WORKERS_DIR (a homedir const) and shells out to
// `claude agents`, so it is not directly integration-testable. We pin the wiring
// via STATIC SOURCE ANALYSIS — exactly the pattern used by board-row-durations,
// board-held-indicator, and board-phase-drift — plus type-contract checks.
//
// What is guarded:
//   1. assembleBoard() accepts getPrStatus
//   2. prStartedAt() helper is present
//   3. the ticket loop computes prStuck + prReason and passes them to deriveAttention
//   4. humanQuestion falls back to prReason
//   5. the ticket object carries mergeStateStatus + prStuckReason
//   6. board-data.d.mts wire contract declares the two new fields
//   7. ui/src/board/types.ts UI view declares the two new optional fields
//   8. PrMergeStateStatus type union is present in both type files

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");

const boardDataSrc = read("lib/board-data.mjs");
const boardDataDts = read("lib/board-data.d.mts");
const uiTypesSrc = read("ui/src/board/types.ts");
const serverSrc = read("server.ts");

describe("CTL-1158: assembleBoard wiring — PR-stuck attention signal", () => {
  test("assembleBoard accepts a getPrStatus option", () => {
    expect(boardDataSrc).toContain("getPrStatus = null");
  });

  test("prStartedAt helper extracts startedAt from phase-pr signals", () => {
    expect(boardDataSrc).toContain("function prStartedAt(prSigs)");
    expect(boardDataSrc).toContain("sig?.pr?.number && sig.startedAt");
  });

  test("ticket loop computes prStuck using isPrStuck + prStartedAt", () => {
    expect(boardDataSrc).toContain("isPrStuck(prStatus, prPhaseStartedAt, now)");
    expect(boardDataSrc).toContain("prStartedAt(prSigs)");
  });

  test("ticket loop computes prReason using prStuckReason", () => {
    expect(boardDataSrc).toContain("prStuckReason(prStatus?.mergeStateStatus, prNumber)");
  });

  test("deriveAttention receives prStuck + prStuckSince from the ticket loop", () => {
    expect(boardDataSrc).toContain("prStuck,");
    expect(boardDataSrc).toContain("prStuckSince: prPhaseStartedAt,");
  });

  test("humanQuestion falls back to prReason when no phase-signal CTA", () => {
    // CTL-1239: the scan array is now explSigs (canonical PHASE_ORDER signals +
    // ancillary remediate/recovery-pass), so recovery-pass CTAs surface. The
    // prReason fallback is unchanged.
    expect(boardDataSrc).toContain("deriveHumanQuestion(explSigs) ?? prReason");
  });

  test("ticket object carries mergeStateStatus from prStatus", () => {
    expect(boardDataSrc).toContain("mergeStateStatus: prStatus?.mergeStateStatus ?? null");
  });

  test("ticket object carries prStuckReason", () => {
    expect(boardDataSrc).toContain("prStuckReason: prReason,");
  });
});

describe("CTL-1158: type contracts — wire shape and UI view carry the new fields", () => {
  test("board-data.d.mts declares mergeStateStatus on BoardTicket", () => {
    expect(boardDataDts).toMatch(/mergeStateStatus\??:/);
  });

  test("board-data.d.mts declares prStuckReason on BoardTicket", () => {
    expect(boardDataDts).toMatch(/prStuckReason\??:/);
  });

  test("board-data.d.mts declares PrMergeStateStatus union", () => {
    expect(boardDataDts).toContain("PrMergeStateStatus");
  });

  test("ui/src/board/types.ts declares mergeStateStatus (optional) on BoardTicket", () => {
    expect(uiTypesSrc).toContain("mergeStateStatus?:");
  });

  test("ui/src/board/types.ts declares prStuckReason (optional) on BoardTicket", () => {
    expect(uiTypesSrc).toContain("prStuckReason?:");
  });

  test("ui/src/board/types.ts declares PrMergeStateStatus union", () => {
    expect(uiTypesSrc).toContain("PrMergeStateStatus");
  });
});

describe("CTL-1158: server.ts threads PrStatusFetcher into assembleBoard", () => {
  test("server.ts wires getPrStatus from prFetcher into the assemble closure", () => {
    expect(serverSrc).toContain("getPrStatus:");
  });
});
