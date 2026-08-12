/*
 * Live demo of the approval cards, driven entirely from RECORDED harness traffic.
 *
 * Launches the real app on an isolated userData + temp workspace, seeds mock
 * members, and injects each recorded scenario so every card can be seen and
 * clicked WITHOUT a model call. This is the payoff of B-18: the card content is
 * the real thing the harness sends, so design and QA no longer need a billed
 * turn per look.
 *
 * Captures a PNG per card and LEAVES THE APP RUNNING so the cards can be
 * clicked. Not a test — a demo aid.
 *
 * Run: node scripts/demo-approval-cards.mjs [--shots <dir>] [--close]
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
// Defaults NEXT TO THE DOC, not into the OS temp dir: these are a handoff
// artifact for whoever redesigns the card, and temp gets swept.
const shotDir = path.resolve(argOf("--shots", path.join(root, "docs", "베타 공개 준비", "승인 카드 캡처")));
const closeAfter = argv.includes("--close");

const ws = path.resolve(os.tmpdir(), "agentparty-b18-demo-ws");
const userData = path.resolve(os.tmpdir(), "agentparty-b18-demo-user-data");
// Isolated userData owns this port, and the workspace is asserted below, so the
// user's own running app is never addressed.
const port = 49233;
const base = `http://127.0.0.1:${port}`;

fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
fs.mkdirSync(shotDir, { recursive: true });

const post = async (route, body) => {
  const r = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`${route} ${r.status}: ${await r.text()}`);
  return r.json();
};
const get = async (route) => {
  const r = await fetch(base + route);
  if (!r.ok) throw new Error(`${route} ${r.status}`);
  return r.json();
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * Each card gets its own member so all of them stay on screen together and the
 * runtime badge matches the harness that actually sent the payload.
 */
const CARDS = [
  { member: "codex-cmd", runtime: "codex", scenario: "codex-command-once", caption: "Codex 명령 승인 — 사유·명령·cwd·규칙 + 결정 4종" },
  { member: "codex-plain", runtime: "codex", scenario: "codex-untrusted-no-reason", caption: "Codex untrusted — 요청 사유가 없는 카드" },
  { member: "codex-file", runtime: "codex", scenario: "codex-file-change", caption: "Codex 파일 변경 — 규칙 없음(3버튼), diff 도 cwd 도 안 옴" },
  { member: "claude-bash", runtime: "claude-code", scenario: "claude-bash", caption: "Claude Bash — blockedPath + 'echo one *' 규칙 + 항상 허용" },
  { member: "claude-edit", runtime: "claude-code", scenario: "claude-file-edit", caption: "Claude Edit — 파일 diff (before/after)" },
  { member: "claude-outside", runtime: "claude-code", scenario: "claude-write-outside-cwd", caption: "Claude 작업공간 밖 쓰기 — 사유가 붙는 변종" },
];

/*
 * Resolved states. Unlike the card CONTENT these are the app's own rendering,
 * not harness data, so driving them through the real approve endpoint is the
 * honest way to produce them: inject, then answer, and shoot what is left
 * behind.
 */
const RESOLVED = [
  { member: "codex-allowed", runtime: "codex", scenario: "codex-command-once", behavior: "allow", caption: "Codex — 승인함" },
  { member: "codex-denied", runtime: "codex", scenario: "codex-command-once", behavior: "deny", caption: "Codex — 거부함" },
  { member: "claude-allowed", runtime: "claude-code", scenario: "claude-bash", behavior: "allow", caption: "Claude — 승인함" },
  { member: "claude-denied", runtime: "claude-code", scenario: "claude-bash", behavior: "deny", caption: "Claude — 거부함" },
];

/*
 * Context compaction. The figures are the SDK's own `compact_metadata` fields —
 * `pre_tokens`/`post_tokens`/`duration_ms` and the LENGTH of
 * `preserved_messages.uuids` (there is no count field). Codex sends none of
 * them, which is why one card here carries no numbers at all: that is the real
 * Codex shape, not an oversight.
 */
