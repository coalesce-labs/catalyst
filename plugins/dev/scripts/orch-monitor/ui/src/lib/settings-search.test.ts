import { describe, expect, it } from "bun:test";
import { validateSettingsSearch } from "./settings-search";

describe("validateSettingsSearch", () => {
  it("keeps a valid non-empty string project key", () => {
    expect(validateSettingsSearch({ project: "CTL" })).toEqual({ project: "CTL" });
  });
  it("drops an empty string project (clean URL)", () => {
    expect(validateSettingsSearch({ project: "" })).toEqual({});
  });
  it("drops a numeric project value", () => {
    expect(validateSettingsSearch({ project: 5 })).toEqual({});
  });
  it("handles null gracefully", () => {
    expect(validateSettingsSearch(null)).toEqual({});
  });
  it("handles undefined gracefully", () => {
    expect(validateSettingsSearch(undefined)).toEqual({});
  });
  it("handles a bare object with no project key", () => {
    expect(validateSettingsSearch({})).toEqual({});
  });
  it("passes through upper-case team key unchanged", () => {
    expect(validateSettingsSearch({ project: "ADV" })).toEqual({ project: "ADV" });
  });
  it("ignores extra unknown search params", () => {
    expect(validateSettingsSearch({ project: "CTL", scope: "catalyst" })).toEqual({ project: "CTL" });
  });
});
