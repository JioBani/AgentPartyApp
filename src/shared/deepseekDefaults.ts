/**
 * DeepSeek's own API endpoints and credential env var.
 *
 * DeepSeek serves the same models behind two wires, so each harness reaches them
 * on its own protocol without any translation of our own:
 *  - claude-code emits Anthropic Messages -> the `/anthropic` base (x-api-key auth)
 *  - codex emits OpenAI Responses        -> the bare base (Bearer auth, flash only)
 *
 * Verified 2026-07-31 against https://api-docs.deepseek.com/guides/anthropic_api/
 * and https://api-docs.deepseek.com/guides/responses_api/.
 */

/** OpenAI-format base (chat/completions + responses). */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** Anthropic-format base; serves `/v1/messages` and authenticates with x-api-key. */
export const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";

export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
