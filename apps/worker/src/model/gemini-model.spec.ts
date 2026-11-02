import { TransientError } from "../pipeline";
import { GeminiModel } from "./gemini-model";
import { ModelRefusalError } from "./structured-model";

const request = { system: "sys", prompt: "plan this", schema: { type: "object" }, maxOutputTokens: 8_000, signal: new AbortController().signal };

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function modelWith(...responses: Array<Response | Error>) {
  const fetchFn = jest.fn(async () => {
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  return { model: new GeminiModel({ model: "gemini-3.8-flash", apiKey: "AIza-secret", timeoutMs: 30_000, fetchFn: fetchFn as unknown as typeof fetch }), fetchFn };
}

const answer = {
  candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: '{"kind":"rejected","plan":null,"reason":"vague"}' }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 1_200, cachedContentTokenCount: 200, candidatesTokenCount: 300, thoughtsTokenCount: 500 },
  modelVersion: "gemini-3.8-flash",
};

describe("GeminiModel", () => {
  it("asks generateContent for JSON in the given schema, with the key in a header", async () => {
    const { model, fetchFn } = modelWith(reply(answer));
    const response = await model.generate(request);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(url).not.toContain("AIza");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-secret");
    expect(JSON.parse(init.body as string)).toEqual({
      systemInstruction: { parts: [{ text: "sys" }] },
      contents: [{ role: "user", parts: [{ text: "plan this" }] }],
      generationConfig: { maxOutputTokens: 8_000, responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: { type: "object" } } } },
    });
    expect(response).toEqual({
      output: { kind: "rejected", plan: null, reason: "vague" },
      problem: null,
      model: "gemini-3.8-flash",
      // Cached input is split out; thinking counts as output.
      usage: { inputTokens: 1_000, outputTokens: 800, cacheCreationInputTokens: 0, cacheReadInputTokens: 200 },
    });
  });

  it("turns truncated or non-JSON answers into feedback instead of throwing", async () => {
    const cut = { ...answer, candidates: [{ ...answer.candidates[0], finishReason: "MAX_TOKENS" }] };
    expect(await modelWith(reply(cut)).model.generate(request)).toMatchObject({ output: null, problem: expect.stringMatching(/cut off/) });

    const garbled = { ...answer, candidates: [{ content: { parts: [{ text: "{not json" }] }, finishReason: "STOP" }] };
    expect(await modelWith(reply(garbled)).model.generate(request)).toMatchObject({ output: null, problem: "The answer was not valid JSON." });
  });

  it("raises safety blocks as refusals with their billed usage", async () => {
    const blocked = { promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 900 } };
    const err = await modelWith(reply(blocked)).model.generate(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelRefusalError);
    expect(err).toMatchObject({ category: "prohibited_content", usage: { inputTokens: 900 } });

    const safety = { ...answer, candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] };
    await expect(modelWith(reply(safety)).model.generate(request)).rejects.toBeInstanceOf(ModelRefusalError);
  });

  it("retries rate limits, outages, and dropped connections", async () => {
    for (const failure of [reply({}, 429), reply({}, 503), new TypeError("fetch failed")]) {
      await expect(modelWith(failure).model.generate(request)).rejects.toBeInstanceOf(TransientError);
    }
  });

  it("fails permanently on a bad key or request, with Google's message but never the key", async () => {
    const auth = await modelWith(reply({ error: { message: "API key not valid" } }, 403)).model.generate(request).catch((e: Error) => e) as Error;
    expect(auth.message).toBe("Gemini rejected the worker's API key");
    expect(auth).not.toBeInstanceOf(TransientError);

    const bad = await modelWith(reply({ error: { message: "Invalid JSON payload: schema too complex" } }, 400)).model.generate(request).catch((e: Error) => e) as Error;
    expect(bad.message).toBe("Gemini rejected the request (HTTP 400): Invalid JSON payload: schema too complex");
    expect(bad.message).not.toContain("AIza");
  });

  it("passes a cancellation through untouched", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    await expect(modelWith(abort).model.generate({ ...request, signal: controller.signal })).rejects.toBe(abort);
  });
});
