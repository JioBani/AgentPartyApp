/**
 * Minimal request normalisation for xAI's Anthropic-compatible endpoint.
 *
 * The gateway's rule is that Anthropic Messages pass through untranslated; this
 * module is the narrow exception the rule allows at a provider boundary, and it
 * exists only because api.x.ai validates two things more strictly than
 * api.anthropic.com does. Both were measured against a REAL Claude Code request
 * captured from the running harness on 2026-08-10 (103 tools, 2 messages):
 *
 *   1. `messages[].role: "system"` → 400 "Invalid message role".
 *      Claude Code emits a system-role entry inside `messages`; Anthropic
 *      accepts it, xAI's role enum does not. Folded into the top-level `system`
 *      array so no instruction text is lost.
 *
 *   2. An object schema that OMITS `required` → 400
 *      "/required: null is not of type \"array\"".
 *      Exactly the 20 of 103 tools that take no parameters (ExitPlanMode,
 *      TaskList, Workflow, CronList, …) omit it. `required: []` is a semantic
 *      no-op in JSON Schema, so filling it changes nothing about what the model
 *      may call.
 *
 * Everything else is deliberately left alone — `thinking`, `metadata`,
 * `context_management` and `output_config` were each bisected and none of them
 * is rejected, so nothing is stripped "just in case". If xAI tightens further,
 * the failing request is dumpable with AGENTPARTY_ROUTER_DUMP=1 rather than
 * guessed at.
 */

type Json = Record<string, unknown>;

/**
 * xAI streams `thinking` blocks whose `signature` is an empty string. Claude
 * Code treats an unsigned thinking block as invalid and discards the WHOLE
 * assistant message, so a reasoning Grok model completed its turn
 * (`turn complete … end_turn`) while the UI showed no reply at all — measured
 * 2026-08-10 against grok-4.5, with grok-4.20-0309-non-reasoning (which emits
 * no thinking block) answering correctly through the same path. Dropping the
 * unusable block is what makes the text survive; the alternative is a member
 * that silently says nothing.
 *
 * Indices are recompacted because Anthropic clients address content blocks by
 * index, so leaving a hole where the thinking block was would misalign every
 * later block.
 */
export function stripThinkingFromAnthropicResponse(body: Json): Json {
  const content = body.content;
  if (!Array.isArray(content)) {
    return body;
  }
  return { ...body, content: content.filter((block) => (block as Json)?.type !== "thinking") };
}

/** Rewrites one SSE line-group, or returns null to drop it. */
export function createXaiSseFilter(): (event: Json) => Json | null {
  const thinkingIndices = new Set<number>();
  const remap = new Map<number, number>();
  let nextIndex = 0;
  return (event: Json): Json | null => {
    const index = typeof event.index === "number" ? event.index : undefined;
    if (event.type === "content_block_start") {
      const blockType = (event.content_block as Json | undefined)?.type;
      if (blockType === "thinking") {
        if (index !== undefined) {
          thinkingIndices.add(index);
        }
        return null;
      }
      if (index !== undefined) {
        remap.set(index, nextIndex++);
        return { ...event, index: remap.get(index) };
      }
      return event;
    }
    if (index !== undefined && thinkingIndices.has(index)) {
      return null;
    }
    if (index !== undefined && remap.has(index)) {
      return { ...event, index: remap.get(index) };
    }
    return event;
  };
}

/**
 * Adds `required: []` to every object schema that lacks it, at any depth, so
 * nested parameter objects are covered too.
 */
function fillRequiredArrays(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(fillRequiredArrays);
  }
  if (!node || typeof node !== "object") {
    return node;
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    out[key] = fillRequiredArrays(value);
  }
  if (out.type === "object" && out.properties && !Array.isArray(out.required)) {
    out.required = [];
  }
  return out;
}

function asSystemBlocks(system: unknown): Array<Json> {
  if (Array.isArray(system)) {
    return system as Array<Json>;
  }
  if (typeof system === "string" && system.length > 0) {
    return [{ type: "text", text: system }];
  }
  return [];
}

/** Anthropic Messages request → the same request xAI will accept. */
export function normalizeAnthropicRequestForXai(body: Json): Json {
  const system = asSystemBlocks(body.system);
  const messages: Array<Json> = [];
  for (const message of (body.messages as Array<Json> | undefined) || []) {
    if (message?.role === "system") {
      const content = message.content;
      system.push({ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) });
      continue;
    }
    messages.push(message);
  }

  const tools = (body.tools as Array<Json> | undefined)?.map((tool) =>
    tool?.input_schema ? { ...tool, input_schema: fillRequiredArrays(tool.input_schema) } : tool,
  );

  const out: Json = { ...body, messages };
  if (tools) {
    out.tools = tools;
  }
  if (system.length > 0) {
    out.system = system;
  } else {
    delete out.system;
  }
  return out;
}
