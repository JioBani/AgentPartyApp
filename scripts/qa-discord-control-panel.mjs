/*
 * Attended QA harness for the Discord control panel (docs/기획 노트.md §11.14).
 *
 * The automated e2e (scripts/e2e-discord-bridge.mjs) cannot cover the legs that
 * need a HUMAN in Discord: the bot ignores its own posts, so nothing can type a
 * command as the user, react-watch its own message, or attach a photo. This
 * script sets that stage up and then GETS OUT OF THE WAY — it leaves the real
 * app running so the tester can drive Discord by hand.
 *
 *   node scripts/qa-discord-control-panel.mjs          # set up and leave running
 *   node scripts/qa-discord-control-panel.mjs --status # what is bound right now
 *   node scripts/qa-discord-control-panel.mjs --stop    # kill the app, delete the channel
 *
 * Isolated userData and a temp workspace, so the tester's own installed
 * AgentParty is untouched — and its bindings are invisible here, which is
 * itself part of what we want to see (a second desktop must stay silent).
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qaRoot = path.join(os.tmpdir(), "agentparty-qa-discord");
const ws = path.join(qaRoot, "workspace");
const userData = path.join(qaRoot, "user-data");
const statePath = path.join(qaRoot, "qa-state.json");
const desktopName = "QA-PC";
const partyName = "qa-discord";
const memberName = "reporter";
const model = process.env.AGENTPARTY_QA_MODEL || "sonnet";

loadDotEnv();
const token = (process.env.DISCORD_BOT_TOKEN || "").trim();
const userId = (process.env.DISCORD_USER_ID || "").trim();

const mode = process.argv.includes("--stop") ? "stop" : process.argv.includes("--status") ? "status" : "start";
run().catch((error) => {
  console.error(`\nFAILED: ${error?.message || error}`);
  process.exit(1);
});

async function run() {
  if (mode === "stop") {
    return stop();
  }
  if (mode === "status") {
    return status();
  }
  return start();
}

// --- start ----------------------------------------------------------------

async function start() {
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is not set (put it in .env next to the app).");
  }
  if (!userId) {
    throw new Error("DISCORD_USER_ID is not set — with an empty whitelist the bridge ignores EVERY message, by design.");
  }
  if (readState()?.pid && alive(readState().pid)) {
    console.log("A QA app is already running. Use --status, or --stop to tear it down.");
    return;
  }

  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  step(`workspace ${ws}`);

  const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
    cwd: root,
    // Detached: this script sets the stage and exits; the app has to outlive it.
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      // Never take the installed app's single-instance lock (it would hijack
      // "open with" for the user's real app).
      AGENTPARTY_ALLOW_MULTI_INSTANCE: "1",
      AGENTPARTY_USER_DATA: userData,
      AGENTPARTY_WINDOW_DISPLAY: "left",
      DISCORD_BOT_TOKEN: token,
      DISCORD_USER_ID: userId,
      AGENTPARTY_DESKTOP_NAME: desktopName,
    },
    windowsHide: false,
  });
  child.unref();
  writeState({ pid: child.pid, startedAt: new Date().toISOString() });

  // No fixed port: the app publishes its real base url per workspace. The
  // default workspace is served first, so watch for ANY instance file this
  // userData's process wrote.
  const base = await waitForApi();
  step(`app answering at ${base}`);

  const windows = await getJson(base, "/api/windows");
  const windowId = windows.windows?.[0]?.id;
  if (!windowId) {
    throw new Error("the app started but reported no window");
  }
  await post(base, `/api/windows/${encodeURIComponent(windowId)}/workspace`, { workspacePath: ws });
  step(`window pointed at the QA workspace`);

  const discord = await getJson(base, "/api/discord");
  if (discord.connection === "error") {
    throw new Error(`the Discord gateway is not connected: ${discord.error}`);
  }
  step(`discord: ${discord.connection} as ${discord.botUser?.username || "(identifying)"} · desktop ${discord.desktopName}`);

  // A party and one member, created through the ordinary product paths.
  const existing = await getJson(base, "/api/party");
  const party = (existing.parties || []).find((entry) => entry.name === partyName)
    || (await post(base, "/api/parties", { name: partyName })).party
    || (await getJson(base, "/api/party")).parties.find((entry) => entry.name === partyName);
  if (!(existing.members || []).some((member) => member.name === memberName)) {
    await post(base, "/api/party/members", {
      name: memberName,
      requirement: "Discord 제어판 QA용 멤버. 사용자가 디스코드에서 보낸 지시에 짧게 답한다.",
      role: "QA reporter",
      runtime: "claude-code",
      model,
      permissionMode: "auto",
    });
    step(`member '${memberName}' created (${model}, permission auto)`);
  }

  // Register + connect through the CONTROL PANEL itself, so the stage is set the
  // same way the tester would set it from Discord.
  const registered = await post(base, "/api/discord/command", { content: `!등록 ${shortId(party?.id || "")}`, post: false });
  const channelId = (registered.reply?.match(/<#(\d+)>/) || [])[1];
  if (!channelId) {
    throw new Error(`!등록 did not return a channel: ${registered.reply}`);
  }
  const connected = await post(base, "/api/discord/command", { content: `!연결 ${memberName}`, channelId, post: false });
  const threadId = (connected.reply?.match(/<#(\d+)>/) || [])[1];
  if (!threadId) {
    throw new Error(`!연결 did not return a thread: ${connected.reply}`);
  }
  await post(base, `/api/party/members/${memberName}/start`, { model, permissionMode: "auto" });
  writeState({ pid: child.pid, base, channelId, threadId, guildId: discord.guildId, startedAt: new Date().toISOString() });
  step(`channel ${channelId} · thread ${threadId} · member session started`);

  // A first post so the thread is easy to find on a phone.
  await post(base, `/api/party/members/${memberName}/discord/send`, {
    content: `🧪 **QA 준비 완료** — 데스크톱 \`${desktopName}\`, 파티 \`${partyName}\`, 멤버 \`${memberName}\`.\n이 스레드에 그냥 말을 걸거나 \`!도움말\` 을 쳐보세요.`,
  });

  printManualChecklist(discord.guildId, channelId, threadId);
}

function printManualChecklist(guildId, channelId, threadId) {
  console.log(`
════════════════════════════════════════════════════════════════════
 QA 환경 준비됐어. 아래 순서대로 디스코드에서 직접 해보면 돼.
 (앱은 계속 떠 있어. 끝나면 --stop 으로 정리)

 카테고리   ${desktopName}
 채널       https://discord.com/channels/${guildId}/${channelId}
 멤버 스레드 https://discord.com/channels/${guildId}/${threadId}
════════════════════════════════════════════════════════════════════

 1) 멤버 스레드에 아무 말이나 한 줄 써봐 (예: "지금 상태 한 줄로 알려줘")
    → 네가 쓴 그 메시지에 리액션이 순서대로 붙어야 해:
         📨 전달됨  →  ⚙️ 모델이 턴 시작  →  ✅ 턴 종료
    → 멤버 답이 스레드로 와야 해.

 2) 같은 스레드에 '!상태' 를 쳐봐
    → 봇이 멤버 목록 + 상태로 답해야 해. (모델이 아니라 앱이 답하는 거라 즉시)

 3) 파티 채널(스레드 말고 채널 본문)에 '!도움말' → 명령 목록
    그 다음 '!파티' → 파티 목록과 짧은 id
    아무 채널에서나 '!pc' → 이 데스크톱(QA-PC)이 자기를 소개

 4) 멤버 스레드에 이미지 한 장 첨부해서 보내봐 (글 없이 사진만도 OK)
    → 멤버가 "이미지에 뭐가 보이는지 말해줘" 같은 요청에 실제로 답해야 해.
    → 이미지가 아닌 파일(예: .txt)을 보내면 봇이 "전달하지 못했습니다" 라고 알려줘야 해.

 5) 멤버한테 긴 작업을 시켜놓고(예: "1부터 300까지 세줘")
    스레드에 '!중단' → 턴이 멈춰야 해.
    이어서 '!재시작' → 세션이 재시작됐다고 답해야 해.

 6) (있으면) 네 원래 AgentParty 앱도 켜져 있는 상태에서 위를 해봐.
    → 그쪽은 이 채널에 대해 아무 말도 하면 안 돼. 응답이 두 번 오면 그게 버그야.

 확인용:  node scripts/qa-discord-control-panel.mjs --status
 정리:    node scripts/qa-discord-control-panel.mjs --stop
`);
}

// --- status / stop --------------------------------------------------------

async function status() {
  const state = readState();
  if (!state?.pid || !alive(state.pid)) {
    console.log("No QA app is running. Start one with: node scripts/qa-discord-control-panel.mjs");
    return;
  }
  const discord = await getJson(state.base, "/api/discord");
  console.log(`app pid ${state.pid} at ${state.base}`);
  if (state.guildId && state.threadId) {
    console.log(`thread: https://discord.com/channels/${state.guildId}/${state.threadId}`);
  }
  console.log(`discord: ${discord.connection}${discord.error ? ` — ${discord.error}` : ""}`);
  console.log(`desktop: ${discord.desktopName} · bot: ${discord.botUser?.username || "?"}`);
  for (const channel of discord.partyChannels || []) {
    console.log(`  channel #${channel.channelName} · party ${channel.partyName} · owner pid ${channel.owner?.pid}`);
  }
  for (const binding of discord.bindings || []) {
    console.log(`  thread ${binding.threadName} · member ${binding.member} · owner pid ${binding.owner?.pid}`);
  }
  const members = await post(state.base, `/api/party/members/${memberName}/status`, {});
  for (const member of members.members || []) {
    console.log(`  member ${member.name}: ${member.status} (turns ${member.turnCount ?? 0}${member.turnActive ? ", RUNNING" : ""})`);
  }
}

async function stop() {
  const state = readState();
  if (!state) {
    console.log("Nothing to stop.");
    return;
  }
  if (state.channelId && token) {
    try {
      const channel = await discordApi("GET", `/channels/${state.channelId}`);
      await discordApi("DELETE", `/channels/${state.channelId}`);
      if (channel?.parent_id) {
        await discordApi("DELETE", `/channels/${channel.parent_id}`);
      }
      step("QA channel + category deleted from Discord");
    } catch (error) {
      console.warn(`could not delete the QA channel — ${error?.message || error}`);
    }
  }
  if (state.pid && alive(state.pid)) {
    // Kill the tree: `npm run start` is cmd → node → electron. Scoped to THIS
    // pid only — never a blanket electron kill, which would take down the
    // tester's own app.
    try {
      execFileSync("taskkill", ["/PID", String(state.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
    step(`QA app (pid ${state.pid}) stopped`);
  }
  fs.rmSync(statePath, { force: true });
  console.log(`\nWorkspace left in place for inspection: ${qaRoot}`);
}

// --- helpers --------------------------------------------------------------

/**
 * Finds the QA app's automation base url from the per-workspace discovery files
 * it writes. No fixed port: an installed app persists its own port, and a QA
 * process that grabbed it once rewired the user's real workspace.
 */
