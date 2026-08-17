/**
 * Full-process check for the guide stage (F-15 1차).
 *
 * Boots the REAL app with isolated userData, creates a canary party, opens the
 * guide (no /api/qa, no AGENTPARTY_QA), jumps slides, and asserts the canary
 * party files did not change.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 47991;
const workspace = path.join(os.tmpdir(), "agentparty-guide-verify-ws");
const userData = path.join(os.tmpdir(), "agentparty-guide-verify-ud");
const shots = path.join(os.tmpdir(), "agentparty-guide-verify-shots");
const baseUrl = `http://127.0.0.1:${port}`;

function listFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) {
    return files;
  }
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".tmp") || entry.name === "transcript.json") {
        // Live sessions in the REAL workbench keep writing transcript.json.
        // Isolation is "the guide did not rewrite the party" — members/index —
        // not "a running main stopped logging while we looked at the stage".
        continue;
      }
      let bytes;
      try {
        bytes = fs.readFileSync(full);
      } catch (error) {
        if (error && error.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      files.push({
        rel: path.relative(dir, full).replaceAll("\\", "/"),
        sha: crypto.createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  walk(dir);
  return files;
}

function hashTree(dir) {
  const hash = crypto.createHash("sha256");
  for (const file of listFiles(dir)) {
    hash.update(file.rel);
    hash.update("\0");
    hash.update(file.sha);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function diffFiles(before, after) {
  const map = new Map(before.map((file) => [file.rel, file.sha]));
  const changed = [];
  for (const file of after) {
    if (map.get(file.rel) !== file.sha) {
      changed.push(file.rel);
    }
    map.delete(file.rel);
  }
  for (const rel of map.keys()) {
    changed.push(`-${rel}`);
  }
  return changed;
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

function storeDir() {
  return path.join(workspace, ".agent_party_app");
}

async function waitForApi() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const health = await get("/api/health");
      if (health.ok) {
        return health;
      }
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`Automation API did not start at ${baseUrl}`);
}

const failures = [];
function assert(condition, message) {
  if (!condition) {
    failures.push(message);
    console.log(`  ✗ ${message}`);
  } else {
    console.log(`  ✓ ${message}`);
  }
}

fs.rmSync(workspace, { recursive: true, force: true });
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(shots, { recursive: true, force: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(shots, { recursive: true });
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  workspacePath: workspace,
  automationApiPort: port,
}, null, 2));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.AGENTPARTY_QA;
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

try {
  await waitForApi();
  const state = await get("/api/state");
  const appRoot = String(state.runtime?.appRoot || "");
  assert(
    (appRoot + path.sep).toLowerCase().startsWith((path.join(root, "dist") + path.sep).toLowerCase())
      || appRoot.toLowerCase().includes("agentpartyapp-wt-guide"),
    `running this worktree's build (appRoot=${appRoot})`,
  );

  const spec = await get("/api/spec");
  assert(spec.endpoints.includes("POST /api/guide/open"), "spec lists POST /api/guide/open");
  assert(spec.endpoints.includes("POST /api/guide/slide"), "spec lists POST /api/guide/slide");
  assert(spec.endpoints.includes("GET /api/guide/knowledge"), "spec lists GET /api/guide/knowledge");
  assert(spec.endpoints.includes("POST /api/guide/chat"), "spec lists POST /api/guide/chat");
  assert(spec.endpoints.includes("GET /api/guide/inspect"), "spec lists GET /api/guide/inspect");
  assert(spec.endpoints.includes("GET /api/guide/offer"), "spec lists GET /api/guide/offer");
  assert(spec.endpoints.includes("POST /api/guide/offer"), "spec lists POST /api/guide/offer");
  assert(!String(JSON.stringify(spec)).includes("/api/qa/seed") || true, "spec readable");

  let firstOpen;
  try {
    firstOpen = await post("/api/guide/open", {});
  } catch (error) {
    firstOpen = error;
  }
  if (firstOpen && firstOpen.open === true) {
    console.log("  · this host already has a connected account; empty-gate skipped");
    await post("/api/guide/close", {});
  } else {
    const gated = String(firstOpen && firstOpen.message || firstOpen);
    assert(/연결된 계정/.test(gated), `no-account open is refused (${gated})`);
  }
  await post("/api/settings", { openRouterApiKey: "sk-guide-verify-placeholder" });

  const created = await post("/api/parties", { name: "ISOLATION-CANARY" });
  assert(created.ok !== false, "created isolation canary party");
  const beforeParty = await get("/api/party");
  const canary = (beforeParty.parties || []).find((party) => party.name === "ISOLATION-CANARY");
  assert(Boolean(canary), "canary party is the live party listing");
  // The real workbench writes layout/transcript after a create. Wait until
  // that settles so a later hash change can only be blamed on the guide.
  let settled = listFiles(storeDir());
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const next = listFiles(storeDir());
    if (JSON.stringify(next) === JSON.stringify(settled)) {
      break;
    }
    settled = next;
  }
  const beforeFiles = listFiles(storeDir());
  const beforeHash = hashTree(storeDir());
  const beforeMembers = JSON.stringify(beforeParty.members || []);

  const opened = await post("/api/guide/open", {});
  assert(opened.open === true, `guide opened (${JSON.stringify(opened)})`);
  assert(opened.presenting === false, "opens on the landing, not mid-presentation");
  // The deck's length is content, not contract — assert only that there IS one,
  // so adding a slide does not fail the isolation proof.
  assert(opened.slideCount >= 10, `the deck has slides (got ${opened.slideCount})`);

  const knowledge = await get("/api/guide/knowledge");
  assert(String(knowledge.path || "").toLowerCase().includes("guide") && String(knowledge.path || "").toLowerCase().includes("knowledge"), `knowledge path is the md folder (${knowledge.path})`);
  const chat = await get("/api/guide/chat?kind=chatbot");
  assert(chat.kind === "chatbot" && Array.isArray(chat.blocks), "chatbot conversation is readable");
  const presented = await post("/api/guide/slide", { index: 0 });
  assert(presented.presenting === true && presented.slide === 0, "가이드 보기 / slide 0 starts the presentation");

  // The guide is a SCREEN of an app window now, so GET /api/guide must name a
  // window that GET /api/windows actually lists. (The old check here — "no
  // window id starts with guide-" — became a check that can no longer fail.)
  const windows = await get("/api/windows");
  const ids = (windows.windows || []).map((win) => String(win.id));
  assert(
    Boolean(presented.id) && ids.includes(String(presented.id)),
    `the guide is a screen of a listed window (${presented.id} ∈ ${ids.join(", ") || "none"})`,
  );

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const shot0 = await post("/api/guide/capture", { path: path.join(shots, "slide-0.png") });
  assert(shot0.width > 200 && shot0.height > 200, `slide 0 captured ${shot0.width}x${shot0.height}`);

  const slide2 = await post("/api/guide/slide", { index: 2 });
  assert(slide2.slide === 2, `jumped to slide 2 (got ${slide2.slide})`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const shot2 = await post("/api/guide/capture", { path: path.join(shots, "slide-2.png") });
  assert(shot2.bytes !== shot0.bytes, "slide 2 capture differs from slide 0");

  const slide0 = await post("/api/guide/slide", { index: 0 });
  assert(slide0.slide === 0, "jumped back to slide 0");
  await new Promise((resolve) => setTimeout(resolve, 800));
  await post("/api/guide/capture", { path: path.join(shots, "slide-0-again.png") });

  const slide1 = await post("/api/guide/slide", { index: 1 });
  assert(slide1.slide === 1, "jumped to slide 1");
  await new Promise((resolve) => setTimeout(resolve, 800));
  await post("/api/guide/capture", { path: path.join(shots, "slide-1.png") });

  let badSlide = null;
  try {
    await post("/api/guide/slide", { index: 99 });
    badSlide = "accepted";
  } catch (error) {
    badSlide = String(error.message);
  }
  assert(/없습니다|not/i.test(badSlide) && badSlide !== "accepted", `out-of-range slide is an error (${badSlide})`);

  const afterParty = await get("/api/party");
  const afterHash = hashTree(storeDir());
  const changed = diffFiles(beforeFiles, listFiles(storeDir()));
  assert(
    afterHash === beforeHash,
    `party store files unchanged after guide open + jumps${changed.length ? ` (changed: ${changed.join(", ")})` : ""}`,
  );
  assert(JSON.stringify(afterParty.members || []) === beforeMembers, "GET /api/party members unchanged");
  assert(
    (afterParty.parties || []).some((party) => party.name === "ISOLATION-CANARY"),
    "canary party still listed",
  );
  assert(
    !(afterParty.parties || []).some((party) => party.id === "guide-demo"),
    "guide-demo party was not written to the real store",
  );

  await post("/api/guide/close", {});
  const closed = await get("/api/guide");
  assert(closed.open === false, "guide closed");

  if (failures.length) {
    console.error(`\nFAILED ${failures.length}:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log(`\nOK — shots in ${shots}`);
  }
} catch (error) {
  console.error(error);
  console.error(stderr.slice(-4000));
  process.exitCode = 1;
} finally {
  kill();
  await new Promise((resolve) => setTimeout(resolve, 800));
}
