/*
 * Vision support and harness-protocol preservation:
 *  1. Every catalog route carries a vision capability and resolves consistently.
 *  2. The Claude Code gateway keeps Anthropic image/content blocks intact while
 *     changing only the concrete provider model id.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "PASS" : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};

const outDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(outDir, { recursive: true });
async function load(entry, name) {
  const result = await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
  });
  const file = path.join(outDir, name);
  writeFileSync(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const registry = await load("src/core/modelRegistry.ts", "vision-registry.mjs");
const gateway = await load("src/core/routerShim.ts", "vision-gateway.mjs");

console.log("\ncatalog + registry vision:");
const routes = registry.buildModelRoutes("sonnet");
const visionOf = (model) => routes.find((route) => route.model === model || route.runtimeModel === model)?.capabilities.vision;

assert(routes.every((route) => route.capabilities?.vision), "every route carries capabilities.vision");
assert(visionOf("sonnet")?.image === true, "Anthropic Sonnet supports images");
assert(visionOf("gpt-5.4")?.image === true, "GPT-5.4 supports images");
assert(visionOf("gpt-5.6-sol")?.image === true, "GPT-5.6 Sol supports images");
assert(visionOf("GLM-5.2")?.image === false, "GLM-5.2 is text-only");
assert(visionOf("Qwen3.7 Max")?.image === false, "Qwen3.7 Max is text-only");
assert(visionOf("DeepSeek V4 Pro")?.image === false, "DeepSeek V4 Pro is text-only");
assert(visionOf("Gemini 3.5 Flash")?.image === true, "Gemini 3.5 Flash supports images");

console.log("\nvisionForModel resolution:");
assert(registry.visionForModel("sonnet").image === true, "catalog id resolves");
assert(registry.visionForModel("claude-glm").image === false, "runtime alias resolves");
assert(registry.visionForModel("z-ai/glm-5.2").image === false, "OpenRouter id resolves");
assert(registry.visionForModel("gpt-5.4").image === true, "Codex slug resolves");
assert(registry.visionForModel("gpt-5.4-mini").image === true, "Codex mini slug resolves");
assert(registry.visionForModel("totally-unknown-model").image === undefined, "unknown model remains unknown");

console.log("\nCodex OpenRouter route inherits catalog vision:");
const glmCodex = routes.find((route) => route.harnessId === "codex" && route.model === "z-ai/glm-5.2");
assert(glmCodex?.capabilities.vision.image === false, "Codex + GLM remains text-only");

console.log("\nAnthropic protocol preservation:");
const body = {
  model: "claude-gpt-5.4-mini",
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    },
  ],
};
const rewritten = gateway.rewriteAnthropicRequestModel(body, "gpt-5.4-mini");
assert(rewritten.model === "gpt-5.4-mini", "only the concrete model id changes");
assert(rewritten.messages === body.messages, "the Anthropic message array is not rebuilt");
assert(JSON.stringify(rewritten.messages) === JSON.stringify(body.messages), "all Anthropic content blocks remain equivalent");
const image = rewritten.messages[0].content.find((block) => block.type === "image");
assert(image?.source?.type === "base64" && image.source.data === "AAAA", "the original Anthropic image block survives unchanged");

console.log(failures.length ? `\nVISION FAILED (${failures.length})` : "\nVISION PASSED");
process.exit(failures.length ? 1 : 0);
