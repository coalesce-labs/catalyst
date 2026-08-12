import { describe, expect, test } from "bun:test";
import { decideDoneWrite, MERGED_WORK_VERDICTS } from "./merged-work-evidence.mjs";

describe("CAT-45 Done decisions", () => {
  test("exports the closed verdict vocabulary", () => {
    expect(MERGED_WORK_VERDICTS).toContain("unmerged");
    expect(MERGED_WORK_VERDICTS).toContain("unverifiable-infrastructure");
  });
  test("enforce refuses positive unmerged evidence", () => {
    expect(decideDoneWrite({ evidence: { ok: false, reason: "unmerged" }, mode: "enforce" }).decision).toBe("refuse");
  });
  test("shadow records but allows", () => {
    expect(decideDoneWrite({ evidence: { ok: false, reason: "unmerged" }, mode: "shadow" }).decision).toBe("would-refuse");
  });
  test("verified proof and reasoned override are distinct", () => {
    expect(decideDoneWrite({ evidence: { ok: false }, verified: "123" }).decision).toBe("verified");
    expect(decideDoneWrite({ evidence: { ok: false }, override: "docs-only closure" }).decision).toBe("override");
  });
});
