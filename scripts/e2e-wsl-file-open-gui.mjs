/*
 * Manual GUI pass for #1 wrap + #2 WSL open/reveal.
 * Visible window, real sendInputEvent clicks via POST /api/qa/pointer.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForLiveBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distro = "Ubuntu-22.04";
const stamp = `${Date.now()}`;
const shotDir = path.join(os.tmpdir(), `agentparty-manual-gui-wsl-${stamp}`);
const launchWs = path.join(os.tmpdir(), `agentparty-manual-gui-ws-${stamp}`);
const userData = path.join(os.tmpdir(), `agentparty-manual-gui-ud-${stamp}`);
const fixturePosix = `/tmp/agentparty-manual-gui-${stamp}`;
const wslUri = `wsl+${distro}:${fixturePosix}`;
const publicFile = path.join("C:\\Users\\Public", `agentparty-manual-gui-${stamp}.txt`);
const nativePosix = `${fixturePosix}/native.txt`;
const MIXED = [
  "v0.2.7 배포 완료. 공개 릴리스",
  "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.2.7, source annotated tag v0.2.7→4ab7bf0.",
  "설치본/포터블/blockmap/latest.yml 언급은 완료. 익명 다운로드 4개 모두 HTTP 200, latest.yml 0.2.7 및 한글 릴리스 노트 정상 확인.",
].join("\n");

let base = "";
const notes = [];
const fail = [];
const log = (ok, msg) => {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${msg}`);
  notes.push(`${ok ? "ok" : "FAIL"}: ${msg}`);
  if (!ok) fail.push(msg);
};

function wsl(command) {
  execFileSync("wsl.exe", ["-d", distro, "-e", "bash", "-lc", command], { stdio: "inherit" });
}

async function main() {
  fs.mkdirSync(launchWs, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: launchWs }, null, 2));
  fs.writeFileSync(publicFile, "manual gui /mnt/c fixture\n");
  wsl(`mkdir -p '${fixturePosix}' && printf '%s\\n' 'manual gui native' > '${nativePosix}'`);
  fs.writeFileSync(path.join(shotDir, "README.txt"), `manual GUI shots ${stamp}\n`);

  const launchedAt = Date.now();
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      AGENTPARTY_AUTOMATION_PORT: "",
    },
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    base = await waitForLiveBaseUrl(launchWs, { since: launchedAt, timeoutMs: 90_000 });
    log(Boolean(base), `app ${base}`);
    await post("/api/qa/seed", {
      party: "manual-gui",
      members: [
        { name: "renderer", model: "sonnet", role: "wrap QA" },
        { name: "left", model: "sonnet", role: "narrow" },
      ],
    });
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["renderer"], ["left"]] });
    await post("/api/qa/window/bounds", { width: 980, height: 800 });
    await post("/api/qa/members/renderer/emit", {
      events: [{
        type: "status",
        status: "sent",
        detail: `<channel source="agentparty" from="left" to="renderer">\n${MIXED}\n</channel>`,
      }],
    });
    await delay(800);
    const wrapShot = path.join(shotDir, "01-narrow-mixed-url.png");
    const wrapCap = await post("/api/capture", { path: wrapShot });
    log(wrapCap?.ok && wrapCap.bytes > 0, `narrow mixed URL screenshot ${wrapShot}`);
    const bubble = await post("/api/measure", { selector: ".wb-channel-bubble", limit: 1 }).catch((e) => ({ error: String(e) }));
    const bubbleW = bubble?.elements?.[0]?.content?.width || bubble?.elements?.[0]?.box?.width;
    log(Boolean(bubbleW), `channel bubble width=${bubbleW}`);

    const win = await post("/api/windows", { workspacePath: wslUri });
    const q = `?window=${encodeURIComponent(win.id)}`;
    const mntHref = `/mnt/c/Users/Public/${path.basename(publicFile)}`;
    const fileHome = `file://${nativePosix}`;
    const md = [
      `[home](${nativePosix})`,
      `[mnt](${mntHref})`,
      `[file](${fileHome})`,
      `[missing](${fixturePosix}/nope.txt)`,
    ].join("\n\n");
    await post(`/api/qa/seed${q}`, {
      party: "manual-wsl",
      members: [{ name: "linker", role: "files", model: "sonnet", status: "idle", blocks: [{ type: "assistant_text_delta", text: md }] }],
    });
    await post(`/api/navigation${q}`, { view: "workbench" });
    await post(`/api/qa/open${q}`, { panels: [["linker"]] });
    await delay(1000);
    const linksShot = path.join(shotDir, "02-wsl-links.png");
    await post(`/api/capture${q}`, { path: linksShot });
    log(true, `WSL links screenshot ${linksShot}`);

    const clicks = [
      { name: "home-open", selector: `.wb-md-link a[href="${nativePosix}"]`, shot: "03-home-open.png" },
      { name: "home-reveal", selector: `.wb-md-link:has(a[href="${nativePosix}"]) .wb-md-link-reveal`, shot: "04-home-reveal.png" },
      { name: "mnt-open", selector: `.wb-md-link a[href="${mntHref}"]`, shot: "05-mnt-open.png" },
      { name: "file-open", selector: `.wb-md-link a[href="${fileHome}"]`, shot: "06-file-open.png" },
      { name: "file-reveal", selector: `.wb-md-link:has(a[href="${fileHome}"]) .wb-md-link-reveal`, shot: "07-file-reveal.png" },
      { name: "missing-open", selector: `.wb-md-link a[href="${fixturePosix}/nope.txt"]`, shot: "08-missing-click.png" },
    ];
    for (const step of clicks) {
      const pointed = await post(`/api/qa/pointer${q}`, { steps: [{ selector: step.selector, action: "click" }] })
        .catch((error) => ({ ok: false, error: String(error) }));
      log(pointed?.ok === true, `pointer ${step.name} (${pointed?.error || `${pointed?.steps?.[0]?.x},${pointed?.steps?.[0]?.y}`})`);
      await delay(900);
      const shot = path.join(shotDir, step.shot);
      await post(`/api/capture${q}`, { path: shot });
    }
    await delay(700);
    const notice = await post(`/api/measure${q}`, { selector: ".app-toast", limit: 1 }).catch((e) => ({ error: String(e) }));
    const noticeText = notice?.elements?.[0]?.text || notice?.texts?.[0] || "";
    log(/No such file|파일을 열지 못했습니다/.test(noticeText), `missing notice: ${noticeText || notice?.error}`);
    const noticeShot = path.join(shotDir, "09-missing-notice.png");
    await post(`/api/capture${q}`, { path: noticeShot });
    log(true, `missing notice screenshot ${noticeShot}`);
    fs.writeFileSync(path.join(shotDir, "observations.txt"), notes.join("\n") + "\n");
  } catch (error) {
    console.error(error);
    fail.push(String(error?.message || error));
  } finally {
    await post("/api/window/close", {}).catch(() => {});
    if (child?.pid) {
      try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ }
    }
    try { fs.rmSync(publicFile, { force: true }); } catch { /* leftover */ }
    try { wsl(`rm -rf '${fixturePosix}'`); } catch { /* leftover */ }
  }
  console.log(`\nshots: ${shotDir}`);
  process.exit(fail.length ? 1 : 0);
}

async function post(route, body) {
  const response = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
}
function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