async function waitForApi() {
  const deadline = Date.now() + 120_000;
  const candidates = [ws, process.cwd(), path.join(os.homedir())];
  while (Date.now() < deadline) {
    for (const dir of candidates) {
      for (const entry of readInstances(dir)) {
        if (!alive(entry.pid)) {
          continue;
        }
        try {
          const health = await fetch(`${entry.baseUrl}/api/health`);
          if (health.ok) {
            // Only OUR process: the tester's own app also advertises itself.
            const discord = await (await fetch(`${entry.baseUrl}/api/discord`)).json();
            if (discord?.desktopName === desktopName) {
              return entry.baseUrl;
            }
          }
        } catch {
          /* not listening yet */
        }
      }
    }
    await sleep(1000);
  }
  throw new Error("the QA app never answered (check the Electron window for a startup error)");
}

function readInstances(workspace) {
  const dir = path.join(workspace, ".agent_party_app", "instances");
  try {
    return fs.readdirSync(dir).map((file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
  } catch {
    return [];
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function shortId(partyId) {
  const tail = String(partyId || "").split("-").pop() || "";
  return tail.slice(-6).toLowerCase();
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return undefined;
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ ...readState(), ...state }, null, 2));
}

async function getJson(base, route) {
  const response = await fetch(`${base}${route}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GET ${route} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function post(base, route, payload) {
  const response = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`POST ${route} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

async function discordApi(method, route) {
  const response = await fetch(`https://discord.com/api/v10${route}`, {
    method,
    headers: { Authorization: `Bot ${token}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Discord ${method} ${route} failed (${response.status}): ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}

function loadDotEnv() {
  try {
    const text = fs.readFileSync(path.join(root, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq > 0 && !line.trim().startsWith("#")) {
        const key = line.slice(0, eq).trim();
        if (!process.env[key]) {
          process.env[key] = line.slice(eq + 1).trim();
        }
      }
    }
  } catch {
    /* no .env — the environment may already carry the values */
  }
}

function step(message) {
  console.log(`* ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
