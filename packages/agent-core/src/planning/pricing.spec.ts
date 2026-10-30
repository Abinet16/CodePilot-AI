import { estimateCostUsd, isPricedModel, totalTokens } from "./pricing";

const usage = { inputTokens: 10_000, outputTokens: 2_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

describe("estimateCostUsd", () => {
  it("prices input and output at the model's list price", () => {
    // 10k * $4/M + 2k * $20/M
    expect(estimateCostUsd("claude-opus-5-5", usage)).toBe(0.08);
  });

  it("bills cache writes at 1.25x and cache reads at 0.1x of input", () => {
    const cached = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 };
    expect(estimateCostUsd("claude-sonnet-5-5", cached)).toBe(2.7);
  });

  it("rounds to micro-dollars", () => {
    expect(estimateCostUsd("claude-haiku-5-5", { ...usage, inputTokens: 1, outputTokens: 1 })).toBe(0.000001);
  });

  it("refuses to price an unknown model", () => {
    expect(isPricedModel("claude-opus-5-5")).toBe(true);
    expect(isPricedModel("toString")).toBe(false);
    expect(() => estimateCostUsd("gpt-x", usage)).toThrow(/No price/);
  });
});

describe("totalTokens", () => {
  it("counts cached input against the budget too", () => {
    expect(totalTokens({ inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 })).toBe(10);
  });
});
