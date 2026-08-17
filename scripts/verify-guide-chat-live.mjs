/**
 * Guide live check: inspect landing/FAB (no model), then ONE Claude Code turn
 * that must read cost.md's canary and emit [[slide:99]].
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 47995;
const workspace = path.join(os.tmpdir(), "agentparty-guide-live2-ws");
const userData = path.join(os.tmpdir(), "agentparty-guide-live2-ud");
const baseUrl = `http://127.0.0.1:${port}`;
const CANARY = "GUIDE-MD-CANARY-7F3A";

const failures = [];
function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  } else {
    console.log(`  ✓ ${message}`);
  }
}

async function get(route) {
  const response = await fetch(baseUrl + route);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${route} ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function post(route, body) {
  const response = await fetch(baseUrl + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${route} ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

function dump(label, view) {
  const texts = (view.blocks || []).map((block) => `${block.kind}: ${String(block.text || block.name || "").slice(0, 280)}`);
  console.log(`\n--- ${label} ---\n${texts.join("\n") || "(empty)"}\nbusy=${view.busy} error=${view.error || ""}\n`);
  return texts.join("\n");
}

function hasApproval(view) {
  return (view.blocks || []).some((block) => block.kind === "approval");
}

async function waitForIdle(kind, label) {
  for (let i = 0; i < 90; i += 1) {
    const view = await get(`/api/guide/chat?kind=${kind}`);
    if (!view.busy) {
      return view;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${label} did not finish in 180s`);
}

function searchLogs(needle) {
  const logs = path.join(userData, "logs");
  if (!fs.existsSync(logs)) {
    return false;
  }
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(full)) {
          return true;
        }
        continue;
      }
      try {
        if (fs.readFileSync(full, "utf8").includes(needle)) {
          return true;
        }
      } catch {
        // binary
      }
    }
    return false;
  };
  return walk(logs);
}

function pick(node) {
  return node?.present
    ? `visible=${node.visible} ${node.box?.width}x${node.box?.height} contrast=${node.contrast ?? "-"} "${String(node.text || "").slice(0, 72)}"`
    : "ABSENT";
}

fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  workspacePath: workspace,
  automationApiPort: port,
}, null, 2));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.AGENTPARTY_QA;
delete env.AGENTPARTY_E2E;
env.AGENTPARTY_ALLOW_MULTI_INSTANCE = "1";
env.AGENTPARTY_AUTOMATION_PORT = String(port);
env.AGENTPARTY_USER_DATA = userData;
env.AGENTPARTY_WINDOW_DISPLAY = "left";

const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", workspace], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env,
  windowsHide: true,
});
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
  process.stderr.write(chunk);
});
child.stdout.on("data", (chunk) => process.stdout.write(chunk));

const kill = () => {
  if (child.exitCode !== null || !child.pid) {
    return;
  }
  try {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    child.kill();
  }
};
process.on("exit", kill);

async function waitForApi() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const health = await get("/api/health");
      if (health.ok) {
        return;
      }
    } catch {
      // starting
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("API did not start");
}

try {
  await waitForApi();
  await post("/api/guide/open", {});

  console.log("\nINSPECT landing");
  const landing = await get("/api/guide/inspect");
  console.log("theme", landing.dataTheme, "presenting", landing.presenting);
  console.log("landing", pick(landing.landing));
  console.log("chat   ", pick(landing.chat));
  console.log("cost   ", pick(landing.cost));
  assert(landing.landing?.present && landing.landing?.visible, "landing is in the DOM and painted");
  assert(landing.chat?.present && landing.chat?.visible, "chatbot UI is visible");
  assert(landing.cost?.present && landing.cost?.visible, "cost copy is visible");
  assert(/비용이 발생/.test(String(landing.cost?.text || "")), `cost copy text: ${landing.cost?.text || ""}`);

  console.log("\nINSPECT presenting FAB");
  const opened = await post("/api/guide/slide", { index: 0 });
  assert(opened.presenting === true, "presentation open");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const presenting = await get("/api/guide/inspect");
  console.log("fab     ", pick(presenting.fab));
  console.log("fab light", pick(presenting.fabByTheme?.light));
  console.log("fab dark ", pick(presenting.fabByTheme?.dark));
  assert(presenting.fab?.present && presenting.fab?.visible, "질문하기 FAB is visible");
  assert(/질문하기/.test(String(presenting.fab?.text || "")), "FAB label is 질문하기");
  const lightC = presenting.fabByTheme?.light?.contrast;
  const darkC = presenting.fabByTheme?.dark?.contrast;
  assert(typeof lightC === "number" && lightC >= 4.5, `FAB light contrast ${lightC}`);
  assert(typeof darkC === "number" && darkC >= 4.5, `FAB dark contrast ${darkC}`);

  await post("/api/guide/chat/settings", { harnessId: "claude-code", model: "claude-opus-5[1m]", effort: "medium" });
  const settings = await get("/api/guide/chat/settings");
  assert(settings.harnessId === "claude-code" && /opus-5/i.test(String(settings.model || "")), `settings ${JSON.stringify(settings)}`);

  console.log("\nTURN 1 slide chat — canary + [[slide:99]]");
  await post("/api/guide/chat/reset", { kind: "slide" });
  const viewing = { index: 0, title: opened.title || "파티가 없다", scene: opened.sceneTitle || "빈 화면" };
  await post("/api/guide/chat", {
    kind: "slide",
    text: "cost.md 의 검증용 카나리아 토큰만 쓰고, 마지막에 [[slide:99]] 를 그대로 써.",
    viewing,
  });
  const slide = await waitForIdle("slide", "slide chat");
  const slideText = dump("slide", slide);
  assert(!slide.error, `slide error: ${slide.error || "none"}`);
  assert((slide.blocks || []).some((block) => block.kind === "assistant" && String(block.text || "").trim()), "slide chat got an assistant reply");
  assert(slideText.includes(CANARY), "reply contains the cost.md canary — the file was read");
  assert(/\[\[slide:99]]/.test(slideText), "reply includes [[slide:99]]");
  assert(!hasApproval(slide), "no approval card");
  assert(searchLogs("looking at slide 0"), "app log records looking at slide 0");

  await post("/api/guide/ask", { open: true });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = await get("/api/guide/inspect");
  console.log("slideMissing", after.slideMissing);
  assert(
    (after.slideMissing || []).some((item) => /없습니다/.test(item.text) && /99/.test(item.text)),
    `out-of-range marker shown in UI: ${JSON.stringify(after.slideMissing)}`,
  );

  if (failures.length) {
    console.error(`\nFAILED ${failures.length}:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nOK");
  }
} catch (error) {
  console.error(error);
  console.error(stderr.slice(-4000));
  process.exitCode = 1;
} finally {
  kill();
  await new Promise((resolve) => setTimeout(resolve, 800));
}
