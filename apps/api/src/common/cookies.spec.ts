import { parseCookies } from "./cookies";

describe("parseCookies", () => {
  it("parses and decodes cookies", () => {
    expect(parseCookies("a=1; cp_session=abc%3D; theme=dark")).toEqual({ a: "1", cp_session: "abc=", theme: "dark" });
  });

  it("keeps the first occurrence so a later injected duplicate cannot override it", () => {
    expect(parseCookies("cp_session=real; cp_session=injected")).toEqual({ cp_session: "real" });
  });

  it("ignores malformed parts", () => {
    expect(parseCookies("novalue; =x; bad=%E0%A4%A; ok=1")).toEqual({ ok: "1" });
    expect(parseCookies(undefined)).toEqual({});
  });
});
