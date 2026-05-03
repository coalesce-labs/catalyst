import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a GitHub webhook HMAC-SHA256 signature.
 *
 * Compares the provided X-Hub-Signature-256 header against an HMAC computed
 * from the raw body bytes (NOT a re-serialized JSON object — whitespace and
 * key-order differences would break the comparison).
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Uint8Array,
  signatureHeader: string | null,
): boolean {
  if (signatureHeader === null || signatureHeader.length === 0) return false;
  if (secret.length === 0) return false;
  const expected =
    "sha256=" +
    createHmac("sha256", secret).update(rawBody).digest("hex");
  if (expected.length !== signatureHeader.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signatureHeader),
    );
  } catch {
    return false;
  }
}
