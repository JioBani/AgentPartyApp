/*
 * DESIGN QA gallery for the MESSAGE QUEUE ([P-3]4) — OFFLINE.
 *
 * Reproduces every queue state the handoff specifies and captures one PNG per
 * state, so the design can be compared against
 * `docs/디자인 핸드오프/design_handoff_message_queue/screenshots/` by eye
 * WITHOUT running a single real turn. Every member here is a QA mock: no model
 * is called, nothing is billed, and a state that would take a live agent
 * minutes to reach (a 20-item queue, a queue mid-delivery) is one request.
 *
 * This exists because reaching these states through real turns is slow, costs
 * money, and is not reproducible — a live agent finishes when it feels like it,
 * so the interesting state disappears before the shutter opens.
 *
 * Correctness is NOT asserted here; `scripts/e2e-message-queue.mjs` does that
 * with measured geometry. This script only produces pictures.
 *
 * Run: node scripts/qa-queue-design.mjs [--keep] [--out <dir>]  (after `npm run build`)
 *   --keep  leaves the app running afterwards and prints its URL, so the state
 *           can be poked at by hand instead of only looked at.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForLiveBaseUrl } from "./lib/discovery.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ws = path.join(os.tmpdir(), "agentparty-queue-design-workspace");
const userData = path.join(os.tmpdir(), "agentparty-queue-design-user-data");

const keep = process.argv.includes("--keep");
const outIndex = process.argv.indexOf("--out");
const shotDir = outIndex > 0 && process.argv[outIndex + 1]
  ? path.resolve(process.argv[outIndex + 1])
  : path.join(os.tmpdir(), "agentparty-queue-design-shots");

let base = "";
const shots = [];

/** Captures the window and records it in the printed index. */
async function shot(name, caption, options = {}) {
  const file = path.join(shotDir, `${name}.png`);
  const result = await post("/api/capture", { path: file, ...options });
  shots.push({ name, caption, file, bytes: result.bytes });
  console.log(`  ✓ ${name} — ${caption}`);
}

const MEMBER = "backend";

async function main() {
  await removePath(ws);
  await removePath(userData);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(shotDir, { recursive: true });
  // The workspace comes from the isolated settings file — the app does NOT read
  // an env var for it.
  fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ workspacePath: ws }, null, 2));

  // The debug port stays open so a reviewer who doubts a picture can measure the
  // same state over CDP instead of arguing about pixels.
  const child = spawn(process.execPath, [path.join(root, "scripts", "launch-electron.mjs"), "--workspace", ws, "--remote-debugging-port=0"], {
    cwd: root,
    // --keep hands the app to a human, so it must outlive this script (and the
    // shell that started it). Detached AND unpiped: an inherited pipe dies with
    // the parent, and the app then crashes on its next write to it.
    stdio: keep ? "ignore" : ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: keep,
    env: {
      ...process.env,
      AGENTPARTY_QA: "1",
      AGENTPARTY_USER_DATA: userData,
      // Automated runs park the window on the left monitor so it stays out of
      // the way. --keep is for a person to LOOK at, so it opens where they are.
      AGENTPARTY_WINDOW_DISPLAY: keep ? "" : "left",
      AGENTPARTY_AUTOMATION_PORT: "",
    },
  });
  if (child.stderr) child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  try {
    base = await discover();
    // The build being photographed must be THIS worktree, or the gallery
    // documents someone else's app.
    const appRoot = (await get("/api/state")).runtime?.appRoot || "";
    const within = (appRoot + path.sep).toLowerCase().startsWith(root.toLowerCase() + path.sep);
    if (!within) throw new Error(`Running build is not this worktree (appRoot=${appRoot || "<missing>"}).`);
    console.log(`app: ${base}\nshots: ${shotDir}\n`);

    await post("/api/qa/seed", {
      party: "queue design",
      members: [
        { name: MEMBER, model: "claude-sonnet-4.5", role: "대기열 디자인 QA" },
        { name: "reviewer", model: "claude-sonnet-4.5", role: "리뷰" },
        { name: "docs", model: "claude-sonnet-4.5", role: "문서" },
      ],
    });
    await post("/api/navigation", { view: "workbench" });
    await post("/api/qa/open", { panels: [[MEMBER]] });
    await delay(900);

    await emptyQueue();
    await singleItem();
    await sameSenderRun();
    await mixedSenders();
    await mergeOff();
    await collapsed();
    await atTheLimit();
    await narrow();
    await afterDelivery();

    console.log("\nGallery:");
    for (const s of shots) console.log(`  ${s.name.padEnd(24)} ${s.caption}\n    ${s.file}`);
    console.log(`\n${shots.length} shots → ${shotDir}`);
  } catch (error) {
    killProcessTree(child.pid);
    throw error;
  }

  if (keep) {
    child.unref();
    console.log(`\nApp left running at ${base} (pid ${child.pid}). Close its window when done.`);
    console.log(`Reset to a clean party any time:  curl -X POST ${base}/api/qa/reset -d '{}'`);
    process.exit(0);
  }
  await post("/api/window/close", {}).catch(() => {});
  await waitForExit(child);
  process.exit(0);
}

/** Nothing waiting — the state a member spends most of its life in. */
async function emptyQueue() {
  console.log("\nempty:");
  await working();
  await shot("01-empty", "작업 중이지만 대기 중인 메시지가 없다");
}

async function singleItem() {
  console.log("\none item:");
  await send("테스트 다 돌고 나면 커버리지 리포트도 같이 붙여줘.");
  await shot("02-single", "1건 — 헤더 개수, 서수, 삭제/편집");
}

