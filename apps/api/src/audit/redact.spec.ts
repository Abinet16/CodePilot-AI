import { redact } from "./redact";

describe("redact", () => {
  it("removes values under sensitive keys at any depth", () => {
    expect(
      redact({
        userToken: "abc",
        nested: { client_secret: "x", Authorization: "Bearer y", code: "oauth-code", privateKey: "pem" },
        githubLogin: "octocat",
      }),
    ).toEqual({
      userToken: "[redacted]",
      nested: { client_secret: "[redacted]", Authorization: "[redacted]", code: "[redacted]", privateKey: "[redacted]" },
      githubLogin: "octocat",
    });
  });

  it("masks token-shaped strings under innocent keys", () => {
    const leaked = `failed with ghs_${"a".repeat(36)} and github_pat_${"b".repeat(40)}`;
    expect(redact({ message: leaked })).toEqual({ message: "failed with [redacted] and [redacted]" });
  });

  it("converts bigint and Date so the result is JSON-serializable", () => {
    const out = redact({ installationId: 123n, at: new Date("2026-10-28T00:00:00Z") });
    expect(out).toEqual({ installationId: "123", at: "2026-10-28T00:00:00.000Z" });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("bounds oversized strings and arrays", () => {
    const out = redact({ log: "x".repeat(5_000), items: Array.from({ length: 500 }, (_, i) => i) }) as {
      log: string;
      items: number[];
    };
    expect(out.log.length).toBeLessThan(2_100);
    expect(out.items).toHaveLength(100);
  });
});
