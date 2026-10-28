import { decodeOAuthState, encodeOAuthState, sanitizeReturnTo } from "./oauth-state";

describe("sanitizeReturnTo", () => {
  it.each(["/", "/repositories", "/tasks/123?tab=diff#files"])("keeps same-origin path %s", (path) => {
    expect(sanitizeReturnTo(path)).toBe(path);
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/\tevil",
    "repositories",
    "",
    undefined,
    ["/"],
    `/${"a".repeat(600)}`,
  ])("falls back to / for unsafe value %j", (value) => {
    expect(sanitizeReturnTo(value)).toBe("/");
  });
});

describe("OAuth state cookie", () => {
  it("round-trips state and return path", () => {
    expect(decodeOAuthState(encodeOAuthState({ state: "abc", returnTo: "/repositories" }))).toEqual({
      state: "abc",
      returnTo: "/repositories",
    });
  });

  it("re-sanitizes the return path when decoding a tampered cookie", () => {
    const forged = Buffer.from(JSON.stringify({ state: "abc", returnTo: "//evil.example" })).toString("base64url");
    expect(decodeOAuthState(forged)?.returnTo).toBe("/");
  });

  it.each([undefined, "", "not-base64-json", Buffer.from('{"state":1}').toString("base64url")])(
    "rejects invalid cookie %j",
    (cookie) => {
      expect(decodeOAuthState(cookie)).toBeNull();
    },
  );
});
