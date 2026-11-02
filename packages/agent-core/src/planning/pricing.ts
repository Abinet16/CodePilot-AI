/**
 * List prices in US dollars per million tokens for the hosted providers.
 * Update alongside model changes; an unpriced hosted model is refused at
 * startup so usage is never recorded at zero cost by accident. Local models
 * (Ollama) cost nothing and are not listed.
 */
export const MODEL_PRICING: Readonly<Record<string, { input: number; output: number }>> = {
  // Anthropic first-party API.
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  // Gemini API paid-tier standard text prices, as published on 2026-11-02. The free tier is not billed,
  // so for free-tier keys these figures show what the same work would cost on the paid tier.
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
};

/** Cache writes (5-minute TTL) and reads are billed relative to the input price. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export function isPricedModel(model: string): boolean {
  return Object.hasOwn(MODEL_PRICING, model);
}

/** Estimated cost in US dollars, rounded to the micro-dollar the database stores. */
export function estimateCostUsd(model: string, usage: TokenUsage): number {
  const price = MODEL_PRICING[model];
  if (!price) throw new Error(`No price is configured for model ${model}`);
  const inputEquivalent =
    usage.inputTokens + usage.cacheCreationInputTokens * CACHE_WRITE_MULTIPLIER + usage.cacheReadInputTokens * CACHE_READ_MULTIPLIER;
  const dollars = (inputEquivalent * price.input + usage.outputTokens * price.output) / 1_000_000;
  return Math.round(dollars * 1_000_000) / 1_000_000;
}

/** Tokens counted against a task's budget: everything sent or generated, cached or not. */
export function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens + usage.outputTokens;
}
