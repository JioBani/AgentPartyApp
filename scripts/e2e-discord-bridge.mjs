/*
 * Full-process e2e for the Discord bridge (docs/기획 노트.md §11).
 *
 * Launches the REAL app, creates a real party member, and drives the bridge both
 * ways through the product's own surfaces:
 *   1. HTTP:  /api/discord, /api/party/members/:name/discord/{connect,send}
 *   2. AGENT: a live model turn where the member itself calls the
 *             agentparty-app discord-connect / discord-send MCP tools
 * Every assertion about Discord is verified against Discord's REST API, not
 * against our own return values.
 *
 * Requires DISCORD_BOT_TOKEN (+ DISCORD_USER_ID) in .env or the environment.
 * Inbound (a message the USER types) cannot be simulated by the bot itself — the
 * bridge ignores its own posts — so that leg is verified manually; this script
 * prints the channel to type in and waits for the member to answer.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Per-run dirs: a previous run's Electron may still be releasing its userData,
// and a shared path then fails to delete (EBUSY) before the new run even starts.
const runId = `${process.pid}-${Math.floor(Number(process.hrtime.bigint() % 100000n))}`;
const ws = path.join(os.tmpdir(), `agentparty-discord-bridge-ws-${runId}`);
const userData = path.join(os.tmpdir(), `agentparty-discord-bridge-user-data-${runId}`);
const memberName = "reporter";
const partyName = `e2e-discord-${process.pid}`;
const desktopName = `E2E-PC-${process.pid}`;
const model = process.env.AGENTPARTY_DISCORD_E2E_MODEL || "sonnet";
const waitForInbound = !process.argv.includes("--no-inbound");

loadDotEnv();
const token = (process.env.DISCORD_BOT_TOKEN || "").trim();
const userId = (process.env.DISCORD_USER_ID || "").trim();
if (!token) {
  fail("DISCORD_BOT_TOKEN is not set (put it in .env next to the app).");
}

const port = Number(process.env.AGENTPARTY_DISCORD_E2E_PORT || "") || 48971;
let base = `http://127.0.0.1:${port}`;
let channelId = "";
let threadId = "";

async function main() {
  rmrf(ws);
  rmrf(userData);
  fs.mkdirSync(ws, { recursive: true });

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_AUTOMATION_PORT: String(port),
      AGENTPARTY_WINDOW_DISPLAY: "left",
      DISCORD_BOT_TOKEN: token,
      DISCORD_USER_ID: userId,
      AGENTPARTY_DESKTOP_NAME: desktopName,
    },
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    await waitForApi();
    step(`app answering at ${base}`);
    assert((await getJson("/api/health")).ok, "health ok");

    const windows = await getJson("/api/windows");
    const windowId = windows.windows?.[0]?.id;
    assert(windowId, "window discovered");
    await post(`/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: ws });
    const state = await getJson("/api/state");
    assert(sameDir(state.settings?.workspacePath || state.workspacePath, ws), `served workspace is the e2e one (got ${state.settings?.workspacePath || state.workspacePath})`);
    assertDiscoveryInWorkspace();

    // 1. Status reflects the configured credentials, and NEVER leaks the token.
    const status = await getJson("/api/discord");
    assert(status.configured === true, "bridge reports configured");
    assert(!JSON.stringify(status).includes(token), "status never contains the raw token");
    assert(Array.isArray(status.allowedUserIds) && status.allowedUserIds.includes(userId), "whitelist carries the user id");
    step(`status: configured=${status.configured} tokenMask=${status.tokenMask} allowed=${status.allowedUserIds.join(",")}`);

    await post("/api/parties", { name: partyName });
    await post("/api/party/members", {
      name: memberName,
      requirement: "Report progress to the user over Discord.",
      role: "Reporting member for the Discord bridge e2e",
      runtime: "claude-code",
      model,
      permissionMode: "auto",
    });

    // 2. HTTP path: connect + send, verified against Discord itself.
    const connected = await post(`/api/party/members/${memberName}/discord/connect`, {});
    channelId = connected.channelId;
    threadId = connected.threadId;
    assert(connected.ok && channelId, "connect returned a channel");
    assert(connected.created === true, "a fresh channel was created");
    assert(connected.channel.startsWith(`${partyName}-`), `the channel is named after the party + a party-id slice (got #${connected.channel})`);
    assert(connected.thread === memberName, `the member has its own thread (got ${connected.thread})`);

    // The channel must sit under THIS desktop's category, and say which cwd and
    // party it serves — that is what keeps two PCs' identically-named parties apart.
    const layout = await discordLayout(connected.channelId);
    assert(layout.category === desktopName, `the channel lives under the desktop category (got ${layout.category})`);
    assert(layout.topic.includes(ws) && layout.topic.includes(partyName), "the channel topic carries the workspace + party identity");
    assert(layout.pinned.some((text) => text.includes(ws)), "a pinned header states the workspace");
    step(`layout: ${layout.category} / #${connected.channel} / ${connected.thread}`);
    step(`connected: #${connected.channel} (${channelId})`);

    const marker = `http-path-${Date.now()}`;
    await post(`/api/party/members/${memberName}/discord/send`, { content: `e2e ${marker}` });
    assert(await discordHasMessage(marker), "the HTTP send is visible in the Discord channel");
    step("HTTP send verified in Discord");

    // 3. The 2000-char rule REJECTS rather than truncating.
    const tooLong = await postRaw(`/api/party/members/${memberName}/discord/send`, { content: "x".repeat(2001) });
    assert(tooLong.status >= 400 || tooLong.body?.error, `over-long content is rejected (status ${tooLong.status})`);
    assert(/2000/.test(JSON.stringify(tooLong.body || "")), "the rejection explains the 2000 limit");
    step("over-long content rejected, not truncated");

    // 4. Agent path: a REAL model turn where the member drives the MCP tools.
    const started = await post(`/api/party/members/${memberName}/start`, { model, permissionMode: "auto" });
    const sessionId = await waitForSession(started.session?.id);
    step(`member session ${sessionId} running (${model})`);

    const agentMarker = `agent-path-${Date.now()}`;
    await post(`/api/party/members/${memberName}/message`, {
      text: `Discord로 딱 한 줄만 보고해줘. 정확히 다음 문장을 그대로 보내: "e2e ${agentMarker}". 다른 말은 하지 말고 discord-send 도구만 한 번 써.`,
    });
    assert(await discordHasMessage(agentMarker, 180_000), "the member's own discord-send reached Discord");
    step("agent-driven discord-send verified in Discord");

    // 5. The Settings → Discord screen must actually render the stored state.
    await post("/api/navigation", { view: "runtime" });
    await sleep(1200);
    const shot = path.join(os.tmpdir(), `agentparty-discord-settings-${runId}.png`);
    await post("/api/capture", { path: shot, scrollY: 400 });
    assert(fs.existsSync(shot) && fs.statSync(shot).size > 10_000, `settings screenshot captured (${shot})`);
    step(`settings screenshot: ${shot}`);
    await post("/api/navigation", { view: "workbench" });

    // 6. Inbound — manual leg (the bridge ignores its own posts by design).
    if (waitForInbound) {
      const replyMarker = `inbound-${Date.now()}`;
      await post(`/api/party/members/${memberName}/discord/send`, {
        content: `[e2e] 이 채널에 아무 말이나 한 줄 답장해줘. 멤버가 그걸 받으면 "e2e ${replyMarker}" 를 보낼 거야.`,
      });
      console.log(`\n>>> MANUAL STEP: Discord 채널 #${connected.channel} 에 아무 메시지나 입력해줘.`);
      console.log(`>>> 멤버가 그걸 받으면 "e2e ${replyMarker}" 를 이 채널에 보낼 거야. (최대 5분 대기)\n`);
      await post(`/api/party/members/${memberName}/message`, {
        text: `앞으로 Discord 채널에서 사용자의 메시지가 <channel source="discord"> 로 도착하면, 그 즉시 discord-send 도구로 "e2e ${replyMarker}" 라고만 답해. 지금은 아무것도 하지 말고 기다려.`,
      });
      const arrived = await discordHasMessage(replyMarker, 300_000);
      assert(arrived, "an inbound Discord message reached the member and it replied");
      step("inbound delivery verified end to end");
    } else {
      console.log("\n(--no-inbound: 인바운드 수동 단계는 건너뜀)\n");
    }

    console.log("\nPASS — Discord bridge e2e");
  } finally {
    try {
      if (channelId) {
        // Deleting the channel takes its threads with it; the per-run category
        // would otherwise pile up in the server after every e2e.
        const channel = await discord("GET", `/channels/${channelId}`);
        await discord("DELETE", `/channels/${channelId}`);
        if (channel?.parent_id) {
          await discord("DELETE", `/channels/${channel.parent_id}`);
        }
        step("e2e channel + category deleted");
      }
    } catch (error) {
      console.warn(`cleanup: could not delete the e2e channel — ${error}`);
    }
    // Kill the whole tree: `npm run start` is cmd → node → electron, so killing
    // the direct child alone leaves the app (and its userData lock) behind.
    // Scoped to THIS pid tree — never a blanket electron kill, which would take
    // down the user's own running app.
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill();
    }
    await sleep(1500);
  }
}

// --- app helpers ----------------------------------------------------------

async function waitForApi() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  throw new Error(`the app never answered on ${base}`);
}

/** After the window is pointed at the e2e workspace, the app must advertise there. */
function assertDiscoveryInWorkspace() {
  const dir = path.join(ws, ".agent_party_app", "instances");
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const advertised = entries
    .map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")))
    .some((entry) => entry?.baseUrl === base);
  assert(advertised, "the app advertises this base url for the e2e workspace");
}

