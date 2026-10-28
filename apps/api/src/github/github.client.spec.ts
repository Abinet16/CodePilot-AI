import { nextLink } from "./github.client";
import { permissionFrom } from "./installation-sync.service";

describe("nextLink", () => {
  it("follows rel=next on the GitHub API", () => {
    const header =
      '<https://api.github.com/user/installations?page=2>; rel="next", <https://api.github.com/user/installations?page=5>; rel="last"';
    expect(nextLink(header)).toBe("https://api.github.com/user/installations?page=2");
  });

  it("stops when there is no next page", () => {
    expect(nextLink(null)).toBeNull();
    expect(nextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
  });

  it("refuses to follow a next link to another host, which would leak the bearer token", () => {
    expect(nextLink('<https://evil.example/steal>; rel="next"')).toBeNull();
    expect(nextLink('<https://api.github.com.evil.example/x>; rel="next"')).toBeNull();
  });
});

describe("permissionFrom", () => {
  it("maps GitHub permission flags to the highest level", () => {
    expect(permissionFrom({ admin: true, push: true, pull: true })).toBe("ADMIN");
    expect(permissionFrom({ admin: false, maintain: true, push: true, pull: true })).toBe("MAINTAIN");
    expect(permissionFrom({ admin: false, push: true, pull: true })).toBe("WRITE");
    expect(permissionFrom({ admin: false, push: false, triage: true, pull: true })).toBe("TRIAGE");
    expect(permissionFrom({ admin: false, push: false, pull: true })).toBe("READ");
  });

  it("grants nothing when GitHub reports no permissions", () => {
    expect(permissionFrom(undefined)).toBeNull();
    expect(permissionFrom({ admin: false, push: false, pull: false })).toBeNull();
  });
});
