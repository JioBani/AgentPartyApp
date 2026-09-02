/*
 * Full-process triggerless completion E2E.
 *
 * Launches the real AgentParty app, types through Chromium's input path, reads
 * the real completion rows, and commits with a real Tab key. No provider call is
 * made: this verifies the composer UI and its live route catalog only.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = path.join(os.tmpdir(), "agentparty-completion-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-completion-e2e-user-data");
const editor = ".wb-composer-editor";
const claudeProviderTag = "⟦ap-tag:v1:provider:anthropic:Claude⟧";
const codexProviderTag = "⟦ap-tag:v1:provider:openai:Codex⟧";
const failures = [];
let base = "";
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

await removePath(workspace);
await removePath(userData);
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: workspace }, null, 2));

const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    AGENTPARTY_QA: "1",
    AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
    AGENTPARTY_USER_DATA: userData,
    AGENTPARTY_WINDOW_DISPLAY: "left",
  },
  windowsHide: true,
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

try {
  await waitForApi();
  const state = await get("/api/state");
  const appRoot = String(state.runtime?.appRoot || "");
  assert((appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep), `running app came from this worktree (${appRoot})`);

  await post("/api/qa/seed", {
    party: "completion e2e",
    members: [
      { name: "main", role: "target", autoReply: false },
      { name: "impl", role: "implementation", autoReply: false },
    ],
  });
  await post("/api/qa/open", { panels: [["main"]] });
  await delay(800);

  await input({ selector: editor, text: "zzlive" });
  const beforeMemberAdd = await postRaw("/api/measure", { selector: ".wb-mention-pop", limit: 5 });
  assert(beforeMemberAdd.status === 500, "an unknown member has no completion row before it exists");
  await post("/api/party/members", { name: "zzlive", requirement: "completion catalog live-update QA" });
  await delay(600);
  const liveMemberRows = await measure(".wb-mention-row .wb-mention-name");
  assert(liveMemberRows.texts.includes("@zzlive"), "a member created while completion is open appears without another keystroke");

  await input({ selector: editor, text: "i" });
  const memberRows = await measure(".wb-mention-row .wb-mention-name");
  assert(memberRows.texts.includes("@impl"), "typing one letter 'i' opens member impl");
  const mention = await input({ selector: editor, key: "Tab" });
  assert(mention.draft === "@impl ", `Tab commits the member mention (${JSON.stringify(mention.draft)})`);

  await input({ selector: editor, text: "cl" });
  const providerRows = await measure(".wb-mention-row .wb-mention-name");
  assert(providerRows.texts.includes("Claude"), "typing 'cl' opens Claude provider completion");
  const provider = await input({ selector: editor, key: "Tab" });
  assert(provider.draft === `${claudeProviderTag} `, `Tab commits Claude's wrapped provider token (${JSON.stringify(provider.draft)})`);
  const modelRows = await measure(".wb-mention-row .wb-mention-name");
  assert(modelRows.texts.length > 0 && !modelRows.texts.includes("Claude"), `provider commit immediately advances to models (${modelRows.texts.join(", ")})`);

  await input({ selector: editor, key: "Backspace" });
  const deleted = await input({ selector: editor, key: "Backspace" });
  assert(deleted.draft === "", `Backspace removes the mistaken provider (${JSON.stringify(deleted.draft)})`);
  const stale = await postRaw("/api/measure", { selector: ".wb-mention-pop", limit: 5 });
  assert(stale.status === 500, "deleting the provider closes its stale model popover");

  await input({ selector: editor, text: "co" });
  const replacementRows = await measure(".wb-mention-row .wb-mention-name");
  assert(replacementRows.texts.includes("Codex"), "typing again offers a replacement provider");
  const replacement = await input({ selector: editor, key: "Tab" });
  assert(replacement.draft === `${codexProviderTag} `, `Tab commits wrapped Codex after deleting Claude (${JSON.stringify(replacement.draft)})`);
  const replacementModels = await measure(".wb-mention-row .wb-mention-name");
  assert(replacementModels.texts.length > 0 && !replacementModels.texts.includes("Codex"), `Codex immediately opens its models (${replacementModels.texts.join(", ")})`);
  const model = await input({ selector: editor, key: "Tab" });
  assert(model.draft.startsWith(`${codexProviderTag} ⟦ap-tag:v1:model:`), `next Tab commits a wrapped Codex model (${JSON.stringify(model.draft)})`);

  await input({ selector: editor, key: "Backspace" });
  const modelDeleted = await input({ selector: editor, key: "Backspace" });
  assert(modelDeleted.draft === `${codexProviderTag} `, `deleting only the model keeps Codex selected (${JSON.stringify(modelDeleted.draft)})`);
  const reopenedModels = await measure(".wb-mention-row .wb-mention-name");
  assert(reopenedModels.texts.length > 1 && reopenedModels.texts.some((name) => /Terra/i.test(name)), `model deletion reopens the full Codex model list (${reopenedModels.texts.join(", ")})`);

  await input({ selector: editor, key: "Tab" });
  const taggedMessage = await input({ selector: editor, key: "Enter", modifiers: ["control"] });
  assert(taggedMessage.draft === "", "wrapped provider/model message sends through the real composer");
  const transcriptTags = await measure(".wb-user-bubble .wb-token-chip.is-static", { styles: ["user-select"] });
  assert(transcriptTags.texts.includes("Codex") && transcriptTags.texts.some((name) => /^GPT-5\.6 /.test(name)), `sent transcript restores provider and model chips (${transcriptTags.texts.join(", ")})`);
  const selectable = transcriptTags.elements?.every((element) => element.styles?.["user-select"] === "text");
  assert(selectable, "restored transcript chips remain selectable for copy");

  await input({ selector: editor, text: "cl" });
  const sent = await input({ selector: editor, key: "Enter", modifiers: ["control"] });
  assert(sent.draft === "", "an open triggerless list never steals Ctrl+Enter from message send");

  await post("/api/window/close", {});
  await waitForExit(child);
  console.log(failures.length ? `\nCOMPOSER COMPLETION E2E FAILED (${failures.length})` : "\nCOMPOSER COMPLETION E2E PASSED");
  process.exit(failures.length ? 1 : 0);
} catch (error) {
  killProcessTree(child.pid);
  throw error;
}

async function input(body) {
  const result = await post("/api/qa/input", body);
  await delay(250);
  return result;
}
async function measure(selector, extra = {}) {
  return post("/api/measure", { selector, limit: 50, ...extra });
}
async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    base = firstBaseUrl(workspace);
    if (base) {
      try { if ((await get("/api/health")).ok) return; } catch {}
    }
    await delay(500);
  }
  throw new Error("Automation API did not start for the completion E2E.");
}
async function get(url) {
  const response = await fetch(base + url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}
async function post(url, body) {
  const response = await fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  return response.json();
}
async function postRaw(url, body) {
  const response = await fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return { status: response.status, body: await response.text() };
}
async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; }
    catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) throw error;
      await delay(300);
    }
  }
}
function waitForExit(process) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("App did not exit after close API.")), 10_000);
    process.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}
function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); }
  catch { try { process.kill(pid); } catch {} }
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
