/**
 * Disabled startup offer (§8 compatibility): neither an upgrade nor a fresh
 * userData may show or redirect into the guide. No model call.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  } else {
    console.log(`  ✓ ${message}`);
  }
}

async function runPhase(label, { port, userData, workspace, writeSettings }) {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  if (writeSettings) {
    fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
      workspacePath: workspace,
      automationApiPort: port,
    }, null, 2));
  }
  const baseUrl = `http://127.0.0.1:${port}`;
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

  const get = async (route) => {
    const response = await fetch(baseUrl + route);
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${route} ${response.status}: ${text}`);
    }
    return JSON.parse(text);
  };
  const post = async (route, body) => {
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
  };

  try {
    for (let i = 0; i < 80; i += 1) {
      try {
        const health = await get("/api/health");
        if (health.ok) {
          break;
        }
      } catch {
        if (i === 79) {
          throw new Error(`${label}: API did not start`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const offer = await get("/api/guide/offer");
    let dialog = null;
    try {
      dialog = await post("/api/measure", { selector: "[data-guide-offer]", styles: ["display"] });
    } catch (error) {
      dialog = { error: error instanceof Error ? error.message : String(error) };
    }
    const activeView = await post("/api/measure", { selector: ".nav-item.active", attributes: ["data-view"] });
    console.log(`\n=== ${label} ===`);
    console.log("offer", offer);
    console.log("dialog", dialog.error || `count=${(dialog.elements || []).length}`);
    console.log("activeView", activeView.elements?.[0]?.attributes?.["data-view"] || "missing");
    return { offer, dialog, activeView: activeView.elements?.[0]?.attributes?.["data-view"] };
  } finally {
    kill();
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

const tmp = os.tmpdir();
const upgrade = await runPhase("upgrade (existing settings.json)", {
  port: 47996,
  userData: path.join(tmp, "agentparty-guide-offer-upgrade-ud"),
  workspace: path.join(tmp, "agentparty-guide-offer-upgrade-ws"),
  writeSettings: true,
});
assert(upgrade.offer.pending === false && upgrade.offer.shown === true, "upgrade keeps the startup offer disabled");
assert(Boolean(upgrade.dialog.error), `upgrade must not show the popup: ${JSON.stringify(upgrade.dialog)}`);
assert(upgrade.activeView === "workbench", "upgrade starts in the workbench instead of redirecting to guide/auth");

const fresh = await runPhase("first install (no settings.json)", {
  port: 47997,
  userData: path.join(tmp, "agentparty-guide-offer-fresh-ud"),
  workspace: path.join(tmp, "agentparty-guide-offer-fresh-ws"),
  writeSettings: false,
});
assert(fresh.offer.pending === false && fresh.offer.shown === true, "fresh install keeps the startup offer disabled");
assert(Boolean(fresh.dialog.error), "fresh install does not show the guide popup");
assert(fresh.activeView === "workbench", "fresh install starts in the workbench instead of redirecting to guide/auth");

const again = JSON.parse(fs.readFileSync(path.join(tmp, "agentparty-guide-offer-fresh-ud", "guide-offer.json"), "utf8"));
assert(again.shown === true, "fresh install persists the disabled offer state");

if (failures.length) {
  console.error(`\nFAILED ${failures.length}:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nOK");
