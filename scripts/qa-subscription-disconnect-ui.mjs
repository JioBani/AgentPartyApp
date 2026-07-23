import { build } from "esbuild";
import { JSDOM } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "node_modules", ".qa", "subscription-disconnect-ui.mjs");
fs.mkdirSync(path.dirname(out), { recursive: true });
await build({
  entryPoints: [path.join(root, "src", "renderer", "app", "secondaryViews.tsx")],
  bundle: true,
  format: "esm",
  platform: "node",
  packages: "external",
  outfile: out,
  logLevel: "silent",
});

const dom = new JSDOM("<div id=\"root\"></div>", { url: "http://localhost/", pretendToBeVisual: true });
Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { AuthView } = await import(`${pathToFileURL(out).href}?v=${Date.now()}`);
let disconnected = 0;
const auth = [
  { id: "codex", label: "Codex", kind: "subscription", status: "available", description: "connected" },
  { id: "openrouter", label: "OpenRouter", kind: "apiKey", status: "missing", description: "optional" },
];
const rootNode = createRoot(document.getElementById("root"));

await act(async () => {
  rootNode.render(React.createElement(AuthView, {
    auth,
    draft: "",
    onDraft() {},
    onSave() {},
    onTest() {},
    onConnectSubscription() {},
    async onDisconnectSubscription(provider) {
      if (provider === "codex") disconnected += 1;
    },
  }));
});
const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "연결 끊기");
assert(button, "connected Codex row exposes the disconnect button");

await act(async () => button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
assert(disconnected === 0 && button.textContent?.includes("정말 연결 끊기"), "first click arms an explicit confirmation");

await act(async () => button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
assert(disconnected === 1, "confirmed second click invokes Codex disconnect");

await act(async () => rootNode.unmount());
console.log("SUBSCRIPTION DISCONNECT UI QA PASSED");

function assert(value, message) {
  if (!value) throw new Error(`Assertion failed: ${message}`);
  console.log(`  ok: ${message}`);
}
