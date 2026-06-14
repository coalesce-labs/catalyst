// daemon-account.test.ts — units for the CTL-1129 parseAccountEmail pure function.
// Tests the JSON→email parse logic without spawning `claude` — consistent with how
// liveAgents() is treated in the existing board-data tests.
import { describe, it, expect } from "bun:test";
import { parseAccountEmail } from "../lib/board-data.mjs";

describe("parseAccountEmail (CTL-1129)", () => {
  it("happy path — extracts email from a fully-logged-in payload", () => {
    expect(parseAccountEmail('{"loggedIn":true,"email":"ryan@rozich.com"}')).toBe("ryan@rozich.com");
  });

  it("logged out / no email — returns null", () => {
    expect(parseAccountEmail('{"loggedIn":false}')).toBeNull();
  });

  it("empty email string — returns null (empty degrades to null)", () => {
    expect(parseAccountEmail('{"email":""}')).toBeNull();
  });

  it("malformed JSON — returns null (never throws, fail-open)", () => {
    expect(parseAccountEmail("not json")).toBeNull();
  });

  it("empty string input — returns null", () => {
    expect(parseAccountEmail("")).toBeNull();
  });

  it("whitespace-only input — returns null", () => {
    expect(parseAccountEmail("   ")).toBeNull();
  });

  it("email is not a string (e.g. null) — returns null", () => {
    expect(parseAccountEmail('{"email":null}')).toBeNull();
  });
});