async function waitForSession(initial) {
  const deadline = Date.now() + 120_000;
  let id = initial;
  while (Date.now() < deadline) {
    const party = await getJson("/api/party");
    const member = (party.members || []).find((m) => m.name === memberName);
    id = member?.sessionId || id;
    if (id && member?.status === "running") {
      return id;
    }
    await sleep(1000);
  }
  throw new Error("the member session never reached 'running'");
}

async function getJson(route) {
  const response = await fetch(`${base}${route}`);
  return response.json();
}

async function post(route, body) {
  const result = await postRaw(route, body);
  if (result.status >= 400 || result.body?.error) {
    throw new Error(`POST ${route} failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  return result.body;
}

async function postRaw(route, body) {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed };
}

// --- discord helpers (independent verification) ---------------------------

async function discord(method, route, body) {
  const response = await fetch(`https://discord.com/api/v10${route}`, {
    method,
    headers: {
      Authorization: `Bot ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    throw new Error(`Discord ${method} ${route} failed (${response.status}): ${text}`);
  }
  return parsed;
}

/** Reads the channel's category, topic and pinned headers straight from Discord. */
async function discordLayout(id) {
  const channel = await discord("GET", `/channels/${id}`);
  const parent = channel.parent_id ? await discord("GET", `/channels/${channel.parent_id}`) : undefined;
  const pinned = await discord("GET", `/channels/${id}/pins`);
  const items = Array.isArray(pinned) ? pinned : pinned?.items || [];
  return {
    category: parent?.name || "",
    topic: channel.topic || "",
    pinned: items.map((entry) => String(entry?.content || entry?.message?.content || "")),
  };
}

async function discordHasMessage(marker, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await discord("GET", `/channels/${threadId}/messages?limit=50`);
    if (messages.some((message) => String(message.content || "").includes(marker))) {
      return true;
    }
    await sleep(3000);
  }
  return false;
}

// --- misc -----------------------------------------------------------------

function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(root, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.trim().startsWith("#")) {
        const key = line.slice(0, eq).trim();
        if (process.env[key] === undefined) {
          process.env[key] = line.slice(eq + 1).trim();
        }
      }
    }
  } catch {
    /* no .env — rely on the environment */
  }
}

function sameDir(a, b) {
  return String(a || "").replace(/[\\/]+$/, "").toLowerCase() === String(b || "").replace(/[\\/]+$/, "").toLowerCase();
}

function assert(condition, label) {
  if (!condition) {
    fail(label);
  }
  console.log(`  ok: ${label}`);
}

function step(message) {
  console.log(`* ${message}`);
}

function fail(message) {
  console.error(`FAIL — ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exit(1);
});
