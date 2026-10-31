import type { TokenUsage } from "@codepilot/agent-core";

export interface ModelRequest {
  system: string;
  prompt: string;
  /** JSON schema the answer must follow. */
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface ModelResponse {
  /** The parsed JSON answer, or null when the model produced none (see `problem`). */
  output: unknown;
  /** Why `output` is null, phrased so it can be fed back to the model. */
  problem: string | null;
  /** The model that actually answered; it can differ from the requested one after a fallback. */
  model: string;
  usage: TokenUsage;
}

/** The provider boundary for stages that ask a model for structured JSON. Tests substitute a scripted fake. */
export interface StructuredModel {
  /** The model requested on every call. */
  readonly model: string;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

/** The provider declined to answer. Retrying the same prompt will not help. A refusal is still billed. */
export class ModelRefusalError extends Error {
  constructor(
    readonly category: string | null,
    readonly model: string,
    readonly usage: TokenUsage,
  ) {
    super(`The model declined the request${category ? ` (${category})` : ""}`);
    this.name = "ModelRefusalError";
  }
}
