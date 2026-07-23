import { describe, test, expect } from "bun:test";
import { isTicketKey } from "./ticket-key.mjs";

describe("isTicketKey", () => {
  test("accepts canonical ticket keys", () => {
    for (const k of ["CTL-1504", "CTC-70", "ABCD-9999", "A-1"]) {
      expect(isTicketKey(k)).toBe(true);
    }
  });
  test("rejects debris / non-ticket dir names", () => {
    for (const k of [".catalyst", ".DS_Store", "tmp", "workers", "CTL-", "-1", "123", "ctl-1", "CTL-12a", "CTL_1", "CTL-1 "]) {
      expect(isTicketKey(k)).toBe(false);
    }
  });
  test("is null/undefined/empty safe (never throws)", () => {
    expect(isTicketKey(null)).toBe(false);
    expect(isTicketKey(undefined)).toBe(false);
    expect(isTicketKey("")).toBe(false);
  });
});
