/**
 * Diagnose the guide landing: inspect DOM immediately after open, then again
 * after a short wait. No model call. No screenshot as the verdict.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 47994;
const workspace = path.join(os.tmpdir(), "agentparty-guide-inspect-ws");
const userData = path.join(os.tmpdir(), "agentparty-guide-inspect-ud");
const baseUrl = `http://127.0.0.1:${port}`;

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

function summarize(label, inspect) {
  const pick = (node) => node?.present
    ? `present visible=${node.visible} ${node.box?.width}x${node.box?.height} "${String(node.text || "").slice(0, 80)}" contrast=${node.contrast ?? "-"}`
    : "ABSENT";
  console.log(`\n=== ${label} ===`);
  console.log("readyState", inspect.readyState, "theme", inspect.dataTheme, "presenting", inspect.presenting);
  console.log("url", inspect.url);
  console.log("root   ", pick(inspect.root));
  console.log("landing", pick(inspect.landing));
  console.log("start  ", pick(inspect.start));
  console.log("chat   ", pick(inspect.chat));
  console.log("cost   ", pick(inspect.cost));
  console.log("fab    ", pick(inspect.fab));
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
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
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

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      const health = await get("/api/health");
      if (health.ok) {
        break;
      }
    } catch {
      // starting
    }
    if (i === 79) {
      throw new Error("API did not start");
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  await post("/api/guide/open", {});
  const immediate = await get("/api/guide/inspect");
  summarize("immediate after open", immediate);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const later = await get("/api/guide/inspect");
  summarize("after 1500ms", later);

  const landed = later.landing?.present && later.chat?.present && later.cost?.present && later.cost?.visible;
  if (!immediate.root?.present && later.root?.present) {
    console.log("\nVERDICT: capture timing — DOM was not painted at open return, then appeared.");
  } else if (landed) {
    console.log("\nVERDICT: landing DOM is present after open. White capture was timing or paint, not a missing tree.");
  } else {
    console.log("\nVERDICT: landing DOM still missing or cost copy not visible — render defect.");
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  kill();
  await new Promise((resolve) => setTimeout(resolve, 800));
}