const COMPACTS = [
  { member: "cmp-run", runtime: "claude-code", caption: "압축 중 — 경과 시간 + 스윕 바", events: [{ type: "compact_state", state: "running", trigger: "manual" }] },
  { member: "cmp-done", runtime: "claude-code", caption: "압축됨 — 수치 전부 도착", events: [{ type: "compact_state", state: "done", trigger: "manual", preTokens: 823598, postTokens: 6883, durationMs: 197155, keptCount: 3 }] },
  { member: "cmp-bare", runtime: "codex", caption: "압축됨 — Codex(수치 없음)", events: [{ type: "compact_state", state: "done" }] },
  { member: "cmp-fail", runtime: "claude-code", caption: "압축 실패 — 다시 시도", events: [{ type: "compact_state", state: "failed", reason: "context too short to compact" }] },
];

/*
 * An ANSWERED question. This state was missing from the sheet, and that is
 * exactly why it shipped still wearing the pending card's shell: nothing here
 * ever rendered it, so no capture and no measurement could disagree with it.
 */
const ANSWERED = [
  {
    member: "q-answered",
    runtime: "claude-code",
    caption: "질문 — 답변함 (처리 후)",
    questions: [{ question: "어떤 하네스로 만들까요?", header: "멤버 설정", multiSelect: false, options: [{ label: "Claude Code" }, { label: "Codex" }] }],
    answers: { "어떤 하네스로 만들까요?": "Claude Code" },
  },
  {
    // Three answers, one of them long. A single-question case cannot show the
    // defect this card was rebuilt for: the answers after the first were not
    // readable at all, and nothing here rendered more than one.
    member: "q-answered-many",
    runtime: "claude-code",
    caption: "질문 — 여러 답변 + 긴 답변(전체 보기)",
    questions: [
      { question: "멘션을 어떻게 적용할까요?", header: "적용 여부", multiSelect: false, options: [{ label: "텍스트로만 넣는다" }] },
      { question: "단일 @ 는 어떻게 처리할까요?", header: "단일 @", multiSelect: false, options: [{ label: "'@@' 만 멤버, '@' 는 아무 것도 안 한다" }] },
      { question: "키 배분은 어떤 기준으로 나눌까요?", header: "키 배분", multiSelect: false, options: [{ label: "일반" }] },
    ],
    answers: {
      "멘션을 어떻게 적용할까요?": "텍스트로만 넣는다",
      "단일 @ 는 어떻게 처리할까요?": "'@@' 만 멤버로 인식하고, '@' 하나만 적힌 경우에는 아무 것도 하지 않는다",
      "키 배분은 어떤 기준으로 나눌까요?": "일반 배분을 그대로 쓰되 멤버가 직접 지정한 값이 있으면 그쪽을 우선한다",
    },
  },
];

/*
 * The interactive question card (기능정의서 1-10-2). These go through the
 * askUserQuestion injection, whose shape mirrors what Claude's AskUserQuestion
 * sends. ⚠️ Codex's own `item/tool/requestUserInput` could NOT be recorded —
 * the model never called it (the schema marks it EXPERIMENTAL), so the Codex
 * variant of this card is UNVERIFIED and is deliberately absent here rather
 * than mocked up from the type alone.
 */
const QUESTIONS = [
  {
    member: "q-single", caption: "질문 — 단일 선택 + 선택지 설명",
    questions: [{ question: "어떤 작업을 진행할까요?", header: "작업 선택", multiSelect: false, options: [
      { label: "코드 리뷰", description: "현재 변경점을 리뷰합니다." },
      { label: "버그 수정", description: "보고된 버그를 수정합니다." },
    ] }],
  },
  {
    member: "q-multi", caption: "질문 — 다중 선택",
    questions: [{ question: "어떤 검사를 돌릴까요?", header: "검사", multiSelect: true, options: [
      { label: "타입체크", description: "tsc --noEmit" },
      { label: "단위 테스트", description: "npm run test:ui" },
      { label: "빌드", description: "npm run build" },
    ] }],
  },
  {
    member: "q-free", caption: "질문 — 자유 입력 (선택지 없음)",
    questions: [{ question: "브랜치 이름을 정해주세요.", header: "브랜치", multiSelect: false, options: [] }],
  },
  {
    member: "q-secret", caption: "질문 — 비밀 입력 (마스킹)",
    questions: [{ question: "API 키를 입력하세요.", header: "인증", multiSelect: false, secret: true, options: [] }],
  },
  {
    member: "q-steps", caption: "질문 — 다중 질문 (이전/다음/건너뛰기)",
    questions: [
      { question: "배포 대상은?", header: "1/3", multiSelect: false, options: [{ label: "스테이징" }, { label: "프로덕션" }] },
      { question: "마이그레이션을 함께 돌릴까요?", header: "2/3", multiSelect: false, options: [{ label: "예" }, { label: "아니오" }] },
      { question: "알림을 보낼 채널은?", header: "3/3", multiSelect: false, options: [{ label: "#deploy" }, { label: "#general" }] },
    ],
  },
];

