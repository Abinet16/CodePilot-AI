import { formatDuration, formatTokens, formatUsd, humanize, relativeTime, shortSha } from "./format";

describe("formatDuration", () => {
  it.each([
    [450, "450ms"],
    [12_400, "12s"],
    [72_000, "1m 12s"],
    [120_000, "2m"],
    [3_960_000, "1h 6m"],
    [-1, "–"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  it.each([
    ["2026-11-03T11:59:30Z", "just now"],
    ["2026-11-03T11:57:00Z", "3 minutes ago"],
    ["2026-11-03T09:00:00Z", "3 hours ago"],
    ["2026-11-02T12:00:00Z", "yesterday"],
    ["not a date", "–"],
  ])("%s is %s", (iso, text) => {
    expect(relativeTime(iso, now)).toBe(text);
  });
});

describe("formatTokens and formatUsd", () => {
  it("abbreviates large token counts", () => {
    expect([950, 1_000, 1_250, 12_345, 2_500_000, 3_000_000].map(formatTokens)).toEqual(["950", "1k", "1.3k", "12k", "2.5M", "3M"]);
  });

  it("keeps small costs readable", () => {
    expect([0, 0.0032, 0.25, 12.5].map(formatUsd)).toEqual(["$0", "$0.0032", "$0.25", "$12.50"]);
  });
});

describe("shortSha and humanize", () => {
  it("shortens SHAs and status names", () => {
    expect(shortSha("a".repeat(40))).toBe("a".repeat(12));
    expect(shortSha(null)).toBe("–");
    expect(humanize("AWAITING_PLAN_APPROVAL")).toBe("awaiting plan approval");
  });
});
