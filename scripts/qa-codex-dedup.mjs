/*
 * Codex assistant-message de-duplication (real adapter + real renderer reducer).
 *
 * codex reports one message item at multiple lifecycle points sharing one item
 * id; buffered providers (OpenRouter via the responses wire) carry the FULL text
 * on item/started AND repeat it on item/completed. The model generates ONCE
 * (same item id, single token bill) — so emitting on both points would render
 * the text twice with no extra generation. This drives the REAL CodexAdapter
 * `normalizeItem` (via readMessage) with the exact captured codex sequence and
 * asserts the assistant text reaches the transcript exactly once.
 *
 * Node platform (the adapter imports node:child_process/readline), so this is a
 * standalone script rather than part of the jsdom suite.
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
async function bundleNode(entry, name) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", packages: "external", write: false });
  const p = path.join(outDir, name);
  writeFileSync(p, r.outputFiles[0].text);
  return import(pathToFileURL(p).href);
}

const { CodexAdapter } = await bundleNode("src/core/codexAdapter.ts", "codex-adapter-node.mjs");
const T = await bundleNode("src/renderer/app/transcriptEvents.ts", "transcript-events-node.mjs");

const SENTINEL = "OCEANSENTINEL";
const FULL = `The ocean is vast. ${SENTINEL} lives in it. It is deep.`;

// Feed the EXACT sequence captured from a real OpenRouter (GLM) turn:
//   item/started(empty) → item/started(full) → item/completed(full), one item id.
function driveOpenRouterSequence() {
  const adapter = new CodexAdapter({ id: "t", cwd: process.cwd(), model: "z-ai/glm-5.2", effort: "medium", debugEnabled: false });
  const emits = [];
  adapter.on("event", (e) => { if (e.type === "assistant_text_delta") emits.push(e.text); });
  const line = (method, item) => adapter.readMessage(JSON.stringify({ method, params: { item } }));
  line("item/started", { id: "msg_1", type: "agentMessage", text: "" });
  line("item/started", { id: "msg_1", type: "agentMessage", text: FULL });
  line("item/completed", { id: "msg_1", type: "agentMessage", text: FULL });
  adapter.dispose();
  return emits;
}

// The GPT account path: item/started(empty) → item/completed(full).
function driveAccountSequence() {
  const adapter = new CodexAdapter({ id: "t", cwd: process.cwd(), model: "gpt-5.4-mini", effort: "medium", debugEnabled: false });
  const emits = [];
  adapter.on("event", (e) => { if (e.type === "assistant_text_delta") emits.push(e.text); });
  const line = (method, item) => adapter.readMessage(JSON.stringify({ method, params: { item } }));
  line("item/started", { id: "msg_2", type: "agentMessage", text: "" });
  line("item/completed", { id: "msg_2", type: "agentMessage", text: FULL });
  adapter.dispose();
  return emits;
}

console.log("\nAdapter normalizeItem (real):");
const orEmits = driveOpenRouterSequence();
assert(orEmits.length === 1, `OpenRouter sequence emits assistant text exactly once (got ${orEmits.length})`);
assert(orEmits[0] === FULL, "the single emit carries the full final text");
assert((orEmits.join("").match(new RegExp(SENTINEL, "g")) || []).length === 1, "the sentinel word appears exactly once across all emits");

const acctEmits = driveAccountSequence();
assert(acctEmits.length === 1, `account (GPT) sequence still emits exactly once (got ${acctEmits.length})`);

console.log("\nFull pipeline (adapter emits → renderer applyEvents):");
// Feed the adapter's real emitted events through the real renderer reducer.
const events = orEmits.map((text) => ({ type: "assistant_text_delta", text }));
const blocks = T.applyEvents({}, "s1", events)["s1"] || [];
const assistantBlocks = blocks.filter((b) => b.kind === "assistant");
assert(assistantBlocks.length === 1, `renderer shows a single assistant block (got ${assistantBlocks.length})`);
assert((assistantBlocks[0]?.text.match(new RegExp(SENTINEL, "g")) || []).length === 1, "the rendered assistant block contains the text once (no duplication)");

console.log(failures.length ? `\nCODEX DEDUP FAILED (${failures.length})` : "\nCODEX DEDUP PASSED");
process.exit(failures.length ? 1 : 0);