/*
 * Refuse to reuse an instance already on this port. A previous demo left one
 * running, the next run connected straight to it, and every capture came from
 * the OLDER bundle — the scenarios added in between simply "did not exist".
 * Silently driving a stale build is worse than not running.
 */
const stale = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
if (stale) {
  console.error(`An app is already serving ${base} — probably a previous demo.`);
  console.error("Close that window first: its build may predate the scenarios you are trying to show.");
  process.exit(1);
}

/*
 * Build FIRST. The guard above only refuses a stale running app, so a source
 * change that was never compiled sailed straight past it: `npm run start` does
 * not build, the demo drove the previous bundle, and the failure it produced
 * pointed at the source we had just fixed. Same hazard the guard exists for.
 */
const build = spawnSync(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "build"], { cwd: root, stdio: "inherit", windowsHide: true });
if (build.status !== 0) {
  console.error("Build failed — refusing to demo a bundle that does not match the source.");
  process.exit(1);
}

const child = spawn(process.env.ComSpec || "cmd.exe", ["/c", "npm", "run", "start"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  env: {
    ...process.env,
    AGENTPARTY_QA: "1",
    AGENTPARTY_AUTOMATION_PORT: String(port),
    AGENTPARTY_USER_DATA: userData,
    AGENTPARTY_WINDOW_DISPLAY: "left",
  },
});
child.stderr.on("data", (c) => process.stderr.write(c));

const waitForApi = async () => {
  for (let i = 0; i < 90; i += 1) {
    try {
      if ((await get("/api/health")).ok) return;
    } catch { /* still starting */ }
    await delay(500);
  }
  throw new Error(`app did not start at ${base}`);
};

