# ADR 0009: Pluggable model providers (Claude, Gemini, Ollama)

- Status: Accepted
- Date: 2026-11-02

## Context

Planning, patch generation, and repairs were built on the Claude API. Without an Anthropic key, the project could not be run end to end. Free options are needed for development and demos: a hosted free tier, and a local model that needs no account at all.

## Decision

1. **One interface, three adapters.**
   - Every stage depends only on `StructuredModel`: a system prompt, a user prompt, and a JSON schema go in; parsed JSON, a feedback problem, the serving model, and token usage come out.
   - `MODEL_PROVIDER` selects `AnthropicModel` (default), `GeminiModel`, or `OllamaModel`. A factory builds them, and nothing else in the pipeline changes.
   - The validation, plan contract, sandboxed checks, and human gates are the same for every provider.
2. **No new dependencies.**
   - Gemini is called over HTTPS (`models.generateContent` with a JSON schema `responseFormat`), with the key in the `x-goog-api-key` header, never in a URL or an error message.
   - Ollama is called through its local `/api/chat` with the schema in `format`.
3. **The same failure classes.**
   - Rate limits, 5xx responses, and unreachable servers are `TransientError` and are retried by the queue.
   - Safety blocks (Gemini `promptFeedback.blockReason` or a safety finish reason) are refusals, recorded with their usage and not retried.
   - Truncated or non-JSON answers become feedback for the next attempt.
   - A missing Ollama model fails with the `ollama pull` command to run.
4. **Ollama's context window is always set explicitly** (`OLLAMA_CONTEXT_TOKENS`, default 32,768). Ollama's default window is much smaller than CodePilot's prompts, and it truncates silently. The adapter caps the answer at half the window. It refuses to use an answer whose prompt did not fit with room for the answer, instead of acting on a plan made from half the context. The schema is also repeated in the prompt, as Ollama recommends.
5. **Usage stays honest.**
   - Every usage row records its provider.
   - Gemini models are priced at the published paid-tier list price, so a free-tier key shows what the same work would cost. A hosted model with no price is still refused at startup.
   - Ollama models have no price and are recorded at $0.
   - The per-task token budget applies to every provider.

## Consequences

- The project runs end to end for free: with Ollama on the developer's machine, or with a Gemini free-tier key.
- Gemini free-tier prompts, which contain repository code, may be used by Google to improve its products. Do not use the free tier for code that must not leave your control; use Ollama, or a paid tier with suitable terms.
- Quality follows the model. Smaller local models fail validation and checks more often, which costs attempts and ends more tasks as `FAILED`. Gemini and Ollama use one model for every stage, while Claude keeps separate planning and patch models.
- The Gemini and Ollama adapters are tested against recorded request and response shapes, not against the live services. The first real task on each provider is the end-to-end check.
