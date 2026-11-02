import { loadConfig } from "../config";
import { AnthropicModel } from "./anthropic-model";
import { createModels } from "./factory";
import { GeminiModel } from "./gemini-model";
import { OllamaModel } from "./ollama-model";

const base = { DATABASE_URL: "postgresql://x@localhost/db", REDIS_URL: "redis://localhost:6379" };

describe("createModels", () => {
  it("uses Claude by default, with separate planning and patch models", () => {
    const models = createModels(loadConfig({ ...base, ANTHROPIC_API_KEY: "sk-ant-test", PATCH_MODEL: "claude-sonnet-5-5" }));
    expect(models).toMatchObject({ provider: "anthropic", missing: null });
    expect(models.planning).toBeInstanceOf(AnthropicModel);
    expect(models.planning?.model).toBe("claude-opus-5-5");
    expect(models.patch?.model).toBe("claude-sonnet-5-5");
  });

  it("uses Gemini when chosen, with one model for every stage", () => {
    const models = createModels(loadConfig({ ...base, MODEL_PROVIDER: "gemini", GEMINI_API_KEY: "AIza-test" }));
    expect(models).toMatchObject({ provider: "gemini", missing: null });
    expect(models.planning).toBeInstanceOf(GeminiModel);
    expect(models.planning?.model).toBe("gemini-3.8-flash");
    expect(models.patch).toBe(models.planning);
  });

  it("uses a local Ollama model without any key", () => {
    const models = createModels(loadConfig({ ...base, MODEL_PROVIDER: "ollama", OLLAMA_MODEL: "qwen2.5-coder:7b" }));
    expect(models).toMatchObject({ provider: "ollama", missing: null });
    expect(models.planning).toBeInstanceOf(OllamaModel);
    expect(models.planning?.model).toBe("qwen2.5-coder:7b");
  });

  it("names the missing key instead of failing at startup", () => {
    expect(createModels(loadConfig({ ...base, MODEL_PROVIDER: "gemini" }))).toEqual({ provider: "gemini", planning: null, patch: null, missing: "GEMINI_API_KEY is not set" });
    expect(createModels(loadConfig(base)).missing).toBe("ANTHROPIC_API_KEY is not set");
  });

  it("refuses an unknown provider and an unpriced hosted model", () => {
    expect(() => loadConfig({ ...base, MODEL_PROVIDER: "openai" })).toThrow(/MODEL_PROVIDER/);
    expect(() => loadConfig({ ...base, MODEL_PROVIDER: "gemini", GEMINI_MODEL: "gemini-9-ultra" })).toThrow(/GEMINI_MODEL: has no entry in MODEL_PRICING/);
  });
});
