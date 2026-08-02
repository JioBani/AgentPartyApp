/*
 * Transcript image copy + enlarge (R-18 / R-19, jsdom).
 *
 * The earlier [P-3]9 wiring put copy on the composer attachment strip — wrong
 * target. These assertions lock the correct surface: an image that stayed in
 * the transcript can be copied to the clipboard and opened in the shared
 * "전체 보기" overlay (fit / actual size), which closes only via ✕ / Escape.
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

const copies = [];
let failNext = false;
window.agentParty = {
  copyImageToClipboard: async (image) => {
    if (failNext) { failNext = false; throw new Error("클립보드를 사용할 수 없습니다"); }
    copies.push(image);
    return { ok: true, width: 1, height: 1, bytes: 70 };
  },
};

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const GIF_B64 = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";



const outDir = qaTempDir();
const r = await build({
  entryPoints: [path.join(projectRoot, "src/renderer/workbench/Transcript.tsx")],
  bundle: true, format: "esm", platform: "browser", jsx: "automatic", loader: { ".css": "empty" },
  define: { "process.env.NODE_ENV": '"development"' },
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"], write: false,
});
const bp = path.join(outDir, "transcript-image.mjs"); writeFileSync(bp, r.outputFiles[0].text);
const { Transcript } = await import(pathToFileURL(bp).href);
const React = await import("react");
const reactDom = await import("react-dom/client");

const view = {
  name: "r", color: "#888",
  member: { name: "r", partyId: "p1", status: "idle", runtime: "claude-code", role: "" },
  status: "idle", unread: 0, pendingApproval: false, busy: false, model: "sonnet", effort: "medium", permissionMode: "default",
  transcript: [
    {
      id: "u1", kind: "user", text: "봐줘", at: "10:00",
      attachments: [
        { kind: "image", mediaType: "image/png", dataBase64: PNG_B64, name: "a.png" },
        { kind: "image", mediaType: "image/gif", dataBase64: GIF_B64, name: "b.gif" },
        { kind: "image", mediaType: "image/png", name: "gone.png" },
      ],
    },
  ],
};

reactDom.createRoot(document.getElementById("root")).render(React.createElement(Transcript, { view, density: "wide", actions: {} }));
await new Promise((res) => setTimeout(res, 120));

console.log("\nTranscript images (R-18 / R-19):");
assert(document.querySelectorAll(".wb-msg-image").length === 2, "bytes가 있는 이미지는 썸네일로 보인다");
assert(document.querySelectorAll(".wb-msg-image-stub").length === 1, "바이트가 없는 이미지는 stub 라벨이다");
assert(document.querySelectorAll(".wb-msg-image-wrap .wb-msg-image-copy").length === 2, "대화 이미지마다 복사 버튼이 있다");
assert(document.querySelectorAll(".wb-msg-image-hit").length === 2, "이미지를 눌러 크게 볼 수 있다");

const copyButtons = [...document.querySelectorAll(".wb-msg-image-wrap .wb-msg-image-copy")];
copyButtons[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 80));
assert(copies.length === 1, "복사 버튼이 클립보드 브리지를 호출한다");
assert(copies[0]?.mediaType === "image/gif" && copies[0]?.dataBase64 === GIF_B64, "2번째 이미지를 누르면 2번째가 복사된다");
assert(copyButtons[1].getAttribute("data-copy-state") === "copied", "복사 성공이 시각적으로 표시된다");

failNext = true;
copyButtons[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 80));
assert(!!document.querySelector(".wb-msg-image-error"), "복사 실패가 화면에 드러난다 (조용한 실패 금지)");
assert(copies.length === 1, "실패한 복사는 브리지에 남지 않는다");

console.log("\nEnlarge overlay:");
assert(!document.querySelector(".wb-tool-modal"), "크게 보기 전에는 오버레이가 없다");
document.querySelector(".wb-msg-image-hit").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
const modal = document.querySelector(".wb-tool-modal");
assert(Boolean(modal), "이미지 클릭이 전체 보기 오버레이를 연다");
assert(modal.classList.contains("is-wide"), "이미지용으로 넓은 셸을 쓴다");
assert(Boolean(document.querySelector(".wb-image-viewer.is-fit")), "기본은 화면에 맞춤");
const zoom = document.querySelector("[data-image-zoom]");
assert(zoom?.getAttribute("data-image-zoom") === "fit", "맞춤/실제크기 토글이 있다");
zoom.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 20));
assert(Boolean(document.querySelector(".wb-image-viewer.is-actual")), "토글하면 실제 크기로 바뀐다");

document.querySelector(".wb-tool-modal-backdrop")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
assert(Boolean(document.querySelector(".wb-tool-modal")), "바깥 클릭으로는 닫히지 않는다");

window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
assert(!document.querySelector(".wb-tool-modal"), "Esc 로 닫힌다");

document.querySelector(".wb-msg-image-hit").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
document.querySelector(".wb-tool-modal-head .wb-icon-btn[aria-label='닫기']")
  ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await new Promise((res) => setTimeout(res, 40));
assert(!document.querySelector(".wb-tool-modal"), "✕ 로도 닫힌다");

console.log(failures.length ? `\nTRANSCRIPT IMAGE FAILED (${failures.length})` : "\nTRANSCRIPT IMAGE PASSED");
process.exit(failures.length ? 1 : 0);
