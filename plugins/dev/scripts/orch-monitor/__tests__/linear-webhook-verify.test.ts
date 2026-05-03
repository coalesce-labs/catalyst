import { describe, it, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyLinearSignature } from "../lib/linear-webhook-verify";

function sign(secret: string, body: string | Uint8Array): string {
  // Linear format: hex digest only, no `sha256=` prefix.
  return createHmac("sha256", secret)
    .update(typeof body === "string" ? Buffer.from(body) : body)
    .digest("hex");
}

describe("verifyLinearSignature", () => {
  const secret = "s3cret";
  const body = Buffer.from(
    '{"action":"update","type":"Issue","data":{"identifier":"CTL-1"}}',
  );

  it("returns true for a valid signature", () => {
    expect(verifyLinearSignature(secret, body, sign(secret, body))).toBe(true);
  });

  it("returns false when secret does not match", () => {
    expect(verifyLinearSignature("wrong", body, sign(secret, body))).toBe(false);
  });

  it("returns false when signature header is null", () => {
    expect(verifyLinearSignature(secret, body, null)).toBe(false);
  });

  it("returns false when signature header is empty string", () => {
    expect(verifyLinearSignature(secret, body, "")).toBe(false);
  });

  it("returns false when secret is empty string", () => {
    expect(verifyLinearSignature("", body, sign("anything", body))).toBe(false);
  });

  it("returns false for length-mismatched header without throwing", () => {
    expect(verifyLinearSignature(secret, body, "abc123")).toBe(false);
  });

  it("returns false when body bytes change but signature does not", () => {
    const validSig = sign(secret, body);
    const tampered = Buffer.from(
      '{"action":"update","type":"Issue","data":{"identifier":"CTL-2"}}',
    );
    expect(verifyLinearSignature(secret, tampered, validSig)).toBe(false);
  });

  it("rejects GitHub-style sha256-prefixed signatures", () => {
    // Linear does NOT use the `sha256=` prefix — a header carrying it must
    // fail verification rather than silently succeed.
    const githubStyle = "sha256=" + sign(secret, body);
    expect(verifyLinearSignature(secret, body, githubStyle)).toBe(false);
  });
});
