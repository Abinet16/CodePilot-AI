import { createSign } from "node:crypto";

function base64url(json: object): string {
  return Buffer.from(JSON.stringify(json)).toString("base64url");
}

/**
 * Signs the short-lived RS256 JWT that authenticates as the GitHub App itself.
 * It is only ever exchanged for an installation token, never sent elsewhere.
 * GitHub caps the lifetime at 10 minutes; iat is backdated for clock drift.
 */
export function createAppJwt(appId: string, privateKeyPem: string, nowMs = Date.now()): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const exp = iat + 9 * 60;
  const signingInput = `${base64url({ alg: "RS256", typ: "JWT" })}.${base64url({ iat, exp, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem, "base64url");
  return `${signingInput}.${signature}`;
}
