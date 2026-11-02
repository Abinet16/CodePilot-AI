import type { TokenUsage } from "@codepilot/agent-core";
import { TransientError } from "../pipeline";
import type { ModelRequest, ModelResponse, StructuredModel } from "./structured-model";
import { ModelRefusalError } from "./structured-model";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com";

export interface GeminiModelOptions {
  model: string;
  apiKey: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

interface GeminiPart {
  text?: string;
  /** Set on thought summaries, which are not part of the answer. */
  thought?: boolean;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  modelVersion?: string;
}

/** Finish reasons that mean the provider declined to answer. Retrying the same prompt will not help. */
const REFUSALS: ReadonlySet<string> = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]);

/**
 * Structured answers from the Gemini API (`models.generateContent`) with a
 * JSON schema response format. Called over HTTPS with the key in the
 * `x-goog-api-key` header; the key never appears in a URL or an error message.
 */
export class GeminiModel implements StructuredModel {
  readonly model: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: GeminiModelOptions) {
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const url = `${GEMINI_API_BASE}/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: "user", parts: [{ text: request.prompt }] }],
      generationConfig: {
        maxOutputTokens: request.maxOutputTokens,
        responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: request.schema } },
      },
    };

    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.options.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.any([request.signal, timeout]),
      });
    } catch (err) {
      if (request.signal.aborted) throw err;
      if (timeout.aborted) throw new Error(`Gemini did not answer within ${Math.round(this.options.timeoutMs / 1000)}s`);
      throw new TransientError("Could not reach the Gemini API", { cause: err });
    }
    if (!res.ok) throw await classify(res);

    const data = (await res.json()) as GeminiResponse;
    const served = data.modelVersion ?? this.model;
    const usage = toUsage(data.usageMetadata);
    const base = { model: served, usage };

    if (data.promptFeedback?.blockReason) throw new ModelRefusalError(data.promptFeedback.blockReason.toLowerCase(), served, usage);
    const candidate = data.candidates?.[0];
    const finish = candidate?.finishReason ?? "";
    if (REFUSALS.has(finish)) throw new ModelRefusalError(finish.toLowerCase(), served, usage);
    if (finish === "MAX_TOKENS") {
      return { ...base, output: null, problem: "The answer was cut off at the output token limit; produce a shorter answer." };
    }

    const text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    try {
      return { ...base, output: JSON.parse(text), problem: null };
    } catch {
      return { ...base, output: null, problem: "The answer was not valid JSON." };
    }
  }
}

/** Gemini reports cached input inside promptTokenCount, and bills thinking as output. */
function toUsage(meta: GeminiResponse["usageMetadata"]): TokenUsage {
  const prompt = meta?.promptTokenCount ?? 0;
  const cached = Math.min(meta?.cachedContentTokenCount ?? 0, prompt);
  return {
    inputTokens: prompt - cached,
    outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0),
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cached,
  };
}

/** Maps HTTP failures to the pipeline's retry policy. Google's error messages do not echo the key. */
async function classify(res: Response): Promise<Error> {
  const detail = await res
    .json()
    .then((b) => (b as { error?: { message?: string } }).error?.message?.slice(0, 300) ?? "")
    .catch(() => "");
  if (res.status === 429) return new TransientError("Gemini rate-limited the request (free-tier limits are low; it will retry)");
  if (res.status >= 500) return new TransientError(`The Gemini API is unavailable (HTTP ${res.status})`);
  if (res.status === 401 || res.status === 403) return new Error("Gemini rejected the worker's API key");
  if (res.status === 404) return new Error(`Gemini does not offer this model (HTTP 404)${detail ? `: ${detail}` : ""}`);
  return new Error(`Gemini rejected the request (HTTP ${res.status})${detail ? `: ${detail}` : ""}`);
}
