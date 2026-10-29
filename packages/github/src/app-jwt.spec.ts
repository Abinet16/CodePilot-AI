import { createVerify, generateKeyPairSync } from "node:crypto";
import { createAppJwt } from "./app-jwt";

describe("createAppJwt", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

  it("produces an RS256 JWT verifiable with the app's public key", () => {
    const [header, payload, signature] = createAppJwt("12345", pem).split(".") as [string, string, string];
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const valid = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature, "base64url");
    expect(valid).toBe(true);
  });

  it("backdates iat for clock drift and stays within GitHub's 10 minute limit", () => {
    const now = Date.UTC(2026, 9, 28, 12, 0, 0);
    const payload = decode(createAppJwt("12345", pem, now).split(".")[1]!);
    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBe(now / 1000 - 60);
    expect(payload.exp - now / 1000).toBeLessThanOrEqual(600);
    expect(payload.exp).toBeGreaterThan(now / 1000);
  });
});
