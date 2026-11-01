import { summarizeOutput } from "./output";

describe("summarizeOutput", () => {
  it("strips colors, cursor control, and carriage returns", () => {
    const raw = "\u001b[31mFAIL\u001b[39m src/a.test.ts\r\n\u001b]0;title\u0007progress\rdone\u0000";
    expect(summarizeOutput(raw, 1_000)).toEqual({ text: "FAIL src/a.test.ts\nprogress\ndone", truncated: false });
  });

  it("masks secrets a test printed", () => {
    expect(summarizeOutput(`token=ghs_${"x".repeat(36)}`, 1_000).text).toBe("token=[redacted]");
  });

  it("keeps the start and, mostly, the end of long output", () => {
    const raw = `START\n${"x".repeat(10_000)}\nexpected 2, received 1`;
    const { text, truncated } = summarizeOutput(raw, 400);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(400);
    expect(text.startsWith("START")).toBe(true);
    expect(text.endsWith("expected 2, received 1")).toBe(true);
    expect(text).toMatch(/characters omitted/);
  });
});
