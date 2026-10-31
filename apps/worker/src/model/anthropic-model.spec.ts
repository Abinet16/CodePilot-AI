import Anthropic from "@anthropic-ai/sdk";
import { TransientError } from "../pipeline";
import type { MessagesClient } from "./anthropic-model";
import { AnthropicModel } from "./anthropic-model";
import { ModelRefusalError } from "./structured-model";

function message(overrides: Partial<Anthropic.Beta.BetaMessage>): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: '{"kind":"rejected","plan":null,"reason":"vague"}', citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: null, cache_read_input_tokens: 50 },
    ...overrides,
  } as Anthropic.Beta.BetaMessage;
}

/** A stub client whose stream resolves or rejects the way `finalMessage` would. */
function modelWith(finalMessage: jest.Mock, stream = jest.fn().mockReturnValue({ finalMessage })) {
  return new AnthropicModel({ model: "claude-opus-5-5", effort: "high", client: { stream } as unknown as MessagesClient });
}

const request = { system: "sys", prompt: "plan this", schema: { type: "object" }, maxOutputTokens: 8_000, signal: new AbortController().signal };

describe("AnthropicModel", () => {
  it("streams a structured-output request with adaptive thinking and server-side fallback", async () => {
    const stream = jest.fn().mockReturnValue({ finalMessage: jest.fn().mockResolvedValue(message({})) });
    const response = await modelWith(jest.fn(), stream).generate(request);

    const [params, options] = stream.mock.calls[0];
    expect(params).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 8_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: { type: "object" } } },
      system: "sys",
      messages: [{ role: "user", content: "plan this" }],
    });
    expect(options.signal).toBe(request.signal);
    expect(response).toEqual({
      output: { kind: "rejected", plan: null, reason: "vague" },
      problem: null,
      model: "claude-opus-5-5",
      usage: { inputTokens: 1200, outputTokens: 300, cacheCreationInputTokens: 0, cacheReadInputTokens: 50 },
    });
  });

  it("reports the model that actually answered", async () => {
    const create = jest.fn().mockResolvedValue(message({ model: "claude-opus-5" }));
    expect((await modelWith(create).generate(request)).model).toBe("claude-opus-5");
  });

  it("turns truncated or non-JSON answers into feedback instead of throwing", async () => {
    const truncated = await modelWith(jest.fn().mockResolvedValue(message({ stop_reason: "max_tokens" }))).generate(request);
    expect(truncated).toMatchObject({ output: null, problem: expect.stringMatching(/cut off/) });

    const garbled = message({ content: [{ type: "text", text: "{not json", citations: null }] });
    expect(await modelWith(jest.fn().mockResolvedValue(garbled)).generate(request)).toMatchObject({ output: null, problem: "The answer was not valid JSON." });
  });

  it("raises a refusal with its billed usage", async () => {
    const refusal = message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } } as never);
    const err = await modelWith(jest.fn().mockResolvedValue(refusal)).generate(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRefusalError);
    expect(err).toMatchObject({ category: "cyber", usage: { inputTokens: 1200 } });
  });

  it("classifies rate limits, outages, and dropped connections as transient", async () => {
    const headers = new Headers();
    for (const error of [
      new Anthropic.RateLimitError(429, undefined, "slow down", headers),
      new Anthropic.InternalServerError(529, undefined, "overloaded", headers),
      new Anthropic.APIConnectionError({ message: "socket hang up" }),
    ]) {
      await expect(modelWith(jest.fn().mockRejectedValue(error)).generate(request)).rejects.toBeInstanceOf(TransientError);
    }
  });

  it("fails permanently on credential and request errors", async () => {
    const headers = new Headers();
    const auth = await modelWith(jest.fn().mockRejectedValue(new Anthropic.AuthenticationError(401, undefined, "bad key", headers)))
      .generate(request)
      .catch((e: unknown) => e);
    expect(auth).not.toBeInstanceOf(TransientError);
    expect((auth as Error).message).toMatch(/API key/);

    const bad = await modelWith(jest.fn().mockRejectedValue(new Anthropic.BadRequestError(400, undefined, "bad", headers)))
      .generate(request)
      .catch((e: unknown) => e);
    expect((bad as Error).message).toBe("The model provider rejected the request (HTTP 400)");
  });

  it("passes an abort through untouched so the pipeline sees the cancellation", async () => {
    const abort = new Anthropic.APIUserAbortError();
    await expect(modelWith(jest.fn().mockRejectedValue(abort)).generate(request)).rejects.toBe(abort);
  });
});
