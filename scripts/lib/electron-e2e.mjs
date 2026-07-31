import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function createElectronE2eApp({ root, workspace, userData, port, env = {} }) {
  const baseUrl = `http://127.0.0.1:${port}`;
  let child;

  const get = async (route, headers = {}) => {
    const response = await fetch(baseUrl + route, { headers });
    if (!response.ok) {
      throw new Error(`${route} ${response.status}: ${await response.text()}`);
    }
    return response.json();
  };

  const post = async (route, body, headers = {}) => {
    const response = await fetch(baseUrl + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body || {}),
    });
    if (!response.ok) {
      throw new Error(`${route} ${response.status}: ${await response.text()}`);
    }
    return response.json();
  };

  const bindWorkspace = async () => {
    const windows = (await get("/api/windows")).windows || [];
    if (windows[0] && windows[0].workspacePath !== workspace) {
      await post(`/api/windows/${windows[0].id}/workspace`, { workspacePath: workspace });
    }
  };

  const waitForApi = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok && (await response.json()).ok) {
          await bindWorkspace();
          return;
        }
      } catch {
        // App startup is still in progress.
      }
      await delay(500);
    }
    throw new Error(`Automation API did not start at ${baseUrl}.`);
  };

  const prepare = async () => {
    await removePath(workspace);
    await removePath(userData);
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(
      path.join(userData, "settings.json"),
      JSON.stringify({ workspacePath: workspace, automationApiPort: port }, null, 2),
    );
  };

  const launch = async () => {
    if (child && child.exitCode === null) {
      throw new Error("Electron E2E app is already running.");
    }
    child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        AGENTPARTY_QA: "1",
        AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
        AGENTPARTY_AUTOMATION_PORT: String(port),
        AGENTPARTY_USER_DATA: userData,
        AGENTPARTY_WINDOW_DISPLAY: "left",
        AGENTPARTY_WORKSPACE: workspace,
        ...env,
      },
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    await waitForApi();
  };

  const close = async () => {
    if (!child || child.exitCode !== null) {
      return;
    }
    await post("/api/window/close", {}).catch(() => {});
    await waitForExit(child);
  };

  const kill = () => {
    if (!child?.pid || child.exitCode !== null) {
      return;
    }
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      try { child.kill(); } catch { /* already stopped */ }
    }
  };

  return {
    baseUrl,
    prepare,
    launch,
    close,
    kill,
    get,
    post,
  };
}

export async function removePath(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "EBUSY" || attempt === 9) {
        throw error;
      }
      await delay(300);
    }
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child) {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("App did not exit after close API.")), 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

