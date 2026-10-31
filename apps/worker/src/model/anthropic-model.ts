import Anthropic from "@anthropic-ai/sdk";
import { TransientError } from "../pipeline";
import type { StructuredModel, ModelRequest, ModelResponse } from "./structured-model";
import { ModelRefusalError } from "./structured-model";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The subset of the SDK client this adapter uses, so tests can pass a stub. */
export type MessagesClient = Pick<Anthropic["beta"]["messages"], "stream">;

export interface AnthropicModelOptions {
  model: string;
  effort: Effort;
  client: MessagesClient;
}

/**
 * Structured answers from the Claude Messages API: the answer is JSON in the
 * schema the stage passes. Server-side fallback is enabled: if
 * the requested model declines on policy grounds, the API re-runs the request
 * on a fallback model in the same call, and `response.model` names it.
 */
export class AnthropicModel implements StructuredModel {
  readonly model: string;

  constructor(private readonly options: AnthropicModelOptions) {
    this.model = options.model;
  }

  static fromApiKey(apiKey: string, model: string, effort: Effort, timeoutMs: number): AnthropicModel {
    // The SDK retries 408/409/429/5xx and connection errors twice on its own before we see them.
    const client = new Anthropic({ apiKey, maxRetries: 2, timeout: timeoutMs });
    return new AnthropicModel({ model, effort, client: client.beta.messages });
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      // Streamed so long answers (a patch can run to tens of thousands of tokens) never hit a request timeout.
      const stream = this.options.client.stream(
        {
          model: this.options.model,
          max_tokens: request.maxOutputTokens,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: this.options.effort, format: { type: "json_schema", schema: request.schema } },
          system: request.system,
          messages: [{ role: "user", content: request.prompt }],
        },
        { signal: request.signal },
      );
      response = await stream.finalMessage();
    } catch (err) {
      throw classify(err);
    }

    const usage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
    };
    const base = { model: response.model, usage };

    if (response.stop_reason === "refusal") {
      throw new ModelRefusalError(response.stop_details?.category ?? null, response.model, usage);
    }
    if (response.stop_reason === "max_tokens") {
      return { ...base, output: null, problem: "The answer was cut off at the output token limit; produce a shorter answer." };
    }

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      return { ...base, output: JSON.parse(text), problem: null };
    } catch {
      return { ...base, output: null, problem: "The answer was not valid JSON." };
    }
  }
}

/** Maps SDK errors to the pipeline's retry policy. Typed classes only, never message matching. */
function classify(err: unknown): unknown {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.RateLimitError) return new TransientError("The model provider rate-limited the request", { cause: err });
  if (err instanceof Anthropic.InternalServerError) {
    return new TransientError(`The model provider is unavailable (HTTP ${err.status})`, { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) return new TransientError("Could not reach the model provider", { cause: err });
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new Error("The model provider rejected the worker's API key");
  }
  if (err instanceof Anthropic.APIError) return new Error(`The model provider rejected the request (HTTP ${err.status ?? "?"})`);
  return err;
}
