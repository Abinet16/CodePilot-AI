import { buildRetrievalQuery, searchTextFor, splitIdentifier, toTsQuery } from "./search-terms";

describe("splitIdentifier", () => {
  it.each([
    ["getUserById", ["get", "user", "by", "id"]],
    ["get_user_by_id", ["get", "user", "by", "id"]],
    ["HTTPServer", ["http", "server"]],
    ["parseJSON2", ["parse", "json2"]],
    ["kebab-case-name", ["kebab", "case", "name"]],
  ])("splits %s", (input, parts) => {
    expect(splitIdentifier(input)).toEqual(parts);
  });
});

describe("searchTextFor", () => {
  it("indexes whole identifiers, their parts, and the path", () => {
    const text = searchTextFor("export function getUserById(id) { return null; }", "src/users/user-repo.ts");
    expect(text.split(" ")).toEqual(expect.arrayContaining(["users", "userrepo", "repo", "getuserbyid", "get", "user", "id"]));
    expect(text).not.toMatch(/\b(export|function|return)\b/);
  });

  it("only ever emits [a-z0-9] terms", () => {
    expect(searchTextFor("$weird = a'b; DROP TABLE x;--", "a.ts")).toMatch(/^[a-z0-9 ]*$/);
  });
});

describe("buildRetrievalQuery", () => {
  it("extracts paths, identifiers, and terms from an issue", () => {
    const q = buildRetrievalQuery(
      "Login fails in `src/auth/session.service.ts`\n\nCalling `resolveSession` with an expired token throws in SessionGuard. See ./apps/api/main.ts and https://example.com/a/b.",
    );
    expect(q.paths).toEqual(expect.arrayContaining(["src/auth/session.service.ts", "apps/api/main.ts"]));
    expect(q.paths.some((p) => p.includes("example.com"))).toBe(false);
    expect(q.identifiers).toEqual(expect.arrayContaining(["resolveSession", "SessionGuard"]));
    expect(q.terms).toEqual(expect.arrayContaining(["resolvesession", "session", "guard", "expired", "token", "login"]));
    expect(q.terms).not.toContain("the");
  });

  it("drops traversal and absolute paths", () => {
    const q = buildRetrievalQuery("read ../../etc/passwd and /etc/shadow");
    expect(q.paths.every((p) => !p.includes("..") && !p.startsWith("/"))).toBe(true);
  });
});

describe("toTsQuery", () => {
  it("joins safe terms with OR and drops anything else", () => {
    expect(toTsQuery(["user", "session", "a&b", "x:*"])).toBe("user | session");
    expect(toTsQuery([])).toBeNull();
  });
});
