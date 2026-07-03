/*
 * Codex diagnostics — no silent fallback (Item 5). Three layers:
 *   1. classifyDiagnostic (pure): reroute/rate-limit/guardian/config/deprecation/
 *      sandbox/mcp notifications → severity + category (+ recovery for sandbox);
 *      noisy rolling rate-limit ticks and healthy MCP status return null.
 *   2. transcriptEvents + memberStatus: a diagnostic event becomes a diagnostic
 *      block; latestDiagnostic picks the most severe recent one for the header.
 *   3. Transcript DOM: severity-colored banner with title/detail/recovery.
 */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const def = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
def("window", window); def("document", window.document); def("HTMLElement", window.HTMLElement);
def("crypto", window.crypto?.randomUUID ? window.crypto : { randomUUID: () => "id-" + Math.random().toString(16).slice(2) });
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); def("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;

const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });
async function bundle(entry, name, external = []) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external, write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}

// ---- Layer 1: classifier ----------------------------------------------------
const { classifyDiagnostic } = await bundle("src/shared/codexDiagnostics.ts", "codex-diag.mjs", []);
console.log("\nclassifyDiagnostic:");
const reroute = classifyDiagnostic("model/rerouted", { fromModel: "gpt-5.4", toModel: "gpt-5.4-mini", reason: "highRiskCyberActivity" });
assert(reroute.severity === "warning" && reroute.category === "reroute", "model/rerouted → warning/reroute (never silent)");
assert(reroute.title.includes("gpt-5.4-mini") && reroute.detail.includes("gpt-5.4 → gpt-5.4-mini"), "reroute shows from→to");
assert(classifyDiagnostic("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 20 } } }) === null, "low rate-limit tick is NOT surfaced (no noise)");
const rl = classifyDiagnostic("account/rateLimits/updated", { rateLimits: { limitName: "weekly", primary: { usedPercent: 96 } } });
assert(rl?.severity === "warning" && rl.category === "rate-limit", "near-exhausted rate-limit → warning");
const rlHit = classifyDiagnostic("account/rateLimits/updated", { rateLimits: { rateLimitReachedType: "hard", primary: { usedPercent: 100 } } });
assert(rlHit?.severity === "error", "rate-limit reached → error");
assert(classifyDiagnostic("guardianWarning", { message: "위험" }).category === "guardian", "guardianWarning → guardian");
assert(classifyDiagnostic("configWarning", { summary: "bad config" }).title === "bad config", "configWarning uses its summary");
assert(classifyDiagnostic("deprecationNotice", { summary: "old flag" }).severity === "info", "deprecationNotice → info");
const sandboxWarn = classifyDiagnostic("warning", { message: "sandbox is read-only" });
assert(sandboxWarn.category === "sandbox" && sandboxWarn.recovery?.includes("/codex-fix-sandbox"), "sandbox warning gets a recovery hint");
assert(classifyDiagnostic("warning", { message: "일반 경고" }).category === "other", "plain warning → other");
assert(classifyDiagnostic("windows/worldWritableWarning", { path: "C:/x" }).recovery?.includes("/codex-fix-sandbox"), "world-writable warning → sandbox recovery");
assert(classifyDiagnostic("mcpServer/startupStatus/updated", { server: "brave", status: "running" }) === null, "healthy MCP status is NOT surfaced");
assert(classifyDiagnostic("mcpServer/startupStatus/updated", { server: "brave", status: "failed", error: "boom" }).severity === "error", "failed MCP status → error");

// ---- Layer 2: pipeline + header helper --------------------------------------
const T = await bundle("src/renderer/app/transcriptEvents.ts", "codex-diag-events.mjs", []);
const M = await bundle("src/renderer/workbench/memberStatus.ts", "codex-diag-status.mjs", []);
console.log("\ntranscriptEvents + latestDiagnostic:");
let blocks = T.applyEvents({}, "s1", [
  { type: "diagnostic", severity: "info", category: "deprecation", title: "old flag" },
  { type: "diagnostic", severity: "warning", category: "reroute", title: "rerouted", detail: "a → b" },
  { type: "diagnostic", severity: "error", category: "rate-limit", title: "limit reached" },
])["s1"];
assert(blocks.filter((b) => b.kind === "diagnostic").length === 3, "each diagnostic event becomes a block (nothing dropped)");
const worst = M.latestDiagnostic(blocks);
assert(worst.severity === "error" && worst.category === "rate-limit", "latestDiagnostic picks the most severe recent one");

// ---- Layer 3: Transcript DOM ------------------------------------------------
const { Transcript } = await bundle("src/renderer/workbench/Transcript.tsx", "codex-diag-transcript.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const React = await import("react");
const reactDom = await import("react-dom/client");
const mount = (el) => { const host = document.createElement("div"); document.body.appendChild(host); reactDom.createRoot(host).render(el); return host; };
const settle = () => new Promise((r) => setTimeout(r, 60));

console.log("\nTranscript DOM:");
const view = {
  name: "codey", color: "#888", member: { name: "codey", runtime: "codex" }, status: "idle", unread: 0, pendingApproval: false, busy: false, model: "x", effort: "medium", permissionMode: "default",
  transcript: [
    { id: "d1", kind: "diagnostic", severity: "warning", category: "reroute", title: "모델이 gpt-5.4-mini로 라우팅됨", detail: "gpt-5.4 → gpt-5.4-mini" },
    { id: "d2", kind: "diagnostic", severity: "warning", category: "sandbox", title: "샌드박스 경고", detail: "read-only", recovery: "/codex-fix-sandbox 로 복구하세요." },
  ],
};
const host = mount(React.createElement(Transcript, { view, density: "wide", actions: {} }));
await settle();
assert(host.querySelectorAll(".wb-diagnostic").length === 2, "both diagnostics render as banners");
assert(Boolean(host.querySelector(".wb-diagnostic.is-warning")), "severity drives the banner style");
assert(host.textContent.includes("gpt-5.4 → gpt-5.4-mini"), "reroute detail shown");
assert(Boolean(host.querySelector(".wb-diagnostic-recovery")) && host.textContent.includes("/codex-fix-sandbox"), "sandbox recovery hint rendered");

console.log(failures.length ? `\nCODEX DIAGNOSTICS FAILED (${failures.length})` : "\nCODEX DIAGNOSTICS PASSED");
process.exit(failures.length ? 1 : 0);