async function main() {
  await waitForApi();

  const windows = (await get("/api/windows")).windows || [];
  await post(`/api/windows/${windows[0].id}/workspace`, { workspacePath: ws });

  // `settings.workspacePath` — there is no top-level one, so this read
  // `undefined` and the `served &&` skipped the comparison altogether. The
  // guard reported success without ever checking the target it was protecting.
  const served = (await get("/api/state"))?.settings?.workspacePath;
  if (!served) {
    throw new Error("refusing to drive: /api/state reported no workspace, so the target cannot be verified");
  }
  if (path.resolve(served) !== ws) {
    throw new Error(`refusing to drive: app serves '${served}', not the demo workspace`);
  }

  const all = [...CARDS, ...RESOLVED, ...QUESTIONS, ...ANSWERED, ...COMPACTS];
  await post("/api/qa/reset").catch(() => {});
  await post("/api/qa/seed", {
    party: "승인 카드 데모",
    // The runtime travels WITH the model. Seeding a Codex model onto the
    // default claude-code runtime made the badge lie about which harness sent
    // the card, and the beta cross-harness lock then rejected the pair outright.
    members: all.map((c) => ({
      name: c.member,
      role: c.caption,
      runtime: c.runtime,
      model: c.runtime === "codex" ? "gpt-5.4-mini" : "claude-sonnet-4.5",
    })),
  });

  const shot = async (member, name, extra) => {
    await post("/api/qa/open", { panels: [[member]] });
    await delay(700);
    const file = path.join(shotDir, `${name}.png`);
    await post("/api/capture", { path: file, ...extra });
    console.log(`  → ${name}.png`);
  };

  console.log("\nPending cards (recorded harness payloads, no model call):");
  for (const card of CARDS) {
    await post(`/api/qa/members/${card.member}/interaction`, { type: "approval", scenario: card.scenario });
    await shot(card.member, `pending-${card.scenario}`);
  }

  console.log("\nResolved states (injected, then answered through the real approve endpoint):");
  for (const card of RESOLVED) {
    const { requestId } = await post(`/api/qa/members/${card.member}/interaction`, { type: "approval", scenario: card.scenario });
    const sessionId = (await get("/api/party")).members.find((m) => m.name === card.member)?.sessionId;
    await post(`/api/sessions/${sessionId}/approve`, { requestId, behavior: card.behavior });
    await delay(400);
    await shot(card.member, `resolved-${card.member}`);
  }

  console.log("\nQuestion cards (기능정의서 1-10-2):");
  for (const q of QUESTIONS) {
    await post(`/api/qa/members/${q.member}/interaction`, { type: "askUserQuestion", questions: q.questions });
    await shot(q.member, `question-${q.member}`);
  }

  // Answered through the SAME approve call the card's button makes, so the
  // captured state is one a user could actually reach.
  for (const a of ANSWERED) {
    const { requestId } = await post(`/api/qa/members/${a.member}/interaction`, { type: "askUserQuestion", questions: a.questions });
    const sessionId = (await get("/api/party")).members.find((m) => m.name === a.member)?.sessionId;
    await post(`/api/sessions/${sessionId}/approve`, { requestId, behavior: "allow", updatedInput: { questions: a.questions, answers: a.answers } });
    await delay(400);
    await shot(a.member, `question-${a.member}`);
  }

  console.log("\n대화 압축 블록:");
  for (const c of COMPACTS) {
    await post(`/api/qa/members/${c.member}/emit`, { events: c.events });
    await shot(c.member, `compact-${c.member}`);
  }

  await post("/api/qa/open", { panels: COMPACTS.map((c) => [c.member]) });
  await delay(900);
  await post("/api/capture", { path: path.join(shotDir, "sheet-compact.png") });
  await post("/api/capture", { path: path.join(shotDir, "sheet-compact-dark.png"), theme: "dark" });

  // Contact sheets, plus a dark pass since the colours are tokens.
  await post("/api/qa/open", { panels: CARDS.map((c) => [c.member]) });
  await delay(900);
  await post("/api/capture", { path: path.join(shotDir, "sheet-pending.png") });
  await post("/api/capture", { path: path.join(shotDir, "sheet-pending-dark.png"), theme: "dark" });
  await post("/api/capture", { path: path.join(shotDir, "sheet-pending-light.png"), theme: "light" });

  await post("/api/qa/open", { panels: QUESTIONS.map((q) => [q.member]) });
  await delay(900);
  await post("/api/capture", { path: path.join(shotDir, "sheet-questions.png") });
  await post("/api/capture", { path: path.join(shotDir, "sheet-questions-dark.png"), theme: "dark" });

  await post("/api/capture", { path: path.join(shotDir, "sheet-resolved.png"), theme: "light" });
  await post("/api/qa/open", { panels: RESOLVED.map((c) => [c.member]) });
  await delay(900);
  await post("/api/capture", { path: path.join(shotDir, "sheet-resolved.png") });

  fs.writeFileSync(path.join(shotDir, "INDEX.md"), indexDoc());

  // Leave a readable card on screen for the person looking at the window.
  await post("/api/qa/open", { panels: [["claude-bash"], ["codex-cmd"]] });

  console.log(`\nShots: ${shotDir}`);
  console.log(`App is RUNNING on ${base} (left monitor). Cards are live — click them.`);
  console.log("Close it from the window, or re-run with --close.");

  if (closeAfter) {
    await post("/api/window/close", {}).catch(() => {});
  }
}

/**
 * The handoff note, copied from scripts/fixtures/approvals/INDEX.template.md.
 *
 * Kept as a markdown FILE rather than a string in here: it is prose for whoever
 * redesigns the card, it is full of backticks, and it should be editable and
 * reviewable as markdown instead of as an escaped JS template literal.
 *
 * It is organised by approval TYPE, not by the prompts used to record the
 * shots. A designer given "I asked Codex to make a file" designs for that one
 * command; given "arbitrary command execution, and here is what the user must
 * judge" they design the case.
 */
function indexDoc() {
  return fs.readFileSync(path.join(root, "scripts", "fixtures", "approvals", "INDEX.template.md"), "utf8");
}

main().catch(async (error) => {
  console.error(`demo failed: ${error?.message || error}`);
  await post("/api/window/close", {}).catch(() => {});
  process.exit(1);
});