/** The merge rail only spans a run of the SAME sender; this is that run. */
async function sameSenderRun() {
  console.log("\nsame-sender run:");
  await clear();
  await send("아, 그리고 로그인 화면 여백이 좀 넓어 보여.");
  await send("버튼 색은 지금 게 맞아. 건드리지 마.");
  await send("에러 문구는 한국어로 통일해줘.");
  await send("다 되면 스크린샷 한 장만.");
  await shot("03-run", "같은 발신자 4건 — 병합 레일이 선두 런 전체를 감싼다");
  await shot("03b-run-expanded", "한 줄로 접힌 행을 확대 버튼으로 펼친 상태", { click: ".wb-queue-row .wb-queue-expand" });
  await post("/api/capture", { path: path.join(shotDir, "_recollapse.png"), click: ".wb-queue-row .wb-queue-expand" });
}

/** A run that ENDS at a sender change — the rail must stop there. */
async function mixedSenders() {
  console.log("\nmixed senders:");
  await clear();
  await send("이 부분 먼저 봐줘.");
  await send("급한 건 아니야.");
  await fromMember("reviewer", "리뷰 지적: 이 경로의 예외 처리를 좁혀줘.");
  await fromMember("docs", "문서 쪽 문구도 같이 바꿔야 해.");
  await shot("04-mixed", "발신자 혼합 — 칩, 병합 경계(다른 발신자끼리는 안 합쳐진다)");
}

/** Merge off: each item leaves alone, so the NEXT one is labelled. */
async function mergeOff() {
  console.log("\nmerge off:");
  await clear();
  await pref({ merge: false });
  await send("1단계: 실패하는 테스트부터 찾아줘.");
  await send("2단계: 원인 한 줄로 정리.");
  await send("3단계: 고치고 다시 돌려줘.");
  await shot("05-merge-off", "합치기 끔 — '다음' 뱃지, 레일 없음");
  await shot("05-merge-off-dark", "합치기 끔 (다크)", { theme: "dark" });
  await post("/api/capture", { path: path.join(shotDir, "_reset-theme.png"), theme: "light" });
  await pref({ merge: true });
}

async function collapsed() {
  console.log("\ncollapsed:");
  await pref({ collapsed: true });
  await shot("06-collapsed", "접힘 — 헤더만 남고 대화가 자리를 되찾는다");
  await pref({ collapsed: false });
}

/** 20 items is the limit; the panel must stay usable and must not overflow. */
async function atTheLimit() {
  console.log("\nat the 20-item limit:");
  await clear();
  for (let i = 1; i <= 20; i += 1) {
    await send(`대기 ${i}번째 — 목록이 길어져도 패널이 넘치지 않아야 한다.`);
  }
  await shot("07-limit", "한도 20건 — 스크롤/넘침 확인");
  await clear();
}

/** Under 408px the queue folds; a user reaches that by splitting the workbench. */
async function narrow() {
  console.log("\nnarrow panel:");
  await send("좁은 패널에서 확인할 첫 번째 메시지.");
  await send("좁은 패널에서 확인할 두 번째 메시지.");
  await post("/api/qa/open", { panels: [[MEMBER], ["reviewer"], ["docs"]] });
  await delay(900);
  await shot("08-narrow-collapsed", "좁은 패널 — 요약 칩 하나로 접힌 기본 상태");
  await pref({ collapsed: false });
  await shot("09-narrow-expanded", "좁은 패널 펼침 — 삭제만 남고 순서/편집/합치기는 빠진다");

  await post("/api/qa/open", { panels: [[MEMBER], ["reviewer"]] });
  await delay(900);
  await shot("10-mid", "중간 폭 — 넓은 폭과 좁은 폭 사이");
  await post("/api/qa/open", { panels: [[MEMBER]] });
  await delay(900);
  await clear();
}

/** Where a message came from must outlive its queue row. */
async function afterDelivery() {
  console.log("\nafter delivery:");
  await send("사용자가 대기열에 넣어둔 메시지.");
  await fromMember("reviewer", "리뷰어가 대기열에 넣어둔 메시지.");
  await shot("11-before-delivery", "전달 직전 — 두 발신자가 대기 중");
  await post(`/api/qa/members/${MEMBER}/emit`, { status: "idle" });
  await delay(1200);
  await shot("12-after-delivery", "쉬는 상태로 바뀌어 전달된 뒤 — 대화창의 출처 표시");
}

const working = async () => {
  await post(`/api/qa/members/${MEMBER}/emit`, { status: "working" });
  await delay(300);
};
const send = async (text) => {
  await working();
  await post(`/api/party/members/${MEMBER}/message`, { text });
  await delay(120);
};
const fromMember = async (from, content) => {
  await working();
  await post("/api/party/messages", { to: MEMBER, from, content });
  await delay(150);
};
const clear = async () => {
  await post(`/api/party/members/${MEMBER}/queue`, { action: "clear" }).catch(() => {});
  await delay(250);
};
const pref = async (body) => {
  await post(`/api/party/members/${MEMBER}/queue`, { action: "preference", ...body });
  await delay(400);
};

async function discover() {
  const url = await waitForLiveBaseUrl(ws);
  if (!url) throw new Error("App did not advertise an automation endpoint for the design-QA workspace.");
  return url;
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

// Only ever this app's own process tree. NEVER a blanket electron kill — the
// user has their own AgentParty running.
function killProcessTree(pid) {
  if (!pid) return;
  try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* already gone */ }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

main().catch((error) => { console.error(error); process.exit(1); });
