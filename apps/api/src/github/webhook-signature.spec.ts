import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "./webhook-signature";

describe("verifyWebhookSignature", () => {
  const secret = "test-webhook-secret";
  const body = Buffer.from(JSON.stringify({ action: "opened", issue: { number: 1 } }));
  const sign = (payload: Buffer, key = secret) => `sha256=${createHmac("sha256", key).update(payload).digest("hex")}`;

  it("accepts a correct signature", () => {
    expect(verifyWebhookSignature(secret, body, sign(body))).toBe(true);
  });

  it("rejects a signature made with a different secret", () => {
    expect(verifyWebhookSignature(secret, body, sign(body, "other-secret"))).toBe(false);
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from(body.toString().replace('"number":1', '"number":2'));
    expect(verifyWebhookSignature(secret, tampered, sign(body))).toBe(false);
  });

  it.each([undefined, "", "sha1=abc", "sha256=", "sha256=deadbeef"])("rejects malformed header %j", (header) => {
    expect(verifyWebhookSignature(secret, body, header)).toBe(false);
  });
});
