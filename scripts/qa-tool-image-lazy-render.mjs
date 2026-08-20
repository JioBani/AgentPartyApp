/* Regression: ordinary tool-result images mount only after disclosure opens. */
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "ok" : "FAIL"}: ${message}`);
  if (!condition) failures.push(message);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const { window } = dom;
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define("window", window);
define("document", window.document);
define("HTMLElement", window.HTMLElement);
define("getComputedStyle", window.getComputedStyle.bind(window));
define("requestAnimationFrame", (callback) => setTimeout(() => callback(Date.now()), 0));
define("cancelAnimationFrame", clearTimeout);
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
define("ResizeObserver", window.ResizeObserver);

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const imageReads = [];
window.agentParty = {
  getTranscriptImage: async (file) => {
    imageReads.push(file);
    return { ok: true, dataUrl: PNG_DATA_URL, bytes: 68 };
  },
};

const bundled = await build({
  entryPoints: [path.join(root, "src/renderer/workbench/Transcript.tsx")],
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"development"' },
  external: ["node:path", "react", "react-dom", "react-dom/client", "react/jsx-runtime"],
  write: false,
});
const output = path.join(qaTempDir(), "tool-image-lazy-render.mjs");
writeFileSync(output, bundled.outputFiles[0].text);
const { Transcript } = await import(pathToFileURL(output).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

const storedImage = {
  type: "image",
  source: { type: "agentparty-file", file: "visual-check.png", media_type: "image/png", bytes: 68 },
};
const view = {
  name: "viewer",
  color: "#888",
  member: { name: "viewer", partyId: "p1", status: "idle", runtime: "codex", role: "" },
  status: "idle",
  unread: 0,
  pendingApproval: false,
  busy: false,
  model: "gpt-5.4",
  effort: "medium",
  permissionMode: "default",
  transcript: [{
    id: "exec-with-image",
    kind: "tool",
    name: "exec",
    status: "completed",
    input: { command: "tools.view_image(...)" },
    result: [{ type: "text", text: "visual-check.png" }, storedImage],
  }],
};

const reactRoot = reactDom.createRoot(document.getElementById("root"));
reactRoot.render(React.createElement(Transcript, { view, density: "wide", detail: "full", actions: {} }));
await delay(120);

console.log("\nCollapsed ordinary tool image:");
const disclosure = document.querySelector("details.wb-tool");
assert(Boolean(disclosure), "the exec result remains an ordinary disclosure");
assert(disclosure?.open === false, "an image-bearing exec is collapsed even in a wide workbench");
assert(document.querySelectorAll("img.wb-tool-image").length === 0, "no image element mounts while collapsed");
assert(imageReads.length === 0, "collapsed stored images perform no renderer-to-main file read");

disclosure.open = true;
disclosure.dispatchEvent(new window.Event("toggle", { bubbles: false }));
await delay(120);

console.log("\nOpened ordinary tool image:");
assert(imageReads.length === 1 && imageReads[0] === "visual-check.png", "opening starts exactly one stored-image read");
assert(document.querySelectorAll("img.wb-tool-image").length === 1, "the image mounts after the disclosure opens");

disclosure.open = false;
disclosure.dispatchEvent(new window.Event("toggle", { bubbles: false }));
await delay(60);
assert(document.querySelectorAll("img.wb-tool-image").length === 0, "closing unmounts the image and releases its display payload");

console.log(failures.length ? `\nTOOL IMAGE LAZY RENDER FAILED (${failures.length})` : "\nTOOL IMAGE LAZY RENDER PASSED");
process.exit(failures.length ? 1 : 0);
