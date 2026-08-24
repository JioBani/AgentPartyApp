/*
 * Full-process e2e for mixed Korean/URL/English wrapping in a channel card.
 *
 * Launches the REAL Electron app on an isolated userData + temp workspace,
 * seeds mock members, injects the reference mixed body as a normalized channel
 * event, and asserts live geometry via POST /api/measure. Offline: no model call.
 *
 * Run: node scripts/e2e-message-text-rendering.mjs   (after `npm run build`)
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForLiveBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-message-text-rendering-ws");
const userData = path.join(os.tmpdir(), "agentparty-message-text-rendering-ud");
const shotDir = path.join(os.tmpdir(), "agentparty-message-text-rendering-shots");
const MIXED = [
  "v0.2.7 배포 완료. 공개 릴리스",
  "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.2.7, source annotated tag v0.2.7→4ab7bf0.",
  "설치본/포터블/blockmap/latest.yml 언급은 완료. 익명 다운로드 4개 모두 HTTP 200, latest.yml 0.2.7 및 한글 릴리스 노트 정상 확인.",
].join("\n");
const MIXED_HREF = "https://github.com/JioBani/AgentParty-releases/releases/tag/v0.2.7";
const LONG_DIAGNOSTIC = "MCP client for `readonly-db` failed to start: MCP startup failed: handshaking with MCP server failed: Send message error Transport [rmcp::transport::worker::WorkerTransport<rmcp::transport::streamable_http_client::StreamableHttpClientTransportWorker<reqwest::async_impl::client::Client>>] error: Client error: HTTP request failed: http/request failed: error sending request for url (http://127.0.0.1:18000/mcp), when send initialize request";
const LONG_TOOL_PATH = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -Command Get-ChildItem C:\\Project\\AgentPartyApp\\src\\renderer\\workbench";

let base = "";
const failures = [];
const ok = (condition, message) => {
  console.log(`  ${condition ? "ok" : "FAIL"}: ${message}`);
  if (!condition) failures.push(message);
};

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));
  const localFile = path.join(ws, "readme.md");
  fs.writeFileSync(localFile, "# e2e reveal target\n");

  const launchedAt = Date.now();
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start", "--", "--workspace", ws], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
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
    base = await waitForLiveBaseUrl(ws, { since: launchedAt, timeoutMs: 60_000 });
    const health = await get("/api/health");
    ok(health.ok, `app is up at ${base}`);
    await assertRunningBuildIsThisWorktree();
    const windows = (await get("/api/windows")).windows || [];
    ok(windows[0]?.workspacePath?.toLowerCase() === ws.toLowerCase(), `window serves the e2e workspace (${windows[0]?.workspacePath})`);

    await post("/api/qa/seed", {
      party: "message text rendering e2e",
      members: [
        { name: "renderer", model: "claude-sonnet-4.5", role: "렌더링 QA" },
        { name: "left", model: "claude-sonnet-4.5", role: "폭 압축" },
        { name: "right", model: "claude-sonnet-4.5", role: "폭 압축" },
      ],
    });
    await waitForMeasure(".wb-member-row");
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [["renderer"], ["left"]] });
    await post("/api/qa/window/bounds", { width: 1100, height: 800 });
    await delay(1200);
    const panels = await post("/api/measure", { selector: ".wb-panel-title, .wb-tab-name", limit: 20 });
    ok((panels.texts || []).some((text) => text.includes("renderer")), "renderer panel is open before transcript events are injected");

    await post("/api/qa/members/renderer/emit", {
      events: [{
        type: "status",
        status: "sent",
        detail: `<channel source="agentparty" from="alice" to="renderer">\n${MIXED}\n</channel>`,
      }],
    });
    await post("/api/qa/members/renderer/emit", {
      events: [{
        type: "diagnostic",
        severity: "error",
        category: "MCP",
        title: "MCP 서버 readonly-db: failed",
        detail: LONG_DIAGNOSTIC,
      }],
    });
    await post("/api/qa/members/renderer/emit", {
      events: [{
        type: "tool_call",
        id: "narrow-tool-summary",
        name: "Shell",
        source: "shell",
        status: "completed",
        input: { command: LONG_TOOL_PATH },
      }],
    });
    await waitForMeasure(".wb-channel-bubble");

    const bubbleWidth = await fitBubbleNear320();
    ok(bubbleWidth >= 260 && bubbleWidth <= 380, `channel bubble is ~320px class (clientWidth=${bubbleWidth})`);

    const bubble = await post("/api/measure", {
      selector: ".wb-channel-bubble",
      styles: ["white-space", "word-break"],
      limit: 1,
    });
    const b = bubble.elements[0];
    ok(b.scrollable.horizontal === false, `A) bubble horizontal=false (scrollWidth=${b.scroll.width}, clientWidth=${b.content.width})`);
    ok(b.scroll.width <= b.content.width + 1, `A) scrollWidth <= clientWidth+1 (${b.scroll.width} <= ${b.content.width}+1)`);
    ok((b.text || "").includes(MIXED_HREF), "B) full URL text is in the bubble");
    ok((b.text || "").includes(", source annotated tag"), "B) comma + English after the URL is visible");
    ok((b.text || "").includes("v0.2.7 배포 완료"), "C) Korean prefix is visible in reading order");
    // /api/measure slices element text to 200 chars from the start, so the
    // trailing Korean of this single markdown <p> never appears in bubble.text.
    // Absence of the clip control is the live-app proof the full body is shown;
    // qa-markdown already asserts the Korean string in the untruncated DOM.
    ok(MIXED.length <= 320, `B) reference body is under the transcript clip threshold (${MIXED.length} chars)`);
    const clipped = await post("/api/measure", { selector: ".wb-channel-bubble .wb-expand-inline", limit: 1 }).catch((error) => ({ error: String(error.message || error) }));
    ok(Boolean(clipped.error), "B) trailing Korean is not clipped — no 전체 보기 control on the bubble");

    const link = await post("/api/measure", {
      selector: ".wb-channel-bubble .wb-md-link",
      styles: ["white-space"],
      containedBy: ".wb-channel-bubble",
      limit: 1,
    });
    const wrap = link.elements[0];
    ok(wrap.containedBy?.fully === true, `B) .wb-md-link containedBy bubble (overflowRight=${wrap.containedBy?.overflowRight})`);
    ok(!/nowrap/i.test(wrap.styles["white-space"] || ""), `B) .wb-md-link white-space is not nowrap (${wrap.styles["white-space"]})`);

    const anchor = await post("/api/measure", {
      selector: `.wb-channel-bubble .wb-md-link a[href="${MIXED_HREF}"]`,
      containedBy: ".wb-channel-bubble",
      attributes: ["href"],
      limit: 1,
    });
    const a = anchor.elements[0];
    ok(a.containedBy?.fully === true, `B) anchor containedBy bubble (overflowRight=${a.containedBy?.overflowRight})`);
    ok(a.attributes.href === MIXED_HREF, "B) autolink href is the exact URL");
    ok(a.box.height > 20, `B) URL may wrap to multiple lines (anchor height=${a.box.height})`);

    const diagnostic = await post("/api/measure", {
      selector: ".wb-diagnostic",
      styles: ["max-width", "min-width", "overflow-wrap"],
      containedBy: ".wb-transcript",
      limit: 1,
    });
    const diagnosticCard = diagnostic.elements[0];
    ok(diagnosticCard.containedBy?.fully === true, `E) MCP diagnostic stays inside the transcript (overflowRight=${diagnosticCard.containedBy?.overflowRight})`);
    ok(diagnosticCard.scrollable.horizontal === false, `E) MCP diagnostic has no horizontal overflow (scrollWidth=${diagnosticCard.scroll.width}, clientWidth=${diagnosticCard.content.width})`);
    const diagnosticDetail = await post("/api/measure", {
      selector: ".wb-diagnostic-detail",
      styles: ["overflow-wrap", "word-break"],
      containedBy: ".wb-diagnostic",
      limit: 1,
    });
    const diagnosticText = diagnosticDetail.elements[0];
    ok(diagnosticText.containedBy?.fully === true, `E) long MCP transport detail wraps inside its card (overflowRight=${diagnosticText.containedBy?.overflowRight})`);
    ok(diagnosticText.scroll.width <= diagnosticText.content.width + 1, `E) diagnostic scrollWidth <= clientWidth+1 (${diagnosticText.scroll.width} <= ${diagnosticText.content.width}+1)`);
    ok(diagnosticText.styles["overflow-wrap"] === "anywhere", `E) transcript card inherits overflow-wrap:anywhere (${diagnosticText.styles["overflow-wrap"]})`);

    const tool = await post("/api/measure", {
      selector: ".wb-tool",
      containedBy: ".wb-transcript",
      limit: 1,
    });
    const toolCard = tool.elements[0];
    ok(toolCard.containedBy?.fully === true, `F) tool card stays inside the narrow transcript (overflowRight=${toolCard.containedBy?.overflowRight})`);
    ok(toolCard.scrollable.horizontal === false, `F) tool card has no horizontal overflow (scrollWidth=${toolCard.scroll.width}, clientWidth=${toolCard.content.width})`);
    const toolParts = await post("/api/measure", {
      selector: ".wb-tool-name, .wb-tool-source, .wb-tool-arg",
      styles: ["white-space", "overflow", "text-overflow", "flex-shrink"],
      containedBy: ".wb-tool > summary",
      limit: 3,
    });
    const [toolName, toolSource, toolArg] = toolParts.elements;
    ok(toolName.text === "Shell" && toolName.box.height < 24 && toolName.box.width > 25, `F) tool name stays on one line (${Math.round(toolName.box.width)}x${Math.round(toolName.box.height)})`);
    ok(toolSource.text === "shell" && toolSource.box.height < 24 && toolSource.box.width > 25, `F) source badge stays on one line (${Math.round(toolSource.box.width)}x${Math.round(toolSource.box.height)})`);
    ok(toolArg.box.width >= 32 && toolArg.box.height < 24, `F) long path owns the remaining row and stays one line (${Math.round(toolArg.box.width)}x${Math.round(toolArg.box.height)})`);
    ok(toolArg.styles["text-overflow"] === "ellipsis", `F) long path is ellipsis-clipped (${toolArg.styles["text-overflow"]})`);
    ok(toolParts.elements.every((part) => part.containedBy?.fully === true), "F) tool name, source and path are all contained by the summary row");

    for (const theme of ["agentparty-light", "agentparty-dark"]) {
      const appliedTheme = await post("/api/appearance/theme", { theme });
      await delay(300);
      const themedShot = path.join(shotDir, `narrow-tool-${theme}.png`);
      const captured = await post("/api/capture", { path: themedShot });
      ok(appliedTheme.applied === theme && captured.bytes > 0, `F) ${theme} tool-layout screenshot → ${themedShot}`);
    }

    const shot = path.join(shotDir, "mixed-channel-320.png");
    ok((await post("/api/capture", { path: shot })).bytes > 0, `screenshot → ${shot}`);
    console.log(`MEASURE bubble clientWidth=${b.content.width} scrollWidth=${b.scroll.width} horizontal=${b.scrollable.horizontal}`);
    console.log(`MEASURE link containedBy.fully=${wrap.containedBy?.fully} overflowRight=${wrap.containedBy?.overflowRight} white-space=${wrap.styles["white-space"]}`);
    console.log(`MEASURE anchor containedBy.fully=${a.containedBy?.fully} height=${a.box.height} href=${a.attributes.href}`);
    console.log(`SCREENSHOT ${shot}`);

    const beforeOpen = ipcLogLines().length;
    await clickAndCapture(`.wb-channel-bubble .wb-md-link a[href="${MIXED_HREF}"]`, "mixed-link-click.png", "clicked the autolink");
    await delay(500);
    const opened = ipcLogLines().slice(beforeOpen).filter((line) => line.includes("shell:openExternal"));
    ok(opened.length > 0, "D) clicking the link invoked shell:openExternal");
    ok(opened.some((line) => line.includes(MIXED_HREF)), "D) openExternal received the exact href");

    await clickAndCapture(".wb-channel-bubble .wb-md-link .wb-copy-btn", "mixed-link-copy.png", "clicked the link copy control");
    await delay(300);
    const copyState = await post("/api/measure", {
      selector: ".wb-channel-bubble .wb-md-link .wb-copy-btn",
      attributes: ["data-copy-state"],
      limit: 1,
    });
    ok(copyState.elements[0].attributes["data-copy-state"] === "copied", "D) copy control reports copied (exact href write succeeded)");

    await post("/api/qa/members/renderer/emit", {
      events: [{
        type: "status",
        status: "sent",
        detail: `<channel source="agentparty" from="alice" to="renderer">\n로컬 파일 [readme](${localFile.replace(/\\/g, "/")})\n</channel>`,
      }],
    });
    await delay(700);
    const beforeReveal = ipcLogLines().length;
    await clickAndCapture(".wb-channel-bubble .wb-md-link-reveal", "mixed-file-reveal.png", "clicked the local-file reveal control");
    await delay(500);
    const revealed = ipcLogLines().slice(beforeReveal).filter((line) => line.includes("shell:openPath"));
    ok(revealed.length > 0, "D) reveal control invoked shell:openPath");

    await post("/api/window/close", {}).catch(() => {});
    await waitForExit(child);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }

  console.log(failures.length ? `\nMESSAGE TEXT RENDERING E2E FAILED (${failures.length})` : "\nMESSAGE TEXT RENDERING E2E PASSED");
  process.exit(failures.length ? 1 : 0);
}

async function fitBubbleNear320() {
  const widths = [1280, 1180, 1080, 980, 900];
  let last = 0;
  for (const width of widths) {
    await post("/api/qa/window/bounds", { width, height: 800 });
    await delay(350);
    const measured = await post("/api/measure", { selector: ".wb-channel-bubble", limit: 1 });
    last = measured.elements[0].content.width;
    console.log(`  bubble clientWidth=${last} at window width=${width}`);
    if (last >= 280 && last <= 340) return last;
  }
  return last;
}

async function waitForMeasure(selector, timeoutMs = 8_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      return await post("/api/measure", { selector, limit: 1 });
    } catch (error) {
      lastError = error;
      await delay(200);
    }
  }
  throw lastError || new Error(`Timed out waiting for ${selector}`);
}

async function assertRunningBuildIsThisWorktree() {
  const appRoot = (await get("/api/state")).runtime?.appRoot || "";
  const within = (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
  ok(Boolean(appRoot) && within, `running build is THIS worktree (appRoot=${appRoot || "<missing>"}, expected under ${root})`);
}

async function clickAndCapture(selector, shotName, message) {
  const shot = path.join(shotDir, shotName);
  try {
    const result = await post("/api/capture", { click: selector, path: shot });
    ok(result.applied?.clicked === true && result.bytes > 0, `${message} → ${shotName}`);
    return result;
  } catch (error) {
    ok(false, `${message} — click failed: ${error.message}`);
    return null;
  }
}

function ipcLogLines() {
  const dir = path.join(userData, "logs");
  try {
    const newest = fs.readdirSync(dir).filter((f) => f.endsWith(".ndjson")).sort().at(-1);
    return newest ? fs.readFileSync(path.join(dir, newest), "utf8").split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
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

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
