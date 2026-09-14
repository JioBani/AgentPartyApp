/**
 * B.AI's unified LLM API endpoint and credential env var.
 *
 * One key reaches many vendors' models (Gemini, Kimi, GLM, Qwen, DeepSeek, …)
 * behind three wires on the same base, so each harness talks its own protocol
 * with no translation of ours:
 *  - claude-code emits Anthropic Messages -> `${BAI_BASE_URL}/messages`
 *  - codex emits OpenAI Responses        -> `${BAI_BASE_URL}/responses`
 *    (served for the GPT and DeepSeek families only)
 * `Authorization: Bearer` and `x-api-key` are both accepted.
 *
 * Verified 2026-09-14 against https://docs.b.ai/llmservice/api/ and the B.AI
 * Codex / Claude Code integration guides.
 */

/** Serves /models, /messages, /responses and /chat/completions. */
export const BAI_BASE_URL = "https://api.b.ai/v1";

export const BAI_API_KEY_ENV = "BAI_API_KEY";
