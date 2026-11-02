import { codeSpan, neutralizeLine, neutralizeMarkdown } from "./markdown";

describe("neutralizeMarkdown", () => {
  it("escapes HTML so nothing renders or hides", () => {
    expect(neutralizeMarkdown('<img src=x onerror=alert(1)><!-- hidden --> & done')).toBe("&lt;img src=x onerror=alert(1)&gt;&lt;!-- hidden --&gt; &amp; done");
  });

  it("breaks mentions and team pings but keeps emails readable", () => {
    const out = neutralizeMarkdown("cc @octocat and @acme/security, mail dev@example.com");
    expect(out).not.toMatch(/(^|\s)@[a-z]/);
    expect(out).toContain("@‍octocat");
    expect(out).toContain("@‍acme/security");
    expect(out).toContain("dev@example.com");
  });

  it("disables images and links", () => {
    expect(neutralizeMarkdown("![pixel](https://evil.example/t.gif) [docs](https://evil.example) [ref][1]")).toBe(
      "!\\[pixel]\\(https://evil.example/t.gif) [docs]\\(https://evil.example) [ref]\\[1]",
    );
  });

  it("keeps ordinary prose, lists, and code spans", () => {
    const text = "Use `Math.ceil` so the last page counts.\n- covers 10 / 3";
    expect(neutralizeMarkdown(text)).toBe(text);
  });
});

describe("neutralizeLine and codeSpan", () => {
  it("makes a bounded single line that cannot break a table", () => {
    expect(neutralizeLine("a | b\nc", 100)).toBe("a \\| b c");
    expect(neutralizeLine("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("keeps code spans closed", () => {
    expect(codeSpan("a`b")).toBe("`a'b`");
  });
});
