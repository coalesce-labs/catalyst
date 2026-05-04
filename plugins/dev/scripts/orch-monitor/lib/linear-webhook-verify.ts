import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Linear webhook HMAC-SHA256 signature.
 *
 * Linear sends `Linear-Signature: <hex>` (no `sha256=` prefix, unlike GitHub's
 * `X-Hub-Signature-256`). The HMAC is computed over the raw request body bytes.
 */
export function verifyLinearSignature(
  secret: string,
  rawBody: Uint8Array,
  signatureHeader: string | null,
): boolean {
  if (signatureHeader === null || signatureHeader.length === 0) return false;
  if (secret.length === 0) return false;
  const expected = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
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
