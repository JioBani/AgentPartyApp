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
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const argOf = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
const shotDir = path.resolve(argOf("--shots", path.join(os.tmpdir(), "b18-approval-shots")));
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
    questions: [{ question: "어떤 검사를 돌릴까요? (복수 선택)", header: "검사", multiSelect: true, options: [
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

  const served = (await get("/api/state"))?.workspacePath;
  if (served && path.resolve(served) !== ws) {
    throw new Error(`refusing to drive: app serves '${served}', not the demo workspace`);
  }

  const all = [...CARDS, ...RESOLVED, ...QUESTIONS];
  await post("/api/qa/reset").catch(() => {});
  await post("/api/qa/seed", {
    party: "승인 카드 데모",
    members: all.map((c) => ({ name: c.member, role: c.caption, model: c.runtime === "codex" ? "gpt-5.4-mini" : "claude-sonnet-4.5" })),
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
 * The handoff note. A designer needs to know which of these are real and which
 * are missing, because a card drawn from a shape nobody has observed is a guess
 * dressed as a spec — the exact thing B-18 was opened about.
 */
function indexDoc() {
  const rows = [
    ...CARDS.map((c) => `| \`pending-${c.scenario}.png\` | ${c.caption} | ✅ 실측 녹화 |`),
    ...RESOLVED.map((c) => `| \`resolved-${c.member}.png\` | ${c.caption} | ✅ 실측 카드 + 실제 응답 |`),
    ...QUESTIONS.map((q) => `| \`question-${q.member}.png\` | ${q.caption} | 🟡 Claude 스키마 기준 (Codex 변형 미확인) |`),
  ].join("\n");

  return `# 승인 카드 — 전수 캡처 (디자인 인계용)

생성: \`node scripts/demo-approval-cards.mjs\`
카드 내용은 **실제 하네스가 보낸 값**이다(\`scripts/fixtures/approvals/*.jsonl\`).
모델 호출 없이 재생된다.

| 파일 | 무엇 | 근거 |
|---|---|---|
${rows}
| \`sheet-*.png\` | 나란히 본 것 + 다크/라이트 | — |

## ⚠️ 아직 실측 못 한 케이스 — **여기는 비워 둔다**

지어내지 않았다. 실제로 못 봤기 때문이다.

| 케이스 | 왜 없나 |
|---|---|
| Codex **권한 상승**(\`item/permissions/requestApproval\`) | 네트워크 escalation 을 유도했지만 모델이 매번 셸로 처리했다 |
| Codex **사용자 입력**(\`item/tool/requestUserInput\`) | 스키마상 EXPERIMENTAL. 도구를 직접 지목해도 모델이 호출하지 않았다 |
| Codex **MCP elicitation** | elicitation 을 띄우는 MCP 서버가 필요하다 |
| Codex **generic** | 알 수 없는 method 에 대한 폴백이라 정상 트래픽에는 없다 |
| Codex 명령 **규칙 없음**(3버튼) | 녹화한 명령 승인은 전부 규칙을 제안했다 |
| Claude **서브에이전트**(\`agentID\`) | 서브에이전트가 올린 승인을 아직 못 잡았다 |
| **Cursor 전부** | 코드상 승인 경로가 없다. 확인만 남았다 |

**결정 버튼 구성은 코드에서 확정적이다**(\`src/shared/codexApproval.ts\`):

- 명령 + 규칙 제안: 거부 / 이번만 / 이 세션 / **항상(규칙)**
- 명령 규칙 없음 · 파일변경 · 권한상승 · elicitation: 거부 / 이번만 / 이 세션
- 그 외(generic): 거부 / 이번만
- Claude: 거부 / 이번만 / **항상(규칙)** — 규칙이 실려 왔을 때만

## 하네스별로 아예 다른 점 (디자인에 영향)

| | Claude | Codex |
|---|---|---|
| 파일 diff | **있다** (Edit 의 before/after) | **없다** — 승인 요청에 안 실린다 |
| 규칙 | \`echo one *\` — 진짜 prefix | 명령 전체(래퍼 포함) |
| 요청 사유 | 보통 **없음**, 작업공간 밖일 때만 | \`on-request\` 만 있음 |
| 작업 디렉터리 | \`blockedPath\` | \`cwd\` (파일변경엔 없음) |
| 결정 범위 | 2~3개 | 최대 4개 |

**같은 카드를 두 하네스에 공유하면 양쪽 다 틀린다.**
`;
}

main().catch(async (error) => {
  console.error(`demo failed: ${error?.message || error}`);
  await post("/api/window/close", {}).catch(() => {});
  process.exit(1);
});
