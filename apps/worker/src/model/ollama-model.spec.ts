import { TransientError } from "../pipeline";
import { OllamaModel } from "./ollama-model";

const request = { system: "sys", prompt: "plan this", schema: { type: "object" }, maxOutputTokens: 32_000, signal: new AbortController().signal };

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function modelWith(...responses: Array<Response | Error>) {
  const fetchFn = jest.fn(async () => {
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  const model = new OllamaModel({
    model: "qwen2.5-coder:14b",
    baseUrl: "http://localhost:11434/",
    contextTokens: 32_768,
    timeoutMs: 30_000,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { model, fetchFn };
}

const answer = { model: "qwen2.5-coder:14b", message: { content: '{"kind":"rejected","plan":null,"reason":"vague"}' }, done_reason: "stop", prompt_eval_count: 9_000, eval_count: 400 };

describe("OllamaModel", () => {
  it("calls /api/chat with the schema, an explicit context window, and no streaming", async () => {
    const { model, fetchFn } = modelWith(reply(answer));
    const response = await model.generate(request);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "qwen2.5-coder:14b",
      stream: false,
      format: { type: "object" },
      // Output is capped so it fits next to the prompt.
      options: { num_ctx: 32_768, num_predict: 16_384, temperature: 0 },
    });
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[1].content).toMatch(/^plan this\n\nAnswer with JSON that matches this schema:\n\{"type":"object"\}$/);
    expect(response).toEqual({
      output: { kind: "rejected", plan: null, reason: "vague" },
      problem: null,
      model: "qwen2.5-coder:14b",
      usage: { inputTokens: 9_000, outputTokens: 400, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    });
  });

  it("turns truncated or non-JSON answers into feedback", async () => {
    expect(await modelWith(reply({ ...answer, done_reason: "length" })).model.generate(request)).toMatchObject({ problem: expect.stringMatching(/cut off/) });
    expect(await modelWith(reply({ ...answer, message: { content: "Sure! Here is" } })).model.generate(request)).toMatchObject({
      problem: "The answer was not valid JSON.",
    });
  });

  it("refuses to use an answer to a prompt that did not fit the context window", async () => {
    const err = (await modelWith(reply({ ...answer, prompt_eval_count: 20_000 })).model.generate(request).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/does not fit OLLAMA_CONTEXT_TOKENS \(32,768\)/);
  });

  it("explains a missing model and an unreachable server", async () => {
    const missing = (await modelWith(reply({ error: "model 'qwen2.5-coder:14b' not found" }, 404)).model.generate(request).catch((e: Error) => e)) as Error;
    expect(missing.message).toBe("Ollama does not have the model qwen2.5-coder:14b; run: ollama pull qwen2.5-coder:14b");

    const down = await modelWith(new TypeError("fetch failed")).model.generate(request).catch((e: unknown) => e);
    expect(down).toBeInstanceOf(TransientError);
    expect((down as Error).message).toMatch(/Could not reach Ollama at http:\/\/localhost:11434; is it running/);
  });

  it("passes a cancellation through untouched", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    await expect(modelWith(abort).model.generate({ ...request, signal: controller.signal })).rejects.toBe(abort);
  });
});
