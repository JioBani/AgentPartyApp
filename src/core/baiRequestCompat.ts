/**
 * Minimal request normalisation for Gemini models on B.AI's Anthropic Messages
 * surface.
 *
 * B.AI forwards the request to each vendor's own API. Every non-Gemini vendor
 * accepted a real, unmodified Claude Code request (91 tools) — measured
 * 2026-09-14 on deepseek-v4.1-flash, minimax-m3, kimi-k3, glm-5.3 and
 * qwen3.8-max — so only Gemini requests are touched, and only for the two
 * schema shapes Gemini was measured to reject (each tool sent alone to
 * gemini-3.8-flash; the other 89 tools passed as-is):
 *
 *   1. `anyOf: [{type: X, …}, {type: "null"}]` → 400 "schema didn't specify the
 *      schema type field". zod emits this for `.nullable()` (the party tools'
 *      `rule` / `reviewer`). Rewritten to the same schema as `type: [X, "null"]`,
 *      which Gemini accepts — the null-branch collapse google-genai, Vercel's
 *      @ai-sdk/google and CLIProxyAPI all apply.
 *
 *   2. An array schema without `items` → 400 "items: missing field". Claude
 *      Code's Artifact tool hits it with a tuple (`query.where` items are
 *      `{type: "array", prefixItems: […]}`), but a plain `{type: "array"}` is
 *      rejected the same way. `items: {}` ("any element") is accepted and keeps
 *      the schema's meaning — a leftover `prefixItems` is then harmless — unlike
 *      the element-type guesses LiteLLM (object) and CLIProxyAPI (string) make.
 *
 * Nothing else is rewritten "just in case": if Gemini rejects another shape, the
 * 400 reaches the transcript verbatim, and AGENTPARTY_ROUTER_DUMP=1 captures the
 * request for the next measured rule.
 */

type Json = Record<string, unknown>;

export function isGeminiModel(model: unknown): boolean {
  return typeof model === "string" && /^gemini-/i.test(model);
}

function isNullSchema(node: unknown): boolean {
  return Boolean(node) && typeof node === "object" && (node as Json).type === "null" && Object.keys(node as Json).length === 1;
}

function sanitizeForGemini(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitizeForGemini);
  }
  if (!node || typeof node !== "object") {
    return node;
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    out[key] = sanitizeForGemini(value);
  }

  // 1. nullable anyOf → type array
  const anyOf = out.anyOf;
  if (Array.isArray(anyOf) && anyOf.length === 2 && out.type === undefined) {
    const nonNull = anyOf.filter((branch) => !isNullSchema(branch));
    const branch = nonNull[0] as Json | undefined;
    if (nonNull.length === 1 && branch && typeof branch.type === "string") {
      const { anyOf: _dropped, ...rest } = out;
      return { ...branch, ...rest, type: [branch.type, "null"] };
    }
  }

  // 2. array without items → items: {}
  const types = Array.isArray(out.type) ? out.type : [out.type];
  if (types.includes("array") && out.items === undefined) {
    out.items = {};
  }
  return out;
}

/** Anthropic Messages request → the same request B.AI's vendor will accept. */
export function normalizeAnthropicRequestForBai(body: Json): Json {
  const tools = body.tools as Array<Json> | undefined;
  if (!isGeminiModel(body.model) || !Array.isArray(tools)) {
    return body;
  }
  return {
    ...body,
    tools: tools.map((tool) => (tool?.input_schema ? { ...tool, input_schema: sanitizeForGemini(tool.input_schema) } : tool)),
  };
}
