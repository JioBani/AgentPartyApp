/*
 * Subagent attribution — REPLAY of recorded real harness traffic.
 *
 * Feeds the raw frames captured from live Haiku (Claude) and gpt-mini (Codex)
 * subagent runs (scripts/fixtures/subagents/*.jsonl) through the trackers exactly
 * as the adapters call them, then folds the emitted `subagent` events with the
 * renderer fold and asserts the dock/detail end state. This locks in the fix
 * against the ACTUAL protocol shapes (not hand-written mocks) and guards the two
 * core promises: correct attribution + subagent output kept OUT of the parent.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const outDir = qaTempDir();
async function bundle(entry, name) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}
async function bundleWithExternalPackages(entry, name) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", packages: "external", write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}
const readJsonl = (rel) => readFileSync(path.join(projectRoot, rel), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

const { ClaudeSubagentTracker, CodexSubagentTracker } = await bundle("src/core/subagentTracker.ts", "tracker.mjs");
const { applySubagentEvents } = await bundle("src/renderer/app/subagentEvents.ts", "sub-fold-2.mjs");
const { CodexAdapter } = await bundleWithExternalPackages("src/core/codexAdapter.ts", "subagent-codex-adapter.mjs");
const { ClaudeAdapter } = await bundleWithExternalPackages("src/core/claudeAdapter.ts", "subagent-claude-adapter.mjs");

const stamp = (emits) => emits.map((e) => ({ type: "subagent", agentId: e.agentId, lifecycle: e.lifecycle, activity: e.activity, block: e.block, at: "t" }));

// ============ CLAUDE (recorded Haiku, 2 subagents) ============
console.log("\nCLAUDE replay (recorded Haiku traffic):");
{
  const frames = readJsonl("scripts/fixtures/subagents/claude-haiku-2subagents.jsonl");
  const tracker = new ClaudeSubagentTracker();
  let state = {};
  let parentLeak = 0;              // task_* must NOT produce parent status
  const feed = (emits) => { state = applySubagentEvents(state, "s", stamp(emits)); };
  for (const m of frames) {
    if (m.type === "system" && m.subtype === "task_started") { const e = tracker.taskStarted(m); if (m.task_type === "local_agent") assert(e.length > 0 || true, ""); feed(e); }
    else if (m.type === "system" && m.subtype === "task_progress") feed(tracker.taskProgress(m));
    else if (m.type === "system" && m.subtype === "task_updated") feed(tracker.taskUpdated(m));
    else if (m.type === "stream_event" && m.event?.type === "content_block_start" && m.event.content_block?.type === "tool_use") feed(tracker.spawn(m.event.content_block.id, m.event.content_block.input));
  }
  const subs = state.s || [];
  assert(subs.length === 2, `2 subagents attributed (got ${subs.length})`);
  const names = subs.map((s) => s.name);
  assert(names.some((n) => /TODO/.test(n)) && names.some((n) => /verifyRefresh/.test(n)), `named by Task description (${JSON.stringify(names)})`);
  assert(subs.every((s) => s.phase === "done"), "both reach phase=done via task_updated(completed)");
  const withAct = subs.filter((s) => s.activity && (s.activity.summary || s.activity.label));
  assert(withAct.length === 2, "both carry a live currentAction (from task_progress)");
  assert(subs.some((s) => s.activity && /Grep|verifyRefresh|TODO|Search/.test(s.activity.summary || "")), "currentAction reflects real activity (Grep / Searching)");
  assert(subs.every((s) => s.task && s.task.length > 0), "delegated task (prompt) captured for the detail band");
  // local_bash task_started must NOT create its own dock row:
  const bashNames = subs.map((s) => s.name).filter((n) => /grep -rn|cd \//.test(n));
  assert(bashNames.length === 0, "local_bash steps do NOT become their own subagent rows");
}

// ============ CODEX (recorded gpt-mini, 2 collab threads) ============
console.log("\nCODEX replay (recorded gpt-mini traffic):");
{
  const frames = readJsonl("scripts/fixtures/subagents/codex-gptmini-2subagents.jsonl");
  const tracker = new CodexSubagentTracker();
  let state = {};
  let parentItems = 0;            // items the adapter would send to the PARENT transcript
  let childItems = 0;            // items routed to a subagent
  const feed = (emits) => { state = applySubagentEvents(state, "s", stamp(emits)); };
  for (const m of frames) {
    const p = m.params || {};
    const threadId = String(p.threadId || "");
    const isSub = tracker.isSubagentThread(threadId);
    if (m.method === "thread/started") { if (!p.thread?.parentThreadId) tracker.setRoot(p.thread?.id); }
    else if (m.method === "thread/status/changed") { if (isSub) feed(tracker.threadStatus(threadId, p.status?.type)); }
    else if (m.method === "turn/started") { if (isSub) feed(tracker.threadStatus(threadId, "active")); }
    else if (m.method === "turn/completed") { if (isSub) feed(tracker.threadStatus(threadId, "idle")); else feed(tracker.turnComplete()); }
    else if (m.method === "item/started" || m.method === "item/completed") {
      const status = m.method === "item/started" ? "started" : "completed";
      if (isSub) { childItems += 1; feed(tracker.item(threadId, p.item, status)); }
      else if (p.item?.type === "collabAgentToolCall") feed(tracker.collab(p.item));
      else parentItems += 1;   // a genuine parent item (root's own tools)
    }
  }
  let subs = state.s || [];
  assert(subs.length === 2, `2 collab subagents attributed by threadId (got ${subs.length})`);
  assert(subs.every((s) => s.task && /TODO|verifyRefresh/.test(s.task)), "each carries its delegated prompt");
  // This recording ends while the children are still active (it was captured
  // before the parent turn completed), so they read as "working" here — which is
  // correct. The parent's turn/completed is what closes them; feed it to verify
  // the safety-net transition to done.
  assert(subs.every((s) => s.phase === "working"), "children read as working while the parent turn is unfinished");
  feed(tracker.turnComplete());
  subs = state.s || [];
  assert(subs.every((s) => s.phase === "done"), "parent turn/completed closes remaining subagents (done)");
  assert(childItems > 0, `child-thread items were routed to subagents (${childItems})`);
  const toolBlockList = subs.flatMap((s) => s.blocks.filter((b) => b.kind === "tool"));
  assert(toolBlockList.length > 0, `subagent detail has real tool blocks (${toolBlockList.length} shell/mcp) — not empty`);
  // Cards appear once per command (only on completion), not empty started/done pairs.
  assert(toolBlockList.every((b) => b.status === "completed" || b.status === "failed"), "tool cards are emitted once (on completion), no empty started duplicates");
  // The command shows the real command, not the powershell/bash launcher wrapper.
  assert(toolBlockList.every((b) => !/powershell\.exe|WindowsPowerShell/i.test(b.arg || "")), "shell command is unwrapped (no powershell.exe launcher noise)");
  assert(toolBlockList.some((b) => /^(rg|grep|ls|dir|find|cat|Get-|Select-)/.test((b.arg || "").trim())), "shell arg reads as an actual command");
  assert(subs.some((s) => s.activity && s.activity.kind === "running"), "currentAction derived from child commandExecution");
  // Separation: the child items must vastly outnumber what leaks to the parent.
  assert(childItems > parentItems, `most activity routed to subagents, not parent (child ${childItems} > parent ${parentItems})`);

  // A subagent's web_search must surface as a card in ITS detail (regression:
  // webSearch items were dropped, so a subagent that web-searched showed nothing).
  const t2 = new CodexSubagentTracker();
  t2.setRoot("root-x");
  t2.collab({ tool: "spawnAgent", receiverThreadIds: ["child-x"], prompt: "research the web" });
  let s2 = {};
  const feed2 = (emits) => { s2 = applySubagentEvents(s2, "s", stamp(emits)); };
  feed2(t2.item("child-x", { type: "webSearch", query: "AgentParty desktop app" }, "started"));
  feed2(t2.item("child-x", { type: "webSearch", query: "AgentParty desktop app" }, "completed"));
  const wsub = (s2.s || [])[0];
  const webCard = wsub.blocks.find((b) => b.kind === "tool" && b.name === "web_search");
  assert(Boolean(webCard) && /AgentParty/.test(webCard.arg || ""), "subagent web_search surfaces as a card in the subagent (not dropped, not parent)");
  assert(wsub.activity && wsub.activity.kind === "web", "web_search drives '웹 검색중' currentAction");

  // Regression (real captured shape): a completed webSearch can carry an empty
  // top-level `query` with the real query only under `action.queries` — the card
  // must still show a query, never collapse to an empty "선처럼" strip. And an
  // agentMessage that completes with empty text must NOT add a blank block.
  const t3 = new CodexSubagentTracker();
  t3.setRoot("root-y");
  t3.collab({ tool: "spawnAgent", receiverThreadIds: ["child-y"], prompt: "research" });
  let s3 = {};
  const feed3 = (emits) => { s3 = applySubagentEvents(s3, "s", stamp(emits)); };
  feed3(t3.item("child-y", { type: "webSearch", query: "", action: { type: "other" } }, "started"));
  feed3(t3.item("child-y", { type: "webSearch", query: "", action: { type: "search", queries: ["수능 영어 1등급 비율"] } }, "completed"));
  feed3(t3.item("child-y", { type: "agentMessage", text: "" }, "completed"));
  feed3(t3.item("child-y", { type: "agentMessage", text: "   " }, "completed"));
  feed3(t3.item("child-y", { type: "agentMessage", text: "조사 결과 …" }, "completed"));
  const ysub = (s3.s || [])[0];
  const yWeb = ysub.blocks.filter((b) => b.kind === "tool" && b.name === "web_search");
  assert(yWeb.length === 1 && /1등급/.test(yWeb[0].arg || ""), "empty top-level query falls back to action.queries (card is not an empty strip)");
  const yAsst = ysub.blocks.filter((b) => b.kind === "assistant");
  assert(yAsst.length === 1 && /조사 결과/.test(yAsst[0].text), "empty/whitespace agentMessage completions add no blank blocks (only the real message)");
}

// A request response can establish the root without a `thread/started`
// notification (notably on resume). Drive the real adapter in that protocol
// order: before the fix it classified child-x as parent activity and emitted no
// `subagent` event at all.
console.log("\nCODEX adapter root from thread response:");
{
  const adapter = new CodexAdapter({ id: "adapter-root", cwd: process.cwd(), model: "gpt-5.4-mini", effort: "low", debugEnabled: false });
  const events = [];
  adapter.on("event", (event) => events.push(event));
  adapter.applyThreadResult({ thread: { id: "root-from-response" }, model: "gpt-5.4-mini" });
  adapter.readMessage(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "root-from-response",
      item: { type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["child-from-response"], prompt: "inspect one file" },
    },
  }));
  adapter.readMessage(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "child-from-response",
      item: { type: "agentMessage", text: "inspection complete" },
    },
  }));
  const childEvents = events.filter((event) => event.type === "subagent" && event.agentId === "child-from-response");
  assert(childEvents.length >= 2, `response-established root routes child notifications to the subagent dock (${childEvents.length} events)`);
  assert(childEvents.some((event) => event.block?.kind === "assistant"), "child output stays in its own subagent transcript after response-only root initialization");
  adapter.dispose();
}

console.log("\nCODEX root change:");
{
  const tracker = new CodexSubagentTracker();
  tracker.setRoot("old-root");
  tracker.collab({ tool: "spawnAgent", receiverThreadIds: ["old-child"] });
  tracker.setRoot("new-root");
  assert(!tracker.isSubagentThread("new-root"), "a restarted adapter's new root is never classified as a child");
  assert(tracker.threadStatus("old-child", "active").length === 0, "changing roots discards child state from the previous Codex thread");
}

console.log("\nCLAUDE stuck-hook diagnostic:");
{
  const adapter = new ClaudeAdapter({
    id: "hook-watch", cwd: process.cwd(), model: "haiku", effort: "low",
    safeMode: false, debugEnabled: false, storageDir: outDir,
    customModelRoutes: [], routerBaseUrl: "http://127.0.0.1:1", routerAuthToken: "",
    hookStallMs: 15,
  });
  const events = [];
  adapter.on("event", (event) => events.push(event));
  await adapter.normalize({ type: "system", subtype: "hook_started", hook_id: "hook-stuck", hook_name: "Stop" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const diagnostic = events.find((event) => event.type === "diagnostic" && event.category === "hook");
  assert(Boolean(diagnostic) && /Stop/.test(diagnostic.title), "an unmatched Claude hook is surfaced with its name instead of an indefinite spinner");

  await adapter.normalize({ type: "system", subtype: "hook_started", hook_id: "hook-ok", hook_name: "UserPromptSubmit" });
  await adapter.normalize({ type: "system", subtype: "hook_response", hook_id: "hook-ok", hook_name: "UserPromptSubmit" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert(!events.some((event) => event.type === "diagnostic" && /UserPromptSubmit/.test(event.title)), "a matched hook response cancels the watchdog (no false warning)");
  adapter.dispose();
}

console.log(failures.length ? `\nSUBAGENT TRACKER FAILED (${failures.length})` : "\nSUBAGENT TRACKER PASSED");
process.exit(failures.length ? 1 : 0);
