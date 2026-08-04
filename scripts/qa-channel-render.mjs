/*
 * Renderer-side regression for inter-member (agentparty channel) messages being
 * visible. Two layers:
 *   1. applyEvents (pure): a "sent" status carrying the <channel> envelope folds
 *      into an inbound channel block; the party `send` tool_call folds into an
 *      outbound channel block; ordinary status/tool events are untouched.
 *   2. Transcript (DOM): the channel block renders a who -> whom route + body,
 *      not raw XML / JSON.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const def = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
def("window", window); def("document", window.document); def("HTMLElement", window.HTMLElement);
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); def("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;



const outDir = qaTempDir();
async function bundle(entry, name, external = []) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external, write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}

// ---- Layer 1: applyEvents folding -----------------------------------------
const { applyEvents, normalizeTranscriptBlocks } = await bundle("src/renderer/app/transcriptEvents.ts", "te-channel.mjs", []);

console.log("\napplyEvents channel folding:");
const sid = "s1";
let blocks = {};
// Inbound: a "sent" status whose detail is the channel envelope (what a receiver gets).
const channelDetail = '<channel source="agentparty" from="alice" to="bob">\nPlease review PR 42\n</channel>\n<agentparty_role member="bob">\nQA\n</agentparty_role>';
blocks = applyEvents(blocks, sid, [{ type: "status", status: "sent", detail: channelDetail }]);
let list = blocks[sid] || [];
assert(list.length === 1 && list[0].kind === "channel", "inbound channel envelope -> a channel block (not status)");
assert(list[0].direction === "in" && list[0].from === "alice" && list[0].to === "bob", "inbound block carries direction=in + from/to");
assert(list[0].text === "Please review PR 42", "inbound block extracts the body (role suffix stripped)");

// Outbound: reproduce Claude's real lifecycle. The start has no arguments, the
// completed invocation has them, and a generic tool_result with the same id
// arrives last.
blocks = applyEvents(blocks, sid, [
  { type: "tool_call", id: "t1", name: "mcp__agentparty-app__send", status: "started", input: {} },
]);
assert(!(blocks[sid] || []).some((b) => b.kind === "channel" && b.direction === "out"), "empty send start does not render a member -> ? card");
blocks = applyEvents(blocks, sid, [
  { type: "tool_call", id: "t1", name: "mcp__agentparty-app__send", status: "completed", input: { to: "carol", content: "ping" } },
  { type: "tool_call", id: "t1", name: "tool_result", status: "completed", result: '{"ok":true}' },
]);
list = blocks[sid] || [];
const outBlocks = list.filter((b) => b.kind === "channel" && b.direction === "out");
assert(outBlocks.length === 1, "outbound send tool_calls fold into exactly one channel block");
assert(outBlocks[0].to === "carol" && outBlocks[0].text === "ping", "outbound block captures to + content from tool input");
assert(outBlocks[0].state === "ok", "successful send marked ok");
assert(!list.some((b) => b.kind === "tool" && b.name === "tool_result"), "terminal tool_result merges into the send card");

// A failed send (recipient offline -> bridge returns ok:false / isError).
blocks = applyEvents(blocks, sid, [
  { type: "tool_call", id: "t2", name: "mcp__agentparty-app__send", status: "completed", input: { to: "ghost", content: "hi" } },
  { type: "tool_call", id: "t2", name: "tool_result", status: "failed", result: '{"ok":false,"error":"not running"}' },
]);
const failedBlock = (blocks[sid] || []).find((b) => b.kind === "channel" && b.to === "ghost");
assert(failedBlock?.state === "failed" && failedBlock.error === "not running", "failed send marked failed with the bridge error");

console.log("\nrestored transcript repair:");
const repaired = normalizeTranscriptBlocks([
  { id: "old1", kind: "channel", direction: "out", from: "", to: "", text: "", at: "10:00" },
  { id: "old1", kind: "channel", direction: "out", from: "", to: "impl", text: "review this", at: "10:00" },
  { id: "old1", kind: "tool", name: "tool_result", status: "completed", result: '{"ok":true}', at: "10:00" },
  { id: "aborted", kind: "channel", direction: "out", from: "", to: "", text: "", at: "10:01" },
  { id: "orphan", kind: "tool", name: "tool_result", status: "completed", result: '{"ok":true}', at: "10:02" },
]);
assert(repaired.length === 1 && repaired[0].kind === "channel", "legacy duplicate/result/empty artifacts collapse to one channel card");
assert(repaired[0].to === "impl" && repaired[0].text === "review this" && repaired[0].state === "ok", "legacy channel keeps its route/body and receives terminal state");

// An ordinary (non-channel) status stays a status block.
blocks = applyEvents(blocks, sid, [{ type: "status", status: "sent", detail: "just a normal message" }]);
const lastBlock = (blocks[sid] || []).at(-1);
assert(lastBlock.kind === "status", "non-channel 'sent' status stays a status block");

console.log("\napplyEvents party-action folding:");
// member-create folds into a create card with role/model/harness from the input.
blocks = applyEvents(blocks, sid, [
  { type: "tool_call", id: "mc1", name: "mcp__agentparty-app__member-create", status: "started", input: {} },
  { type: "tool_call", id: "mc1", name: "mcp__agentparty-app__member-create", status: "completed", input: { name: "qa-bot", role: "테스터", harness: "claude-code", model: "sonnet" } },
  { type: "tool_call", id: "mc1", name: "tool_result", status: "completed", result: '{"ok":true}' },
]);
const createBlocks = (blocks[sid] || []).filter((b) => b.kind === "partyAction" && b.action === "create");
assert(createBlocks.length === 1, "member-create tool_calls fold into one create card");
assert(createBlocks[0].member === "qa-bot" && createBlocks[0].role === "테스터" && createBlocks[0].model === "sonnet" && createBlocks[0].harness === "claude-code", "create card captures member/role/model/harness");
assert(createBlocks[0].state === "ok", "successful create marked ok");

// member-remove folds into a remove card.
blocks = applyEvents(blocks, sid, [{ type: "tool_call", id: "mr1", name: "mcp__agentparty-app__member-remove", status: "completed", input: { name: "qa-bot" }, result: { content: [{ type: "text", text: '{"ok":true}' }] } }]);
const removeBlock = (blocks[sid] || []).find((b) => b.kind === "partyAction" && b.action === "remove");
assert(removeBlock?.member === "qa-bot" && removeBlock.state === "ok", "member-remove -> a remove card for the target");

// A failed create surfaces the bridge error.
blocks = applyEvents(blocks, sid, [{ type: "tool_call", id: "mc2", name: "mcp__agentparty-app__member-create", status: "completed", input: { name: "dupe" }, result: { isError: true, content: [{ type: "text", text: '{"ok":false,"error":"name taken"}' }] } }]);
const failedCreate = (blocks[sid] || []).find((b) => b.kind === "partyAction" && b.member === "dupe");
assert(failedCreate?.state === "failed" && failedCreate.error === "name taken", "failed create marked failed with the bridge error");

// ---- Layer 2: Transcript DOM rendering ------------------------------------
const { Transcript } = await bundle("src/renderer/workbench/Transcript.tsx", "transcript-channel.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const React = await import("react");
const reactDom = await import("react-dom/client");

const view = {
  name: "bob", color: "#888", member: { name: "bob", partyId: "p1", status: "idle", runtime: "claude-code", role: "QA" },
  status: "idle", unread: 0, pendingApproval: false, busy: false, model: "sonnet", effort: "medium", permissionMode: "default",
  transcript: [
    { id: "c1", kind: "channel", direction: "in", from: "alice", to: "bob", text: "Please review PR 42", at: "10:00" },
    { id: "c2", kind: "channel", direction: "out", from: "", to: "carol", text: "ping", state: "ok", at: "10:01" },
    { id: "c3", kind: "channel", direction: "out", from: "", to: "ghost", text: "hi", state: "failed", at: "10:02" },
    { id: "p1", kind: "partyAction", action: "create", member: "qa-bot", role: "테스터", model: "sonnet", harness: "claude-code", state: "ok", at: "10:03" },
    { id: "p2", kind: "partyAction", action: "remove", member: "qa-bot", state: "ok", at: "10:04" },
    { id: "p3", kind: "partyAction", action: "create", member: "dupe", state: "failed", error: "name taken", at: "10:05" },
  ],
};
reactDom.createRoot(document.getElementById("root")).render(React.createElement(Transcript, { view, density: "wide", actions: {} }));
await new Promise((r) => setTimeout(r, 80));

console.log("\nTranscript channel rendering:");
const cards = [...document.querySelectorAll(".wb-channel")];
assert(cards.length === 3, "three channel cards rendered");
const incoming = document.querySelector(".wb-channel.is-in");
assert(Boolean(incoming), "inbound card has is-in class");
const peers = incoming ? [...incoming.querySelectorAll(".wb-channel-peer")].map((n) => n.textContent) : [];
assert(peers[0] === "alice" && peers[1] === "bob", "inbound card shows alice -> bob route");
assert(/Please review PR 42/.test(incoming?.textContent || ""), "inbound card shows the message body");
assert(!/(channel|source=)/.test(incoming?.querySelector(".wb-channel-bubble")?.textContent || ""), "body is not raw channel XML");

const outCard = document.querySelector(".wb-channel.is-out");
const outPeers = outCard ? [...outCard.querySelectorAll(".wb-channel-peer")].map((n) => n.textContent) : [];
assert(outPeers[0] === "bob" && outPeers[1] === "carol", "outbound card shows this member (bob) -> carol");
assert(Boolean(document.querySelector(".wb-channel.is-failed .wb-channel-failed")), "failed send shows a failure note");

console.log("\nParty-action card rendering:");
const actionCards = [...document.querySelectorAll(".wb-party-action")];
assert(actionCards.length === 3, "three party-action cards rendered");
const createCard = document.querySelector(".wb-party-action.is-create");
assert(/멤버 생성/.test(createCard?.textContent || "") && /qa-bot/.test(createCard?.textContent || ""), "create card labels '멤버 생성' + member name");
assert(/테스터/.test(createCard?.textContent || "") && /sonnet/.test(createCard?.textContent || ""), "create card shows role + model");
assert(Boolean(document.querySelector(".wb-party-action.is-remove")) && /멤버 삭제/.test(document.querySelector(".wb-party-action.is-remove")?.textContent || ""), "remove card labels '멤버 삭제'");
assert(/name taken/.test(document.querySelector(".wb-party-action.is-failed")?.textContent || ""), "failed create shows the bridge error");

console.log(failures.length ? `\nCHANNEL RENDER FAILED (${failures.length})` : "\nCHANNEL RENDER PASSED");
process.exit(failures.length ? 1 : 0);
