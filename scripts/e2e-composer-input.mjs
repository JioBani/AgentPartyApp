/*
 * Full-process e2e for the composer's input contract — OFFLINE (mock member, no
 * model). Launches the REAL app and presses REAL keys at REAL window widths,
 * which is the only tier that can prove any of this: the behaviour under test is
 * a browser DEFAULT ACTION (Enter submitting the form a single-line input sits
 * in) at a layout chosen from MEASURED element width. jsdom can assert the
 * handler's intent (scripts/qa-composer-send-key.mjs); it cannot press a key
 * that a browser then acts on, nor be 380px wide.
 *
 * Proves:
 *   [P-3]8 — `composer.sendKey` decides what Enter does, and round-trips through
 *            POST /api/settings to the live window.
 *   [#15]  — the SAME thing happens narrow, where the composer renders a
 *            single-line <input> inside its <form>. This is the regression:
 *            Enter used to submit that form no matter the setting.
 *   P-14   — `composer.interruptOnSend` reaches the send path, stopping a busy
 *            member's in-flight turn instead of queueing behind it.
 *   [P-3]9 — POST /api/clipboard/image writes to the real OS clipboard (the
 *            same method behind the thumbnail's copy button), and REFUSES bytes
 *            it cannot decode instead of silently writing an empty image.
 *
 * Root is derived from import.meta.url (never a hardcoded project path — a
 * hardcoded root builds and tests a DIFFERENT worktree), no port is fixed (the
 * app is found through its per-workspace instance file), and the workspace is
 * pinned in an isolated userData's settings.json.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import zlib from "node:zlib";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-composer-input-e2e-workspace");
const userData = path.join(os.tmpdir(), "agentparty-composer-input-e2e-user-data");
let base = "";
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const TEXTAREA = "textarea.wb-composer-textarea";
const NARROW_INPUT = "input.wb-composer-input";

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  // The app resolves its workspace from settings.json, not from the environment.
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
    },
    windowsHide: true,
  });
  child.stdout.on("data", (c) => process.stdout.write(c));
  child.stderr.on("data", (c) => process.stderr.write(c));

  try {
    await waitForApi();
    assert((await getJson("/api/health")).ok, "health ok");

    // --- 0) Prove the RUNNING build is this worktree -----------------------
    // Both endpoints exist only on this branch. If a hardcoded root had built a
    // different worktree, the spec would not list them and every later step
    // would be measuring someone else's code.
    const spec = await getJson("/api/spec");
    const endpoints = spec?.spec?.endpoints || spec?.endpoints || [];
    assert(endpoints.includes("POST /api/qa/input"), "running build serves POST /api/qa/input (this worktree, not another)");
    assert(endpoints.includes("POST /api/qa/window/bounds"), "running build serves POST /api/qa/window/bounds");
    const served = (await getJson("/api/state")).settings?.workspacePath;
    assert(served === ws, `serving the e2e workspace (${served})`);

    await post("/api/qa/reset").catch(() => {});
    // Three members: the narrow composer is reached by SPLITTING panels, which
    // is how a user actually gets there — the window has a 1100px minimum, so a
    // single panel is never narrow no matter how small the window is dragged.
    // autoReply OFF: a canned reply would drive the session's status on its own
    // timer, and "still busy" has to mean "the turn was not interrupted" — not
    // "the mock had not finished answering yet".
    await post("/api/qa/seed", { party: "composer input e2e", members: [{ name: "worker", role: "impl", autoReply: false }, { name: "filler-a", role: "r", autoReply: false }, { name: "filler-b", role: "r", autoReply: false }] });
    await post("/api/navigation", { view: "workbench" });
    await wide();

    // --- 1) [P-3]8 default: Ctrl+Enter sends, Enter does not ---------------
    let after = await input({ selector: TEXTAREA, text: "기본값 확인", key: "Enter" });
    assert(after.value.startsWith("기본값 확인") && after.value.includes("\n"), `기본값(ctrl-enter): 넓은 폭에서 Enter 는 전송하지 않고 줄바꿈한다 (draft=${JSON.stringify(after.value)})`);
    assert(!(await transcriptHas("worker", "기본값 확인")), "…그리고 아무것도 전송되지 않았다");

    after = await input({ selector: TEXTAREA, key: "Enter", modifiers: ["control"] });
    assert(after.value === "", "기본값(ctrl-enter): Ctrl+Enter 는 전송한다 (입력창이 비워짐)");
    assert(await transcriptHas("worker", "기본값 확인"), "전송된 메시지가 멤버 대화에 실제로 기록됐다");

    // --- 2) [#15] the same in a narrow panel -------------------------------
    await narrow();
    // The selector matches ONLY if the narrow layout really rendered, so the
    // call succeeding is itself the proof that this is the single-line input.
    after = await input({ selector: NARROW_INPUT, text: "좁은 폭 확인", key: "Enter" });
    assert(after.value === "좁은 폭 확인", `[#15] 좁은 폭에서도 Enter 는 전송하지 않는다 (draft=${JSON.stringify(after.value)})`);
    assert(!(await transcriptHas("worker", "좁은 폭 확인")), "[#15] 폼 기본 submit 이 발동하지 않았다 (메시지 미기록)");

    after = await input({ selector: NARROW_INPUT, key: "Enter", modifiers: ["control"] });
    assert(after.value === "", "좁은 폭에서도 Ctrl+Enter 는 전송한다");

    // --- 3) [P-3]8 enter setting, live over HTTP ---------------------------
    await post("/api/settings", { composer: { sendKey: "enter", interruptOnSend: false } });
    await delay(500);
    const settings = (await getJson("/api/state")).settings?.composer;
    assert(settings?.sendKey === "enter", `설정이 저장되고 열린 창에 반영된다 (${JSON.stringify(settings)})`);

    after = await input({ selector: NARROW_INPUT, text: "enter 설정 좁은 폭", key: "Enter" });
    assert(after.value === "", "enter 설정: 좁은 폭에서 Enter 가 전송한다");

    await wide();
    after = await input({ selector: TEXTAREA, text: "enter 설정 넓은 폭", key: "Enter" });
    assert(after.value === "", "enter 설정: 넓은 폭에서도 Enter 가 전송한다 (폭과 무관하게 동일)");

    after = await input({ selector: TEXTAREA, text: "줄바꿈", key: "Enter", modifiers: ["shift"] });
    assert(after.value.startsWith("줄바꿈") && after.value !== "", `enter 설정: Shift+Enter 는 줄바꿈 (draft="${after.value.replace(/\n/g, "\\n")}")`);
    await input({ selector: TEXTAREA, text: "" });

    // --- 4) P-14 interrupt on send -----------------------------------------
    await post("/api/settings", { composer: { sendKey: "ctrl-enter", interruptOnSend: false } });
    await delay(400);
    await makeBusy("worker");
    assert(await memberBusy("worker"), "멤버가 작업 중 상태다 (인터럽트 대상)");
    await input({ selector: TEXTAREA, text: "큐잉되어야 함", key: "Enter", modifiers: ["control"] });
    await delay(800);
    assert(await memberBusy("worker"), "설정 off: 진행 중인 턴이 끊기지 않는다 (뒤에 큐잉된다)");
    assert(await transcriptHas("worker", "큐잉되어야 함"), "…메시지 자체는 정상 전달됐다");

    await post("/api/settings", { composer: { sendKey: "ctrl-enter", interruptOnSend: true } });
    await delay(500);
    await makeBusy("worker");
    assert(await memberBusy("worker"), "다시 작업 중 상태로 만들었다");
    await input({ selector: TEXTAREA, text: "즉시 처리되어야 함", key: "Enter", modifiers: ["control"] });
    await delay(800);
    assert(!(await memberBusy("worker")), "설정 on: 진행 중인 턴이 실제로 끊긴다");
    assert(await transcriptHas("worker", "즉시 처리되어야 함"), "…그리고 새 메시지가 전달됐다");

    const shot = path.join(os.tmpdir(), "composer-input-e2e.png");
    await post("/api/navigation", { view: "runtime" });
    await delay(600);
    const cap = await post("/api/capture", { path: shot });
    assert(cap.ok && cap.bytes > 0, `설정 화면 캡처 → ${cap.path} (${cap.bytes} bytes)`);

    // --- 5) [P-3]9 clipboard route, against the real OS clipboard ----------
    // The composer's copy button and this endpoint are the same AppController
    // method, so this exercises the write the button performs. The payload is
    // the screenshot just taken — a real image of a real size, rather than a
    // synthetic 1x1 that Electron's decoder rejects on its own.
    const png = fs.readFileSync(shot).toString("base64");
    const copied = await post("/api/clipboard/image", { mediaType: "image/png", dataBase64: png });
    assert(copied.ok && copied.width === cap.width && copied.height === cap.height, `클립보드에 실제로 쓴 이미지를 응답이 되돌려준다 (${copied.width}x${copied.height}, ${copied.bytes}B)`);
    // A small real image copies too, so nothing here is size-gated by accident.
    const small = await post("/api/clipboard/image", { mediaType: "image/png", dataBase64: smallPng(16, 16).toString("base64") });
    assert(small.ok && small.width === 16 && small.height === 16, `작은 실제 이미지도 복사된다 (${small.width}x${small.height})`);
    // Undecodable bytes must FAIL. Writing an empty image would wipe the
    // clipboard while reporting success — the user pastes nothing, silently.
    const rejected = await postRaw("/api/clipboard/image", { mediaType: "image/png", dataBase64: "bm90LWFuLWltYWdl" });
    assert(rejected.status === 500 && /decode/i.test(rejected.body), `이미지가 아닌 바이트는 조용히 빈 복사가 아니라 에러다 (${rejected.status})`);

    await post("/api/window/close", {});
    await waitForExit(child);
    console.log(failures.length ? `\nCOMPOSER INPUT E2E FAILED (${failures.length})` : "\nCOMPOSER INPUT E2E PASSED");
    process.exit(failures.length ? 1 : 0);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }
}

/** Focus + type + press through the real input path; returns the field after. */
async function input(body) {
  const result = await post("/api/qa/input", body);
  await delay(250);
  return { ...result, value: result.value ?? "" };
}

