/* Repro: select a NON-default model (Kimi K2.6) in the wizard with the REAL
 * catalog routes and check the onCreate payload model. Diagnoses the
 * "created with kimi but connects to sonnet" report. */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;
const define = (n, v) => { try { Object.defineProperty(globalThis, n, { value: v, configurable: true, writable: true }); } catch {} };
define("window", window); define("document", window.document); define("HTMLElement", window.HTMLElement);
define("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0)); define("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }; globalThis.ResizeObserver = window.ResizeObserver;

const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });
async function bundle(entry, name, external = []) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, external, write: false });
  const p = path.join(outDir, name); writeFileSync(p, r.outputFiles[0].text); return import(pathToFileURL(p).href);
}
const { buildModelRoutes } = await bundle("src/core/modelRegistry.ts", "mr-repro.mjs", []);
const { MemberWizard } = await bundle("src/renderer/workbench/MemberWizard.tsx", "mw-repro.mjs", ["react", "react-dom", "react-dom/client", "react/jsx-runtime"]);
const React = await import("react");
const reactDom = await import("react-dom/client");

const routes = buildModelRoutes("sonnet", [], []);
console.log("first 4 routes:", routes.slice(0, 4).map((r) => r.model));
console.log("has Kimi K2.6:", routes.some((r) => r.model === "Kimi K2.6"));

let created = null;
reactDom.createRoot(document.getElementById("root")).render(React.createElement(MemberWizard, { routes, onCancel: () => {}, onCreate: (i) => { created = i; } }));
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
await tick(80);
const all = (s) => [...document.querySelectorAll(s)];
const click = (el) => el?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const setInput = (el, v) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const setTextarea = (el, v) => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set.call(el, v); el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const next = () => all(".wb-wizard-foot .wb-btn-accent")[0];

setInput(document.querySelector(".wb-wizard-input"), "test21"); await tick(30); click(next()); await tick(40); // name
click(next()); await tick(40); // harness (claude-code default)
// model step — click Kimi K2.6
const kimiRow = all(".wb-model-row").find((r) => r.textContent.includes("Kimi K2.6"));
console.log("kimi row found:", Boolean(kimiRow));
click(kimiRow); await tick(50);
const detail = document.querySelector(".wb-wizard-model-detail")?.textContent || "";
console.log("detail after click shows:", detail.replace(/\s+/g, " ").slice(0, 60));
click(next()); await tick(40); // reasoning
click(next()); await tick(40); // role
setTextarea(document.querySelector(".wb-wizard-textarea"), "QA"); await tick(30);
click(next()); await tick(60); // create

console.log("\n>>> onCreate payload model:", JSON.stringify(created?.model), "| reasoning:", JSON.stringify(created?.reasoning));
console.log(created?.model === "Kimi K2.6" ? "OK — kimi captured" : `BUG — expected 'Kimi K2.6', got '${created?.model}'`);
process.exit(0);
