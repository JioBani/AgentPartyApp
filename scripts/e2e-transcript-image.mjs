/*
 * Full-process e2e for transcript image copy + enlarge (R-18 / R-19) — OFFLINE
 * (mock member, no model). Sends a real user turn with an image attachment,
 * then drives the transcript controls through the live renderer (CDP).
 *
 * Step 0 asserts runtime.appRoot is THIS worktree on a path boundary
 * (docs/E2E_TESTING.md §1b). Never kills foreign electron processes.
 *
 * Run: npm run test:e2e:transcript-image
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-transcript-image-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-transcript-image-e2e-user-data");
const shotDir = path.join(os.tmpdir(), "agentparty-transcript-image-shots");

let base = "";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_AUTOMATION_PORT: "",
    },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  let cdp;
  try {
    base = await discover();
    assert((await get("/api/health")).ok, `app is up at ${base}`);

    // Step 0 — boundary compare (AgentPartyApp is a prefix of AgentPartyApp-n2).
    const appRoot = (await get("/api/state")).runtime?.appRoot || "";
    const within = (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
    assert(Boolean(appRoot) && within, `running build is THIS worktree (appRoot=${appRoot || "<missing>"})`);
    const windows = (await get("/api/windows")).windows || [];
    assert(windows[0]?.workspacePath?.toLowerCase() === ws.toLowerCase(), `window serves the e2e workspace (${windows[0]?.workspacePath})`);

    await post("/api/qa/seed", {
      party: "transcript image e2e",
      members: [{ name: "worker", model: "claude-sonnet-4.5", role: "img", autoReply: false }],
    });
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["worker"]] });
    await delay(600);

    // Attachments only echo into the transcript on the UI send path — HTTP
    // /message does not paint them. Drive the real composer: drop an image,
    // send it, then exercise copy + enlarge on what stayed in the conversation.
    cdp = await attachRenderer();
    const pngB64 = smallPng(32, 24).toString("base64");
    const dropped = await cdp.eval(`(() => {
      const form = document.querySelector("form.wb-composer");
      if (!form) return { ok: false, reason: "no composer" };
      const bytes = Uint8Array.from(atob(${JSON.stringify(pngB64)}), (c) => c.charCodeAt(0));
      const file = new File([bytes], "shot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      form.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { ok: true };
    })()`);
    await delay(500);
    const attachCount = await cdp.eval(`document.querySelectorAll(".wb-attachment img").length`);
    assert(dropped.ok && attachCount >= 1, `입력창에 이미지가 첨부됐다 (ok=${dropped.ok}, thumbs=${attachCount})`);
    assert((await cdp.eval(`document.querySelectorAll(".wb-attachment-copy").length`)) === 0, "입력창 첨부 복사 버튼은 없다");

    await post("/api/qa/input", { selector: ".wb-composer-editor", text: "이 이미지 확인해줘", key: "Enter", modifiers: ["control"] });
    await delay(1500);

    const present = await cdp.eval(`({
      thumbs: document.querySelectorAll(".wb-msg-image").length,
      copies: document.querySelectorAll(".wb-msg-image-wrap .wb-msg-image-copy").length,
      text: [...document.querySelectorAll(".wb-user-bubble")].map((el) => el.textContent).join(" | "),
    })`);
    assert(present.thumbs >= 1, `대화에 이미지가 보인다 (${JSON.stringify(present)})`);
    assert(present.copies >= 1, `대화 이미지에 복사 버튼이 있다 (${present.copies})`);

    await cdp.eval(`document.querySelector(".wb-msg-image-hit")?.click()`);
    await delay(200);
    let overlay = await cdp.eval(`({
      open: !!document.querySelector(".wb-tool-modal"),
      wide: !!document.querySelector(".wb-tool-modal.is-wide"),
      imageViewer: !!document.querySelector(".wb-tool-modal.is-image-viewer"),
      fit: !!document.querySelector(".wb-image-viewer.is-fit"),
      zoom: document.querySelector("[data-image-zoom]")?.getAttribute("data-image-zoom") || null,
      portal: document.querySelector(".wb-tool-modal-backdrop")?.parentElement?.matches("[data-workbench-overlay-root]") || false,
      geometry: (() => {
        const backdrop = document.querySelector(".wb-tool-modal-backdrop")?.getBoundingClientRect();
        const modal = document.querySelector(".wb-tool-modal")?.getBoundingClientRect();
        const workarea = document.querySelector(".wb-workarea")?.getBoundingClientRect();
        const panel = document.querySelector(".wb-panel")?.getBoundingClientRect();
        return {
          viewport: [innerWidth, innerHeight],
          workarea: workarea && [Math.round(workarea.left), Math.round(workarea.top), Math.round(workarea.right), Math.round(workarea.bottom)],
          panel: panel && [Math.round(panel.left), Math.round(panel.top), Math.round(panel.right), Math.round(panel.bottom)],
          backdrop: backdrop && [Math.round(backdrop.left), Math.round(backdrop.top), Math.round(backdrop.right), Math.round(backdrop.bottom)],
          modal: modal && [Math.round(modal.left), Math.round(modal.top), Math.round(modal.right), Math.round(modal.bottom)],
        };
      })(),
    })`);
    assert(overlay.open && overlay.wide && overlay.imageViewer && overlay.fit && overlay.portal, `크게 보기 오버레이가 창 전체 포털에서 맞춤으로 열린다 (${JSON.stringify(overlay)})`);
    assert(
      JSON.stringify(overlay.geometry?.backdrop) === JSON.stringify(overlay.geometry?.workarea) &&
        overlay.geometry?.backdrop?.[0] > 0 &&
        overlay.geometry?.backdrop?.[2] - overlay.geometry?.backdrop?.[0] > overlay.geometry?.panel?.[2] - overlay.geometry?.panel?.[0],
      `이미지 배경이 사이드바를 비우고 전체 탭 작업영역을 덮는다 (${JSON.stringify(overlay.geometry)})`,
    );
    assert(
      overlay.geometry?.modal?.[0] === overlay.geometry?.workarea?.[0] + 12 &&
        overlay.geometry?.modal?.[1] === overlay.geometry?.workarea?.[1] + 12 &&
        overlay.geometry?.modal?.[2] === overlay.geometry?.workarea?.[2] - 12 &&
        overlay.geometry?.modal?.[3] === overlay.geometry?.workarea?.[3] - 12,
      `이미지 보기가 탭 작업영역을 12px 안쪽까지 사용한다 (${JSON.stringify(overlay.geometry?.modal)})`,
    );
    await post("/api/capture", { path: path.join(shotDir, "transcript-image-window-overlay.png") });

    await cdp.eval(`document.querySelector("[data-image-zoom]")?.click()`);
    await delay(100);
    overlay = await cdp.eval(`({
      actual: !!document.querySelector(".wb-image-viewer.is-actual"),
      zoom: document.querySelector("[data-image-zoom]")?.getAttribute("data-image-zoom") || null,
    })`);
    assert(overlay.actual && overlay.zoom === "actual", `실제 크기 토글이 동작한다 (${JSON.stringify(overlay)})`);

    await cdp.eval(`document.querySelector(".wb-tool-modal-backdrop")?.dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
    await delay(100);
    assert(await cdp.eval(`!!document.querySelector(".wb-tool-modal")`), "바깥 클릭으로 닫히지 않는다");

    await cdp.eval(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await delay(100);
    assert(!(await cdp.eval(`!!document.querySelector(".wb-tool-modal")`)), "Esc 로 닫힌다");

    // Same AppController route the transcript copy button uses.
    const clip = await post("/api/clipboard/image", { mediaType: "image/png", dataBase64: pngB64 });
    assert(clip.ok && clip.width === 32 && clip.height === 24, `클립보드 API가 이미지를 받는다 (${clip.width}x${clip.height})`);

    const shot = path.join(shotDir, "transcript-image.png");
    const cap = await post("/api/capture", { path: shot });
    assert(cap.ok && cap.bytes > 0, `캡처 → ${shot} (${cap.bytes}B)`);

    console.log(failures.length ? `\nE2E TRANSCRIPT IMAGE FAILED (${failures.length})` : "\nE2E TRANSCRIPT IMAGE PASSED");
  } finally {
    killProcessTree(child.pid);
    await waitForExit(child);
  }
  process.exit(failures.length ? 1 : 0);
}

async function discover() {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const url = firstBaseUrl(ws);
    if (url) {
      try {
        const response = await fetch(`${url}/api/health`);
        if (response.ok && (await response.json()).ok) return url;
      } catch { /* still starting */ }
    }
    await delay(500);
  }
  throw new Error("App did not advertise an automation endpoint for the e2e workspace.");
}

