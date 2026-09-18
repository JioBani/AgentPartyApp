/**
 * B.AI's unified LLM API endpoint and credential env var.
 *
 * AgentParty exposes the verified DeepSeek models through Codex's OpenAI
 * Responses wire at `${BAI_BASE_URL}/responses`. B.AI's Anthropic Messages
 * surface is intentionally not routed because it discards reasoning settings.
 * `Authorization: Bearer` is supplied by Codex through this env-backed key.
 *
 * Verified 2026-09-14 against https://docs.b.ai/llmservice/api/ and the B.AI
 * Codex / Claude Code integration guides.
 */

/** Serves /models, /messages, /responses and /chat/completions. */
export const BAI_BASE_URL = "https://api.b.ai/v1";

export const BAI_API_KEY_ENV = "BAI_API_KEY";
