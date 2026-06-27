/*
 * Engine-level check for the QA interaction mock API (qaInteraction).
 * Builds an in-process engine host, seeds a mock member, calls qaInteraction,
 * and asserts the renderer-bound `approval_request` (AskUserQuestion) event is
 * streamed — proving the mock-prompt path the automation API exposes.
 */
import { build } from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");
const qaDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(qaDir, { recursive: true });

const out = path.join(qaDir, "engine-host.mjs");
const result = await build({ entryPoints: [path.join(projectRoot, "src/main/engine/engineHost.ts")], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
writeFileSync(out, result.outputFiles[0].text);
const { createEngineHost } = await import(pathToFileURL(out).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const workspace = path.join(os.tmpdir(), "agentparty-qa-interaction");
mkdirSync(workspace, { recursive: true });
rmSync(path.join(workspace, ".agent_party_app"), { recursive: true, force: true });

const host = createEngineHost({ storageDir: workspace, router: { preferredPort: 0, authToken: "engine", openRouterApiKey: "" } });
const events = [];
host.sessionManager.on("events", (p) => { for (const e of p.events || []) events.push(e); });

const engine = host.engineRegistry.forWorkspace(workspace);
await engine.qaSeed({ members: [{ name: "qa-bot", autoReply: false }] });

const { requestId } = await engine.qaInteraction("qa-bot", {
  type: "askUserQuestion",
  questions: [{ question: "점심 뭐 먹지?", header: "Lunch", options: [{ label: "김밥" }, { label: "라멘" }] }],
});

await new Promise((r) => setTimeout(r, 50));
const ask = events.find((e) => e.type === "approval_request" && e.toolName === "AskUserQuestion");
console.log("\nQA interaction API assertions:");
assert(Boolean(requestId), `qaInteraction returned a requestId (${requestId})`);
assert(Boolean(ask), "approval_request(AskUserQuestion) was streamed to the renderer channel");
assert(ask?.input?.questions?.[0]?.options?.length === 2, "question options preserved");
assert(ask?.requestId === requestId, "event requestId matches the returned id");

// Default questions when omitted.
const { requestId: id2 } = await engine.qaInteraction("qa-bot", { type: "askUserQuestion" });
await new Promise((r) => setTimeout(r, 50));
const ask2 = events.find((e) => e.type === "approval_request" && e.requestId === id2);
assert(Boolean(ask2?.input?.questions?.length), "default question is used when none provided");

host.dispose();
console.log(failures.length ? `\nFAILED (${failures.length})` : "\nQA INTERACTION API PASSED");
process.exit(failures.length ? 1 : 0);