/** One panel filling the window — the composer renders its two-row textarea. */
async function wide() {
  await post("/api/qa/window/bounds", { width: 1400, height: 900 });
  await post("/api/qa/open", { panels: [["worker"]] });
  await delay(900);
}

/** Three-way split — each panel measures under 408px, the narrow tier. */
async function narrow() {
  await post("/api/qa/window/bounds", { width: 1100, height: 900 });
  await post("/api/qa/open", { panels: [["worker"], ["filler-a"], ["filler-b"]] });
  await delay(900);
}

/** Puts a member into a turn that stays open until something interrupts it. */
async function makeBusy(name) {
  await post(`/api/qa/members/${encodeURIComponent(name)}/emit`, { events: [{ type: "status", status: "responding" }], status: "working" });
  await delay(500);
}

async function memberBusy(name) {
  const state = await getJson("/api/state");
  const member = (state.party?.members || []).find((m) => m.name === name);
  const session = (state.sessions || []).find((s) => s.id === member?.sessionId);
  const status = String(session?.snapshot?.status || "");
  return status === "responding" || status === "requesting";
}

/**
 * Whether the member's persisted transcript carries `text`. The renderer saves
 * on a debounce, so a positive is polled for; a negative is only trusted after
 * the same window has elapsed (otherwise "not sent" and "not saved yet" look
 * identical).
 */
