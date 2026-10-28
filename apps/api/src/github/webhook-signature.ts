import { createHmac } from "node:crypto";
import { safeEqual } from "../common/crypto";

/**
 * Verifies GitHub's X-Hub-Signature-256 header against the exact raw request
 * bytes. Re-serialized JSON would not match, so the raw body is required.
 */
export function verifyWebhookSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return safeEqual(expected, signatureHeader);
}
