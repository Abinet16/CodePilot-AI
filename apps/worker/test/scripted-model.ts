import type { ModelRequest, ModelResponse, StructuredModel } from "../src/model/structured-model";

export type Script = Array<ModelResponse | Error | ((req: ModelRequest) => Promise<ModelResponse>)>;

export const usage = { inputTokens: 3_000, outputTokens: 1_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

/** Replays scripted answers and records each prompt it was sent. */
export class ScriptedModel implements StructuredModel {
  readonly model = "claude-opus-5-5";
  readonly prompts: string[] = [];
  constructor(private readonly script: Script) {}
  async generate(req: ModelRequest): Promise<ModelResponse> {
    this.prompts.push(req.prompt);
    const step = this.script.shift();
    if (!step) throw new Error("script exhausted");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(req) : step;
  }
}

export const answer = (output: unknown, model = "claude-opus-5-5"): ModelResponse => ({ output, problem: null, model, usage });