async function transcriptHas(name, text, timeoutMs = 4000) {
  const started = Date.now();
  do {
    const blocks = await getJson(`/api/party/members/${encodeURIComponent(name)}/transcript`).catch(() => null);
    if (JSON.stringify(blocks || []).includes(text)) {
      return true;
    }
    await delay(400);
  } while (Date.now() - started < timeoutMs);
  return false;
}

async function waitForApi() {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    base = firstBaseUrl(ws);
    if (base) { try { if ((await getJson("/api/health")).ok) return; } catch {} }
    await delay(500);
  }
  throw new Error("Automation API did not start (no live instance file under the e2e workspace).");
}

async function getJson(u) { const r = await fetch(base + u); if (!r.ok) throw new Error(`${u} returned ${r.status}`); return r.json(); }
async function post(u, b) { const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) }); if (!r.ok) throw new Error(`${u} returned ${r.status}: ${await r.text()}`); return r.json(); }
/** A valid opaque-red RGBA PNG of the given size, built without a dependency. */
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

/** POST that tolerates a non-2xx, for asserting that a bad request FAILS. */
async function postRaw(u, b) {
  const r = await fetch(base + u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) });
  return { status: r.status, body: await r.text() };
}
async function removePath(target) { for (let i = 0; i < 10; i += 1) { try { fs.rmSync(target, { recursive: true, force: true }); return; } catch (e) { if (e?.code !== "EBUSY" || i === 9) return; await delay(300); } } }
function waitForExit(child) { return new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("App did not exit after close API.")), 10000); child.once("exit", () => { clearTimeout(t); resolve(); }); }); }
function killProcessTree(pid) { if (!pid) return; try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { try { process.kill(pid); } catch {} } }
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error(e); process.exit(1); });
