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
 * The handoff note.
 *
 * Written for whoever redesigns this card, not for us. A screenshot alone does
 * not say when the card appears, what the person is deciding, or what each
 * button actually does — and those are the only things a design can be judged
 * against. Every consequence below was measured against a live harness, not
 * inferred from the code.
 */
function indexDoc() {
  return `# 승인 카드 — 디자인 인계

> 이 폴더의 이미지는 **실제 하네스가 보낸 값**으로 그려졌다.
> \`node scripts/demo-approval-cards.mjs\` 로 언제든 다시 만들 수 있다(과금 없음).

---

## 0. 이 화면이 왜 중요한가

**AI 가 사용자 컴퓨터에서 명령을 실행하거나 파일을 고치기 직전에 멈춰 서서 묻는 화면**이다.
사용자가 "허용"을 누르면 그 순간 실제로 실행된다. 되돌리는 버튼은 없다.

- **신규 사용자가 가장 많이 보는 화면이다.** 처음 온 사람은 AI 에게 권한을 다 주지 않으므로
  승인 모드가 기본 동선이 된다. (반대로 이 앱을 만든 사람은 거의 안 써서 검증이 가장 비어 있던 곳이다)
- **놓치면 작업이 멈춘다.** 사용자가 답할 때까지 AI 는 아무것도 못 한다.
  ⚠️ 지금 승인 대기를 알릴 경로가 최악의 경우 **탭의 26px 짜리 칩 하나**뿐이다.
  (사이드바를 접고 패널을 나누면 나머지 표시가 전부 사라진다 — 별도 이슈로 열려 있다)

## 1. 사용자는 무엇을 정하는가

| 버튼 | 누르면 실제로 (실측) |
|---|---|
| **거부** | 명령이 실행되지 않는다. AI 에게 "사용자가 거부함"이 전달되고, AI 는 보통 *"권한이 없어 못 했다"* 고 답하며 다른 방법을 찾거나 멈춘다 |
| **이번만 허용** | 이번 건만 실행된다. 같은 명령을 또 하려 하면 **다시 묻는다** |
| **이 세션 동안** | 실행되고, **이 대화가 끝날 때까지** 같은 요청을 안 묻는다. 앱을 끄면 사라진다 |
| **항상 허용 (규칙)** | 실행되고 **규칙이 디스크에 저장된다.** 다음에 앱을 새로 켜도 안 묻는다 |

⚠️ **"항상 허용"은 침묵을 약속하지 못한다.** 규칙은 저장되지만, *다른 이유*(예: 작업공간 밖 경로)로
다시 물을 수 있고 그 사유는 세션 단위로만 허용된다. 그래서 버튼 설명이
*"앞으로 묻지 않습니다"* 가 아니라 *"'…' 규칙을 저장합니다"* 로 되어 있다. **이 문구는 실측 결과다.**

## 2. 카드별 — 언제 뜨고 무엇을 보여주는가

### \`pending-codex-command-once.png\` — 명령 실행 승인 (가장 흔함)
**상황**: Codex 멤버에게 파일을 하나 만들어 달라고 했다. 작업공간이 읽기 전용이라
Codex 가 *"이 명령을 실행해도 되나"* 고 묻는다.
**보여주는 것**: 요청 사유(AI 가 쓴 문장) · 실행할 명령 · 실제 실행 형태 · 작업 디렉터리 · 저장될 규칙
**결정**: 4개 전부

### \`pending-codex-untrusted-no-reason.png\` — 사유가 없는 카드
**상황**: 같은 요청인데 사용자가 **가장 엄격한 승인 설정**을 골랐을 때.
**차이**: **요청 사유가 아예 없다.** AI 가 권한을 요청하는 게 아니라 그냥 신뢰 목록에 없는 명령이라 멈춘 것이다.
⚠️ **여기서 허용을 눌러도 실패한다** — 승인과 샌드박스 해제가 별개라서다. 실측으로 확인됐다.
**→ 디자인 질문: 사용자가 허용했는데 실패하는 이 상황을 어떻게 알릴 것인가?**

### \`pending-codex-file-change.png\` — 파일 변경 승인
**상황**: Codex 가 파일을 직접 고치려 한다.
**보여주는 것**: 바뀌는 파일 경로와 그 내용/차이.
(원래 이 카드는 제목과 버튼뿐이었다 — 무엇이 바뀌는지 모르고 승인해야 했다. 고쳤다)
**결정**: 3개 — 파일 변경에는 "항상 허용" 규칙이 없다

### \`pending-claude-bash.png\` — Claude 명령 승인
**상황**: Claude 멤버에게 셸 명령을 시켰다.
**보여주는 것**: AI 가 쓴 설명 · 명령 · **막힌 경로** · 저장될 규칙(\`echo one *\` 처럼 읽히는 패턴)
**결정**: 3개 — Claude 에는 "이 세션 동안"이 없다

### \`pending-claude-file-edit.png\` — Claude 파일 편집
**상황**: Claude 가 기존 파일의 한 부분을 고치려 한다.
**보여주는 것**: **바뀌기 전과 후**를 나란히

### \`pending-claude-write-outside-cwd.png\` — 작업공간 밖 쓰기
**상황**: AI 가 작업 폴더 **바깥** 파일을 건드리려 한다. 위험도가 다른 경우다.
**차이**: 이때만 사유가 붙는다(*"허용된 작업 디렉터리 밖의 경로"*)

### \`resolved-*.png\` — 누른 뒤
카드가 사라지지 않고 **무엇을 승인/거부했는지 기록으로 남는다.** 지금은 작은 배지 하나뿐이다.
**→ 디자인 질문: 나중에 대화를 훑을 때 "내가 뭘 허용했더라"를 이걸로 알 수 있나?**

### \`question-*.png\` — AI 가 되묻는 카드 (승인과 다른 계열)
**상황**: AI 가 진행하다 막혀서 사용자에게 선택지를 물을 때. 위험한 동작이 아니라 **의사결정**이다.
단일 선택 · 다중 선택 · 자유 입력 · 비밀 입력(마스킹) · 여러 질문 연속(건너뛰기/다음).
🐛 여러 질문 카드에 진행 표시(\`1/3\`)가 **두 번** 나온다.

## 3. ⚠️ 하네스마다 다른 것 — 카드 하나로 못 덮는다

| | Claude | Codex |
|---|---|---|
| 결정 개수 | 3개 | **4개** |
| "이 세션 동안" | **없음** | 있음 |
| 파일 변경 미리보기 | 전/후 | 파일 + 내용 |
| 저장되는 규칙 | \`echo one *\` — **읽힌다** | 명령 전체 + 실행 경로 — **길고 안 읽힌다** |
| 요청 사유 | 보통 없음 | 설정에 따라 있음/없음 |

**같은 레이아웃을 두 하네스에 그대로 쓰면 한쪽은 빈칸이 생기고 한쪽은 넘친다.**
특히 Codex 의 "저장될 규칙"은 한 줄에 안 들어간다.

## 4. 아직 그림이 없는 케이스 — **비워 뒀다**

실제로 본 적이 없어서 비웠다. 못 본 모양으로 카드를 그리면 추측이 그대로 스펙이 된다.
다만 **버튼 구성은 코드상 확정**이므로 그것만 적는다.

| 케이스 | 언제 뜰 것인가 | 결정 |
|---|---|---|
| Codex 권한 상승 | AI 가 네트워크·경로 권한을 더 달라고 할 때 | 거부 / 이번만 / 이 세션 |
| Codex 명령(규칙 제안 없음) | 규칙으로 만들 수 없는 명령일 때 | 거부 / 이번만 / 이 세션 |
| Codex 사용자 입력 | AI 가 값을 물을 때 (아직 실험 기능) | 질문 카드 계열 |
| Codex MCP 서버 요청 | 외부 도구가 확인을 요청할 때 | 거부 / 이번만 / 이 세션 |
| Claude 서브에이전트 승인 | **AI 의 하위 작업자**가 요청할 때 — 누가 요청했는지 표시가 필요하다 | 거부 / 이번만 / 항상 |
| Cursor | 조사 결과 **승인 화면 자체가 없다**(실행 전에 미리 정해진다) | — |

## 5. 파일 목록

| 파일 | 무엇 |
|---|---|
${[...CARDS.map((c) => `| \`pending-${c.scenario}.png\` | ${c.caption} |`),
   ...RESOLVED.map((c) => `| \`resolved-${c.member}.png\` | ${c.caption} |`),
   ...QUESTIONS.map((q) => `| \`question-${q.member}.png\` | ${q.caption} |`)].join("\n")}
| \`sheet-pending*.png\` | 승인 카드 나란히 (라이트/다크) |
| \`sheet-questions*.png\` | 질문 카드 나란히 (라이트/다크) |
| \`sheet-resolved.png\` | 처리된 카드 나란히 |
`;
}

main().catch(async (error) => {
  console.error(`demo failed: ${error?.message || error}`);
  await post("/api/window/close", {}).catch(() => {});
  process.exit(1);
});
