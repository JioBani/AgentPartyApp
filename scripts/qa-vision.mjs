/*
 * Vision (image input) support — the single-source-of-truth gate. Verifies:
 *  1. Catalog/registry: every model route carries capabilities.vision; the three
 *     text-only models (GLM-5.2, Qwen3.7 Max, DeepSeek V4 Pro) are image:false,
 *     the rest image:true; visionForModel resolves by id/runtime/orModelId and by
 *     the Codex gpt-slug spelling variant (twin inheritance).
 *  2. Router translation (the no-silent-drop chokepoint): an Anthropic user
 *     message with an image block becomes an OpenAI multimodal content array with
 *     an image_url part — the image is NOT collapsed away to text.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const outDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(outDir, { recursive: true });
async function load(entry, name) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", write: false });
  const file = path.join(outDir, name);
  writeFileSync(file, r.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const registry = await load("src/core/modelRegistry.ts", "vision-registry.mjs");
const shim = await load("src/core/routerShim.ts", "vision-shim.mjs");

console.log("\ncatalog + registry vision:");
const routes = registry.buildModelRoutes("sonnet");
const visionOf = (model) => routes.find((r) => r.model === model || r.runtimeModel === model)?.capabilities.vision;

assert(routes.every((r) => r.capabilities && r.capabilities.vision), "every route carries a capabilities.vision object");
assert(visionOf("sonnet")?.image === true, "Anthropic Sonnet supports images");
assert(visionOf("GPT-5.4")?.image === true, "GPT-5.4 supports images");
assert(visionOf("GLM-5.2")?.image === false, "GLM-5.2 is text-only (image:false)");
assert(visionOf("Qwen3.7 Max")?.image === false, "Qwen3.7 Max is text-only");
assert(visionOf("DeepSeek V4 Pro")?.image === false, "DeepSeek V4 Pro is text-only");
assert(visionOf("Gemini 3.5 Flash")?.image === true, "Gemini 3.5 Flash supports images");

console.log("\nvisionForModel resolution (all id forms):");
assert(registry.visionForModel("sonnet").image === true, "by catalog id");
assert(registry.visionForModel("claude-glm").image === false, "by runtime alias (claude-glm -> GLM-5.2, text-only)");
assert(registry.visionForModel("z-ai/glm-5.2").image === false, "by orModelId (z-ai/glm-5.2, text-only)");
assert(registry.visionForModel("gpt-5.4").image === true, "by Codex slug (gpt-5.4 -> GPT-5.4 twin)");
assert(registry.visionForModel("gpt-5.4-mini").image === true, "by Codex slug spelling variant (gpt-5.4-mini -> GPT-5.4 mini)");
assert(registry.visionForModel("totally-unknown-model").image === undefined, "unknown model = undefined (honest, not assumed)");

console.log("\ncodex openrouter route inherits catalog vision:");
const glmCodex = routes.find((r) => r.harnessId === "codex" && r.model === "z-ai/glm-5.2");
assert(glmCodex?.capabilities.vision.image === false, "Codex+OpenRouter GLM-5.2 route is text-only (same catalog truth)");

console.log("\nrouter translation (no silent drop of image blocks):");
const body = {
  messages: [
    { role: "user", content: [
      { type: "text", text: "describe this" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ] },
  ],
};
const out = shim.toOpenAiMessages(body);
const userMsg = out.find((m) => m.role === "user");
assert(Array.isArray(userMsg?.content), "user message content is a multimodal parts array (not a collapsed string)");
const parts = userMsg.content;
assert(parts.some((p) => p.type === "text" && /describe this/.test(p.text)), "the text part survives");
const imgPart = parts.find((p) => p.type === "image_url");
assert(Boolean(imgPart), "an image_url part is present (image NOT silently dropped)");
assert(/^data:image\/png;base64,AAAA$/.test(imgPart?.image_url?.url || ""), "image_url is a correct base64 data URL");

// A plain text-only message still collapses to a string (unchanged behavior).
const textOnly = shim.toOpenAiMessages({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
assert(typeof textOnly.find((m) => m.role === "user")?.content === "string", "a text-only message stays a plain string");

console.log(failures.length ? `\nVISION FAILED (${failures.length})` : "\nVISION PASSED");
process.exit(failures.length ? 1 : 0);
