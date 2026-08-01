/*
 * Context donut + Auto-compact dialog render test (jsdom). Locks the redesigned
 * compaction UI from design_handoff_auto_compact: the donut is a ring (not a bar)
 * that opens the dialog on click and draws a threshold tick only when auto-compact
 * is on; the dialog carries the current-usage card, the enable toggle, the 50–95
 * threshold slider, and a footer with "지금 압축 실행" beside "완료". Behavioural
 * bounds/inheritance are covered by qa-auto-compact.mjs; this locks the DOM.
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
def("getComputedStyle", window.getComputedStyle.bind(window));
def("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); def("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;

const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });
async function load(entry, name, names) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], write: false });
  const file = path.join(outDir, name); writeFileSync(file, r.outputFiles[0].text);
  const mod = await import(pathToFileURL(file).href);
  return names.reduce((acc, k) => (acc[k] = mod[k], acc), {});
}
const { ContextDonut } = await load("src/renderer/workbench/ContextDonut.tsx", "ctx-donut.mjs", ["ContextDonut"]);
const { CompactModal } = await load("src/renderer/workbench/AutoCompactEditor.tsx", "compact-modal.mjs", ["CompactModal"]);
const React = await import("react");
const reactDom = await import("react-dom/client");

function render(node) {
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const root = reactDom.createRoot(host);
  root.render(node);
  return host;
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

function view(overrides = {}) {
  return {
    name: "backend",
    color: "#5b8cff",
    session: { id: "s1", snapshot: {} },
    member: { name: "backend", lastContextWindow: 200000 },
    context: { used: 130000, total: 200000 },
    autoCompact: { on: true, at: 65 },
    compacting: false,
    ...overrides,
  };
}

// ---- Context donut -------------------------------------------------------
console.log("\ncontext donut (ring, tick, click):");
{
  let opened = 0;
  const v = view();
  const host = render(React.createElement(ContextDonut, { context: v.context, autoCompact: v.autoCompact, color: v.color, showRange: true, onClick: () => { opened += 1; } }));
  await flush();
  const btn = host.querySelector(".wb-ctx-donut");
  assert(!!btn, "renders a donut button");
  assert(!!host.querySelector(".wb-donut-ring"), "has the conic ring element (not a bar)");
  assert(host.querySelector(".wb-donut-pct")?.textContent === "65%", "shows the % readout (65%)");
  assert(/130K \/ 200K/.test(host.querySelector(".wb-donut-range")?.textContent || ""), "shows the K/K range when wide");
  const tickWrap = host.querySelector(".wb-donut-tick-wrap");
  assert(!!tickWrap && /rotate\(234deg\)/.test(tickWrap.getAttribute("style") || ""), "threshold tick sits at at×3.6° (65 → 234deg)");
  click(btn); await flush();
  assert(opened === 1, "clicking the donut opens the dialog");
}
{
  // Auto-compact OFF → no zone, no tick.
  const v = view({ autoCompact: { on: false, at: 65 } });
  const host = render(React.createElement(ContextDonut, { context: v.context, autoCompact: v.autoCompact, color: v.color, showRange: false, onClick() {} }));
  await flush();
  assert(!host.querySelector(".wb-donut-tick-wrap"), "no threshold tick when auto-compact is off");
  assert(!host.querySelector(".wb-donut-range"), "K/K range hidden when not wide");
}

// ---- Auto-compact dialog -------------------------------------------------
console.log("\nauto-compact dialog (usage card, toggle, slider, footer):");
{
  const calls = [];
  const actions = { setAutoCompact: (n, s) => calls.push(["set", n, s]), compact: (n) => calls.push(["compact", n]) };
  let closed = 0;
  const host = render(React.createElement(CompactModal, { view: view(), actions, onClose: () => { closed += 1; } }));
  await flush();
  const text = host.textContent || "";
  assert(text.includes("현재 컨텍스트 사용량"), "shows the current-usage card");
  assert(/130K \/ 200K/.test(host.querySelector(".wb-compact-usage-val")?.textContent || ""), "usage card shows used / total");
  assert(text.includes("· 65%"), "usage card shows the live percentage");
  assert(!!host.querySelector(".wb-compact-usage-th"), "usage bar draws the threshold line (auto-compact on)");
  assert(text.includes("임계치 초과 시 자동 압축"), "has the enable toggle");
  const slider = host.querySelector(".wb-compact-thcard .wb-compact-range");
  assert(!!slider, "threshold slider present when enabled");
  assert(slider?.getAttribute("min") === "10" && slider?.getAttribute("max") === "95" && slider?.getAttribute("step") === "1", "slider band is 10–95 step 1 (same as the Runtime editor)");
  const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent);
  assert(buttons.some((t) => /지금 압축 실행/.test(t)), "footer has '지금 압축 실행'");
  assert(buttons.some((t) => /완료/.test(t)), "footer has '완료'");

  // [#16] A drag on the threshold slider regularly ends outside the dialog; that
  // must not dismiss it mid-adjustment.
  document.querySelector(".wb-modal-scrim")?.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
  await flush();
  assert(closed === 0 && !!host.querySelector(".wb-compact-dialog"), "clicking outside does NOT close the dialog");

  // Run-now fires a compaction AND closes.
  const runNow = [...host.querySelectorAll("button")].find((b) => /지금 압축 실행/.test(b.textContent));
  click(runNow); await flush();
  assert(calls.some((c) => c[0] === "compact" && c[1] === "backend"), "'지금 압축 실행' calls actions.compact(member)");
  assert(closed === 1, "'지금 압축 실행' closes the dialog");
}
{
  // Toggle OFF → no slider card; run-now disabled without a live session.
  const host = render(React.createElement(CompactModal, { view: view({ autoCompact: { on: false, at: 65 }, session: undefined }), actions: { setAutoCompact() {}, compact() {} }, onClose() {} }));
  await flush();
  assert(!host.querySelector(".wb-compact-thcard"), "no threshold card when auto-compact is off");
  const runNow = [...host.querySelectorAll("button")].find((b) => /지금 압축 실행/.test(b.textContent));
  assert(runNow?.disabled === true, "'지금 압축 실행' disabled with no live session (nothing to compact)");
}

console.log(failures.length ? `\nCOMPACT DIALOG FAILED (${failures.length})` : "\nCOMPACT DIALOG PASSED");
process.exit(failures.length ? 1 : 0);
