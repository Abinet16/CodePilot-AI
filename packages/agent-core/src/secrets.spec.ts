import { maskSecrets } from "./secrets";

describe("maskSecrets", () => {
  it.each([
    "ghs_" + "a".repeat(36),
    "github_pat_" + "B".repeat(40),
    "sk-ant-api03-" + "c".repeat(40),
    "npm_" + "d".repeat(36),
    "AKIA" + "E".repeat(16),
    "xoxb-123456789012-abc",
    "Authorization: Bearer " + "f".repeat(32),
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
  ])("masks %s", (secret) => {
    expect(maskSecrets(`before ${secret} after`)).not.toContain(secret.slice(-10));
    expect(maskSecrets(`before ${secret} after`)).toContain("[redacted]");
  });

  it("leaves ordinary text alone", () => {
    const text = "PASS src/pagination.test.ts (3 tests) Basic usage works";
    expect(maskSecrets(text)).toBe(text);
  });
});
