import { describe, it, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../lib/webhook-verify";

function sign(secret: string, body: string | Uint8Array): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(typeof body === "string" ? Buffer.from(body) : body)
      .digest("hex")
  );
}

describe("verifyWebhookSignature", () => {
  const secret = "s3cret";
  const body = Buffer.from('{"action":"closed","number":42}');

  it("returns true for a valid signature", () => {
    expect(verifyWebhookSignature(secret, body, sign(secret, body))).toBe(true);
  });

  it("returns false when secret does not match", () => {
    expect(verifyWebhookSignature("wrong", body, sign(secret, body))).toBe(false);
  });

  it("returns false when signature header is null", () => {
    expect(verifyWebhookSignature(secret, body, null)).toBe(false);
  });

  it("returns false when signature header is empty string", () => {
    expect(verifyWebhookSignature(secret, body, "")).toBe(false);
  });

  it("returns false when secret is empty string", () => {
    expect(verifyWebhookSignature("", body, sign("anything", body))).toBe(false);
  });

  it("returns false for length-mismatched header without throwing", () => {
    expect(verifyWebhookSignature(secret, body, "sha256=short")).toBe(false);
  });

  it("returns true for empty body with matching signature", () => {
    const empty = new Uint8Array(0);
    expect(verifyWebhookSignature(secret, empty, sign(secret, empty))).toBe(true);
  });

  it("returns false when body bytes change but signature does not", () => {
    const validSig = sign(secret, body);
    const tampered = Buffer.from('{"action":"closed","number":99}');
    expect(verifyWebhookSignature(secret, tampered, validSig)).toBe(false);
  });
});