async function attachRenderer() {
  const { WebSocket } = await import("ws");
  const portFile = path.join(userData, "DevToolsActivePort");
  const started = Date.now();
  let port = 0;
  while (Date.now() - started < 30_000) {
    try {
      port = Number(fs.readFileSync(portFile, "utf8").split("\n")[0].trim());
      if (port > 0) break;
    } catch { /* not written yet */ }
    await delay(250);
  }
  if (!port) throw new Error(`Electron never wrote ${portFile} — was --remote-debugging-port passed?`);

  let target;
  while (Date.now() - started < 30_000) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
    if (target) break;
    await delay(250);
  }
  if (!target) throw new Error("No debuggable renderer page target found.");

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("CDP websocket failed to open."));
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (entry) { pending.delete(msg.id); entry(msg); }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    async eval(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(`Renderer evaluation threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      }
      return result.result.value;
    },
  };
}

async function get(route) {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function post(route, body) {
  const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}

async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) return;
      await delay(300);
    }
  }
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { killProcessTree(child.pid); resolve(); }, 10_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
}


/** A valid opaque-red RGBA PNG of the given size (Electron rejects undecodable bytes). */
function smallPng(w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0; raw[o + 3] = 255;
    }
  }
  const crc32 = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const tb = Buffer.from(type);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
    return Buffer.concat([len, tb, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
