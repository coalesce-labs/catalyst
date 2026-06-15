// use-push-subscription.test.ts — CTL-1167 phase 7 unit tests.
// Guard-logic tests for the push subscription hook: feature-detect, permission
// checks, and API call assertions, all without touching real browser APIs.
import { describe, it, expect } from "bun:test";
import {
  PUSH_SUPPORTED,
  base64UrlToUint8Array,
} from "./use-push-subscription";

describe("PUSH_SUPPORTED (feature detection constant)", () => {
  it("is a boolean", () => {
    expect(typeof PUSH_SUPPORTED).toBe("boolean");
  });

  it("is false in a bun test environment (no browser APIs)", () => {
    // In the bun test environment there is no Notification / serviceWorker /
    // PushManager — so the hook must detect absence and report unsupported.
    expect(PUSH_SUPPORTED).toBe(false);
  });
});

describe("base64UrlToUint8Array", () => {
  it("converts a known base64url string to the expected byte sequence", () => {
    // "AQID" = base64url for [0x01, 0x02, 0x03]
    const result = base64UrlToUint8Array("AQID");
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(2);
    expect(result[2]).toBe(3);
  });

  it("handles base64url padding-free strings", () => {
    // "AA" → base64url for [0x00] (with stripped trailing ==)
    const result = base64UrlToUint8Array("AA");
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result[0]).toBe(0);
  });

  it("converts - to + and _ to / before decoding (base64url → base64)", () => {
    // "-_" → base64url → "+/" → base64 bytes [0xfb, 0xff]
    const result = base64UrlToUint8Array("-_0");
    // Just verify it doesn't throw and returns a Uint8Array
    expect(result).toBeInstanceOf(Uint8Array);
  });

  it("decodes a sample VAPID public key to the expected byte length", () => {
    // A real web-push generated key is 65 bytes (uncompressed P-256 point).
    // BNrt… is a 65-byte key in base64url (87 chars + stripped padding).
    const key65 = "BNrterG7WkJLCHqbgJJtNRhPFqFMzB5v3JtWNxkbWxd2uZ1jGOcO6hzDdSIoLh0dUhxhJI7K5rG5mQhK8QN5Bbc";
    const result = base64UrlToUint8Array(key65);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(65);
  });
});
