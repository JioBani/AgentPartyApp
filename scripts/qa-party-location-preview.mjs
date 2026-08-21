/*
 * Real-Electron visual evidence for the shipping party-group and cwd-picker
 * components. The renderer preview imports those components directly; no mock
 * copy of their markup or CSS is involved.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = `${Date.now()}-${process.pid}`;
const userData = path.join(os.tmpdir(), `agentparty-party-location-preview-${runId}`);
const evidence = path.join(os.tmpdir(), `agentparty-party-location-evidence-${runId}`);
const port = 49321;
const base = `http://127.0.0.1:${port}`;
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });

const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--remote-debugging-port=0"], {
  cwd: root,
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    AGENTPARTY_QA: "1",
    AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
    AGENTPARTY_AUTOMATION_PORT: String(port),
    AGENTPARTY_USER_DATA: userData,
    AGENTPARTY_RENDERER_URL: "http://127.0.0.1:5173/preview/index.html",
  },
});
child.stderr.on("data", () => {});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const post = async (route, body = {}) => {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${route} ${response.status}: ${await response.text()}`);
  return response.json();
};

try {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await fetch(`${base}/api/health`).then((response) => response.ok).catch(() => false)) break;
    await delay(250);
  }
  if (!(await fetch(`${base}/api/health`).then((response) => response.ok).catch(() => false))) {
    throw new Error("preview automation API did not start");
  }
  await post("/api/qa/window/bounds", { width: 1600, height: 950 });
  await delay(600);
  for (const theme of ["light", "dark"]) {
    const target = path.join(evidence, `party-location-${theme}.png`);
    const captured = await post("/api/capture", { path: target, theme, scrollSelector: "html", scrollY: 0 });
    if (!captured.ok || captured.bytes < 10_000 || !fs.existsSync(target)) {
      throw new Error(`${theme} preview capture was empty`);
    }
  }
  await post("/api/qa/window/bounds", { width: 1100, height: 760 });
  await delay(300);
  const compact = path.join(evidence, "party-location-compact.png");
  const compactCapture = await post("/api/capture", { path: compact, theme: "light", scrollSelector: "html", scrollY: 0 });
  if (!compactCapture.ok || compactCapture.bytes < 10_000) throw new Error("compact preview capture was empty");
  console.log(`PARTY LOCATION PREVIEW PASSED (${evidence})`);
} finally {
  try { await post("/api/window/close"); } catch { /* already gone */ }
  await delay(400);
  if (!child.killed) child.kill();
}
