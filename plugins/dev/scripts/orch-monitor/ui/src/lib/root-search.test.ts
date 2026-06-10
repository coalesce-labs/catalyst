// root-search.test.ts — units for the CTL-989 typed ROOT search contract
// (?scope). Pure logic, no DOM:  cd ui && bun test src/lib/root-search.test.ts
import { describe, it, expect } from "bun:test";
import { validateRootSearch } from "./root-search";

describe("validateRootSearch", () => {
  it("keeps a non-empty repo scope", () => {
    expect(validateRootSearch({ scope: "catalyst" })).toEqual({
      scope: "catalyst",
    });
  });

  it("drops the implicit 'all' sentinel (kept off the URL for the common case)", () => {
    expect(validateRootSearch({ scope: "all" })).toEqual({});
  });

  it("drops an empty / missing scope", () => {
    expect(validateRootSearch({ scope: "" })).toEqual({});
    expect(validateRootSearch({})).toEqual({});
  });

  it("is total + non-throwing on garbage input (never crashes the resolver)", () => {
    expect(validateRootSearch(null)).toEqual({});
    expect(validateRootSearch(undefined)).toEqual({});
    expect(validateRootSearch("nonsense")).toEqual({});
    expect(validateRootSearch(42)).toEqual({});
    expect(validateRootSearch({ scope: 99 })).toEqual({});
  });

  it("ignores unrelated extra params", () => {
    expect(validateRootSearch({ scope: "adva", from: "board", junk: 1 })).toEqual(
      { scope: "adva" },
    );
  });
});
