import type { WorkerConfig } from "../config";
import { AnthropicModel } from "./anthropic-model";
import { GeminiModel } from "./gemini-model";
import { OllamaModel } from "./ollama-model";
import type { StructuredModel } from "./structured-model";

export interface StageModels {
  /** Recorded as the provider on every usage row. */
  provider: WorkerConfig["MODEL_PROVIDER"];
  planning: StructuredModel | null;
  /** Patch generation and repairs. */
  patch: StructuredModel | null;
  /** Why no model is available, for the startup warning; null when both are set. */
  missing: string | null;
}

/** Builds the models each stage uses from MODEL_PROVIDER and that provider's settings. */
export function createModels(config: WorkerConfig): StageModels {
  const timeoutMs = config.MODEL_TIMEOUT_SECONDS * 1000;
  switch (config.MODEL_PROVIDER) {
    case "anthropic": {
      const key = config.ANTHROPIC_API_KEY;
      if (!key) return { provider: "anthropic", planning: null, patch: null, missing: "ANTHROPIC_API_KEY is not set" };
      return {
        provider: "anthropic",
        planning: AnthropicModel.fromApiKey(key, config.PLANNING_MODEL, config.PLANNING_EFFORT, timeoutMs),
        patch: AnthropicModel.fromApiKey(key, config.PATCH_MODEL, config.PATCH_EFFORT, timeoutMs),
        missing: null,
      };
    }
    case "gemini": {
      const key = config.GEMINI_API_KEY;
      if (!key) return { provider: "gemini", planning: null, patch: null, missing: "GEMINI_API_KEY is not set" };
      const model = new GeminiModel({ model: config.GEMINI_MODEL, apiKey: key, timeoutMs });
      return { provider: "gemini", planning: model, patch: model, missing: null };
    }
    case "ollama": {
      const model = new OllamaModel({
        model: config.OLLAMA_MODEL,
        baseUrl: config.OLLAMA_BASE_URL,
        contextTokens: config.OLLAMA_CONTEXT_TOKENS,
        timeoutMs,
      });
      return { provider: "ollama", planning: model, patch: model, missing: null };
    }
  }
}
