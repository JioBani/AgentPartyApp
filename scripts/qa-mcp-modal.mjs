/*
 * MCP modal render + interaction (jsdom). Locks the redesigned popup's contract:
 * status cards by state, filter chips + counts, footer stats, per-server actions
 * gated by capability flags, tools disclosure, and that actions fire the right
 * WorkbenchActions calls (route parity with the API is covered by qa-mcp).
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
window.agentParty = { openExternal: () => {} };



const outDir = qaTempDir();
const r = await build({ entryPoints: [path.join(projectRoot, "src/renderer/workbench/McpModal.tsx")], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], write: false });
const bundlePath = path.join(outDir, "mcp-modal.mjs"); writeFileSync(bundlePath, r.outputFiles[0].text);
const { McpModal } = await import(pathToFileURL(bundlePath).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

const snapshot = {
  supported: true, harness: "claude-code",
  note: "인증이 필요한 서버는 대화형 Claude에서 /mcp → Authenticate 로 로그인하세요.",
  servers: [
    { name: "figma", state: "connected", transport: "http", scope: "user", version: "1.0.0", tools: [{ name: "get_doc" }, { name: "create_frame" }], canReconnect: true, canToggle: true, canAuthenticate: false },
    { name: "sentry", state: "needs-auth", transport: "http", scope: "project", error: "Needs authentication", tools: [], canReconnect: true, canToggle: true, canAuthenticate: true },
    { name: "legacy", state: "failed", transport: "stdio", scope: "local", error: "spawn ENOENT", tools: [], canReconnect: true, canToggle: true, canAuthenticate: false },
  ],
};

const calls = [];
const actions = {
  listMcp: async () => snapshot,
  reconnectMcp: async (name, server) => { calls.push(["reconnect", server]); },
  toggleMcp: async (name, server, enabled) => { calls.push(["toggle", server, enabled]); },
  authenticateMcp: async (name, server) => { calls.push(["auth", server]); return { authorizationUrl: `https://auth/${server}` }; },
};
const view = { name: "main", color: "#5b8cff", member: { name: "main", runtime: "claude-code" } };

const tick = (ms = 60) => new Promise((res) => setTimeout(res, ms));
const buttons = () => [...document.querySelectorAll("button")];
const byText = (re) => buttons().find((b) => re.test(b.textContent || ""));
const click = (el) => el?.dispatchEvent(new window.Event("click", { bubbles: true }));

const root = reactDom.createRoot(document.getElementById("root"));
let closed = 0;
root.render(React.createElement(McpModal, { view, actions, onClose: () => { closed += 1; } }));
await tick(120);

console.log("\nrender:");
assert(/MCP 서버/.test(document.querySelector(".mcp-head-name")?.textContent || ""), "header shows 'MCP 서버'");
// [#16] A stray click outside must not dismiss the panel mid-inspection.
document.querySelector(".wb-modal-scrim")?.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
await tick(40);
assert(closed === 0 && Boolean(document.querySelector(".mcp-modal")), "clicking outside does NOT close the MCP panel");
assert(document.querySelectorAll(".mcp-card").length === 3, "renders all 3 server cards");
const states = [...document.querySelectorAll(".mcp-state")].map((s) => s.textContent.trim());
assert(states.some((t) => /연결됨/.test(t)) && states.some((t) => /인증 필요/.test(t)) && states.some((t) => /실패/.test(t)), "state badges: 연결됨 / 인증 필요 / 실패");
assert(Boolean(document.querySelector(".mcp-note")), "harness note banner renders");

console.log("\nfilter chips + footer stats:");
const chips = [...document.querySelectorAll(".mcp-chip")].map((c) => c.textContent.replace(/\s+/g, " ").trim());
assert(chips.some((c) => /전체\s*3/.test(c)) && chips.some((c) => /연결됨\s*1/.test(c)) && chips.some((c) => /실패\s*1/.test(c)) && chips.some((c) => /인증 필요\s*1/.test(c)), "filter chips carry correct counts");
const footer = document.querySelector(".mcp-foot-stats")?.textContent.replace(/\s+/g, " ") || "";
assert(/3개 서버/.test(footer) && /연결 1/.test(footer) && /실패 1/.test(footer) && /인증 1/.test(footer) && /도구 2개/.test(footer), "footer stats: servers/connected/failed/auth/tools");

console.log("\ncapability-gated actions:");
// figma (connected, canAuthenticate:false) → 재연결 present, 인증하기 absent
const figmaCard = [...document.querySelectorAll(".mcp-card")].find((c) => /figma/.test(c.textContent));
const sentryCard = [...document.querySelectorAll(".mcp-card")].find((c) => /sentry/.test(c.textContent));
assert(![...figmaCard.querySelectorAll("button")].some((b) => /인증하기/.test(b.textContent)), "connected server shows NO 인증하기 (canAuthenticate=false)");
assert([...sentryCard.querySelectorAll("button")].some((b) => /인증하기/.test(b.textContent)), "needs-auth server shows 인증하기 (canAuthenticate=true)");

// click reconnect on figma
click([...figmaCard.querySelectorAll("button")].find((b) => /재연결/.test(b.textContent)));
await tick(80);
assert(calls.some(([a, s]) => a === "reconnect" && s === "figma"), "clicking 재연결 calls reconnectMcp(figma)");

// authenticate on sentry
click([...sentryCard.querySelectorAll("button")].find((b) => /인증하기/.test(b.textContent)));
await tick(80);
assert(calls.some(([a, s]) => a === "auth" && s === "sentry"), "clicking 인증하기 calls authenticateMcp(sentry)");
assert(Boolean(document.querySelector(".mcp-banner.is-auth")), "authorization URL banner appears after authenticate");

console.log("\ntools disclosure + filter:");
click(figmaCard.querySelector(".mcp-tools"));
await tick(60);
assert(document.querySelectorAll(".mcp-tool-chip").length >= 2, "expanding tools reveals tool chips");
// filter to failed
click(byText(/^\s*실패\s*1/));
await tick(60);
assert(document.querySelectorAll(".mcp-card").length === 1 && /legacy/.test(document.querySelector(".mcp-card").textContent), "filter '실패' narrows to the failed server");

root.unmount();
console.log(failures.length ? `\nMCP MODAL FAILED (${failures.length})` : "\nMCP MODAL PASSED");
process.exit(failures.length ? 1 : 0);
