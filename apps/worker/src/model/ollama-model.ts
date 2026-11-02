import { TransientError } from "../pipeline";
import type { ModelRequest, ModelResponse, StructuredModel } from "./structured-model";

export interface OllamaModelOptions {
  model: string;
  /** For example http://localhost:11434. */
  baseUrl: string;
  /**
   * The context window to load the model with. Ollama's default is far smaller
   * than CodePilot's prompts and it truncates silently, so this is always set.
   */
  contextTokens: number;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

interface OllamaChatResponse {
  model?: string;
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Structured answers from a local model served by Ollama (`/api/chat` with a
 * JSON schema in `format`). Nothing leaves the machine and nothing is billed.
 * The schema is also repeated in the prompt, as Ollama recommends, which
 * helps smaller models follow it.
 */
export class OllamaModel implements StructuredModel {
  readonly model: string;
  private readonly fetchFn: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: OllamaModelOptions) {
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const { contextTokens } = this.options;
    // The answer has to fit in the same window as the prompt.
    const maxOutput = Math.min(request.maxOutputTokens, Math.floor(contextTokens / 2));
    const body = {
      model: this.model,
      stream: false,
      format: request.schema,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: `${request.prompt}\n\nAnswer with JSON that matches this schema:\n${JSON.stringify(request.schema)}` },
      ],
      options: { num_ctx: contextTokens, num_predict: maxOutput, temperature: 0 },
    };

    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([request.signal, timeout]),
      });
    } catch (err) {
      if (request.signal.aborted) throw err;
      if (timeout.aborted) {
        throw new Error(`Ollama did not answer within ${Math.round(this.options.timeoutMs / 1000)}s; try a smaller model or raise MODEL_TIMEOUT_SECONDS`);
      }
      throw new TransientError(`Could not reach Ollama at ${this.baseUrl}; is it running (ollama serve)?`, { cause: err });
    }
    if (!res.ok) throw await this.classify(res);

    const data = (await res.json()) as OllamaChatResponse;
    const promptTokens = data.prompt_eval_count ?? 0;
    const usage = { inputTokens: promptTokens, outputTokens: data.eval_count ?? 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    const base = { model: data.model ?? this.model, usage };

    // A prompt that filled the window was cut off by Ollama; the model never saw all of it.
    if (promptTokens + maxOutput > contextTokens) {
      throw new Error(
        `The prompt (${promptTokens.toLocaleString("en-US")} tokens) does not fit OLLAMA_CONTEXT_TOKENS (${contextTokens.toLocaleString("en-US")}) with room to answer; raise it if the model and your memory allow`,
      );
    }
    if (data.done_reason === "length") {
      return { ...base, output: null, problem: "The answer was cut off at the output token limit; produce a shorter answer." };
    }
    try {
      return { ...base, output: JSON.parse(data.message?.content ?? ""), problem: null };
    } catch {
      return { ...base, output: null, problem: "The answer was not valid JSON." };
    }
  }

  private async classify(res: Response): Promise<Error> {
    // Ollama runs locally; its error text is safe to show and usually says exactly what is wrong.
    const detail = await res
      .json()
      .then((b) => String((b as { error?: unknown }).error ?? "").slice(0, 300))
      .catch(() => "");
    if (res.status === 404) return new Error(`Ollama does not have the model ${this.model}; run: ollama pull ${this.model}`);
    if (res.status === 503) return new TransientError(`Ollama is busy (HTTP 503)${detail ? `: ${detail}` : ""}`);
    return new Error(`Ollama failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
  }
}
