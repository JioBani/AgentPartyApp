/**
 * The state the stage shows for each slide.
 *
 * ONE session, told in order: a user connects an account, picks the `todo-api`
 * folder, makes a party, adds a reviewer, asks `main` to rate-limit a login
 * endpoint, approves the edit, has the two members talk, and ends up looking at
 * what it cost. Every slide is a later moment of that same session, so a slide
 * shows the RESULT of the action the caption describes rather than an arrow
 * pointing at a control.
 *
 * Two rules this file exists to keep:
 *  - A slide is an ABSOLUTE snapshot, never a delta: jumping straight to slide
 *    20 must show exactly what walking there would.
 *  - Anything that lives behind a click (modal, wizard, menu) is opened by
 *    `steps` on the REAL component. Nothing here is a picture of the app.
 */
import { GUIDE_SLIDES, type GuideSlideId, type GuideSnapshot } from "../../shared/guide";
import type { TranscriptBlock } from "../../shared/transcript";
import type { UsageLimitsSnapshot } from "../../shared/usageLimits";
import {
  AUTH_NONE,
  AUTH_PENDING,
  AUTH_READY,
  IMPL,
  MAIN,
  MCP_SERVERS,
  QUEUE,
  REVIEWER,
  WORKSPACE,
  emptyPartySnapshot,
  member,
  sessionView,
  snap,
} from "./fixtures";

// --- the job, beat by beat --------------------------------------------------
//
// One real task: 로그인 5회 실패 시 잠그고 429. The tool output, the diff and the
// review comment are all written as the real thing would arrive — a test that
// fails first, an edit that is actually an edit, a review that has a finding.

const TASK = "src/auth/login.ts 에 로그인 5회 실패하면 15분 잠그고 429 로 응답하게 해 줘. 테스트도 같이.";

const LOGIN_BEFORE = `  const user = await findUser(email);
  if (!user || !(await verify(password, user.hash))) {
    return res.status(401).json({ error: "invalid_credentials" });
  }`;

const LOGIN_AFTER = `  const attempts = await attemptsOf(email);
  if (attempts.count >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: "too_many_attempts", retryAfter: LOCK_SECONDS });
  }
  const user = await findUser(email);
  if (!user || !(await verify(password, user.hash))) {
    await recordFailure(email);
    return res.status(401).json({ error: "invalid_credentials" });
  }`;

const EDIT_INPUT = {
  file_path: `${WORKSPACE}\\src\\auth\\login.ts`,
  old_string: LOGIN_BEFORE,
  new_string: LOGIN_AFTER,
};

const ASKED: TranscriptBlock[] = [
  { id: "b1", kind: "user", text: TASK, at: "10:02" },
];

const REPLIED: TranscriptBlock[] = [
  ...ASKED,
  { id: "b2", kind: "assistant", text: "먼저 login.ts 와 로그인 테스트를 읽고, 지금 동작을 확인하겠습니다.", at: "10:02" },
];

const RAN_TOOL: TranscriptBlock[] = [
  ...REPLIED,
  {
    id: "b3", kind: "tool", name: "Read", status: "ok",
    input: { file_path: "src/auth/login.ts" },
    result: "68 lines · POST /login 핸들러 하나, 시도 횟수를 세는 코드는 없음",
    durationMs: 140, at: "10:03",
  },
  {
    id: "b4", kind: "tool", name: "Bash", status: "error",
    input: { command: "npm test -- login" },
    cwd: WORKSPACE, exitCode: 1, durationMs: 8600,
    result: "FAIL test/auth/login.spec.ts\n  ● 5회 실패하면 잠긴다\n    expected 429, received 200\n  ● 잠금 후 15분 뒤 풀린다\n    expected 200, received 200 (잠금 없음)\n\nTests: 2 failed, 6 passed, 8 total",
    at: "10:03",
  },
  { id: "b5", kind: "assistant", text: "잠금 로직이 아예 없어서 두 개가 떨어집니다. login.ts 에 시도 카운터와 429 응답을 넣겠습니다.", at: "10:03" },
];

const ASKED_APPROVAL: TranscriptBlock[] = [
  ...RAN_TOOL,
  {
    id: "b6", kind: "approval", requestId: "appr-1", toolName: "Edit",
    title: "파일 수정", description: "src/auth/login.ts",
    input: EDIT_INPUT,
    at: "10:04",
  },
];

const APPLIED: TranscriptBlock[] = [
  ...RAN_TOOL,
  {
    id: "b6", kind: "approval", requestId: "appr-1", toolName: "Edit",
    title: "파일 수정", description: "src/auth/login.ts",
    input: EDIT_INPUT, resolved: "allow", at: "10:04",
  },
  {
    // Only the path in the input: the expanded body prints the input verbatim,
    // and the whole before/after pair rendered there as a wall of escaped JSON.
    // The diff belongs on the approval card above, which draws it as a diff.
    id: "b7", kind: "tool", name: "Edit", status: "ok",
    input: { file_path: "src/auth/login.ts" },
    result: "Applied 1 edit to src/auth/login.ts (+8 −2)",
    durationMs: 210, at: "10:05",
  },
  {
    id: "b8", kind: "tool", name: "Bash", status: "ok",
    input: { command: "npm test -- login" },
    cwd: WORKSPACE, exitCode: 0, durationMs: 9100,
    result: "PASS test/auth/login.spec.ts\n\nTests: 8 passed, 8 total",
    at: "10:05",
  },
  { id: "b9", kind: "assistant", text: "5회 실패 후 15분 잠금 + 429 로 고쳤고, 테스트 8개 모두 통과합니다.", at: "10:05" },
];

// --- 멤버끼리 주고받은 말 ----------------------------------------------------
//
// 사용자가 친 한 줄이 원인으로 같은 화면에 남는다. 채널 메시지는 양쪽 대화에
// 각각 한 번씩 — 그게 이 슬라이드가 보여 주려는 것이다.

const HANDOFF = "src/auth/login.ts 의 로그인 시도 제한 변경을 리뷰해 줘. 5회 실패 시 15분 잠금, 429 응답이고 테스트는 통과했어.";
const FINDING = "429 는 맞는데 Retry-After 헤더가 없다. 클라이언트가 언제 다시 시도할지 알 수 없으니 응답 헤더에 남은 잠금 초를 넣어라.";

const MAIN_CHANNEL: TranscriptBlock[] = [
  ...APPLIED,
  { id: "c0", kind: "user", text: "reviewer 에게 이 변경 리뷰를 부탁하고, 지적받은 건 그대로 반영해 줘.", at: "10:12" },
  { id: "c1", kind: "channel", direction: "out", from: "main", to: "reviewer", text: HANDOFF, state: "ok", at: "10:12" },
  { id: "c2", kind: "channel", direction: "in", from: "reviewer", to: "main", text: FINDING, state: "ok", at: "10:14" },
  { id: "c3", kind: "assistant", text: "Retry-After 를 추가하겠습니다.", at: "10:14" },
];

const REVIEWER_CHANNEL: TranscriptBlock[] = [
  { id: "r1", kind: "channel", direction: "in", from: "main", to: "reviewer", text: HANDOFF, state: "ok", at: "10:12" },
  {
    id: "r2", kind: "tool", name: "Read", status: "ok",
    input: { file_path: "src/auth/login.ts" },
    result: "76 lines · attemptsOf / recordFailure 추가됨",
    durationMs: 130, at: "10:13",
  },
  { id: "r3", kind: "assistant", text: "잠금 자체는 맞게 들어갔습니다. 헤더 하나가 빠졌습니다.", at: "10:13" },
  { id: "r4", kind: "channel", direction: "out", from: "reviewer", to: "main", text: FINDING, state: "ok", at: "10:14" },
];

/** 게이트를 켠 뒤. reviewer 가 impl 에게 중계하려다 규칙에 걸린 기록. */
const REVIEWER_GATED: TranscriptBlock[] = [
  ...REVIEWER_CHANNEL,
  { id: "g0", kind: "channel", direction: "out", from: "reviewer", to: "impl", text: "main 이 말한 잠금 변경 건, 대신 전달합니다.", state: "failed", at: "10:31" },
  {
    id: "g1", kind: "gate", gate: "rejected", to: "impl", from: "reviewer",
    rule: "받은 말을 대신 옮기지 말고, 할 말이 있는 멤버에게 직접 말하세요.",
    reason: "다른 멤버의 말을 중계하는 메시지입니다. 담당 멤버에게 직접 말하세요.",
    at: "10:31",
  },
];

/** 사용자가 시켜서 main 이 멤버를 하나 만든 기록. */
const MAIN_CREATED_IMPL: TranscriptBlock[] = [
  ...MAIN_CHANNEL,
  { id: "m0", kind: "user", text: "구현만 전담할 impl 멤버를 하나 만들어 줘. Claude Code sonnet 이면 돼.", at: "10:20" },
  {
    id: "m1", kind: "tool", name: "mcp__agentparty-app__member-create", status: "ok",
    input: { name: "impl", role: "구현 전담", harness: "claude-code", model: "sonnet" },
    result: "{\"ok\":true,\"member\":\"impl\",\"status\":\"idle\"}",
    durationMs: 1800, at: "10:20",
  },
  { id: "m2", kind: "partyAction", action: "create", member: "impl", role: "구현 전담", model: "sonnet", harness: "claude-code", state: "ok", at: "10:20" },
  { id: "m3", kind: "assistant", text: "impl 을 만들었습니다. 바로 말을 걸 수 있고, 제가 대신 시킬 수도 있습니다.", at: "10:20" },
];

// --- the worlds those beats live in -----------------------------------------

const SOLO = [MAIN];
const PAIR = [MAIN, REVIEWER];
const TEAM = [MAIN, REVIEWER, IMPL];

const noPanels: Array<{ id: string; tabs: string[]; active: string }> = [];
const twoTabs = [{ id: "p1", tabs: ["main", "reviewer"], active: "main" }];
const twoPanels = [
  { id: "p1", tabs: ["main"], active: "main" },
  { id: "p2", tabs: ["reviewer"], active: "reviewer" },
];

/** `main`, mid-turn. The same person as MAIN — only the status differs. */
const MAIN_RUNNING = member({
  name: "main", status: "running", runtime: "claude-code", role: "진행",
  model: "sonnet", sessionId: "s-main",
});

/** `main`, mid-turn with two messages waiting behind the current one. */
const MAIN_QUEUED = member({
  name: "main", status: "running", runtime: "claude-code", role: "진행",
  model: "sonnet", sessionId: "s-main", queue: QUEUE,
});

/** `main`, far enough in that the context donut is worth looking at. */
const MAIN_NEARLY_FULL = member({
  name: "main", status: "idle", runtime: "claude-code", role: "진행",
  model: "sonnet", sessionId: "s-main", lastContextTokens: 148000,
});

/** The subscription meters the title bar shows. No `resetsAt`: a fabricated
 *  reset time would render as a countdown that is wrong the moment it is read. */
const USAGE: UsageLimitsSnapshot = {
  claude: {
    provider: "claude",
    available: true,
    windows: [{ kind: "five_hour", utilization: 46 }, { kind: "weekly", utilization: 71 }],
    updatedAt: 0,
  },
  codex: {
    provider: "codex",
    available: true,
    windows: [{ kind: "five_hour", utilization: 12 }, { kind: "weekly", utilization: 33 }],
    updatedAt: 0,
  },
};

const PAIR_SESSIONS = [
  sessionView("s-main", MAIN.model!, "idle", 24000),
  sessionView("s-reviewer", REVIEWER.model!, "idle", 11000),
];

/** The late-session world the last scenes share: both members have talked, the
 *  gate has rejected something, and `main` has been running long enough that its
 *  context is worth a look. */
function lateSession(extras?: Partial<GuideSnapshot>): GuideSnapshot {
  return snap({
    members: [MAIN_NEARLY_FULL, REVIEWER, IMPL],
    sessions: [sessionView("s-main", MAIN.model!, "idle", 148000), sessionView("s-reviewer", REVIEWER.model!, "idle", 11000)],
    transcripts: { main: MAIN_CREATED_IMPL, reviewer: REVIEWER_GATED },
    panels: twoPanels,
    extras,
  });
}

const SLIDE_SNAPSHOTS: Record<GuideSlideId, GuideSnapshot> = {
  // 0-2 — 계정. 앱에 처음 들어와 아무것도 연결되지 않은 상태에서 시작한다.
  auth: emptyPartySnapshot(AUTH_NONE, { view: "auth" }),
  authpending: emptyPartySnapshot(AUTH_PENDING, { view: "auth" }),
  authdone: emptyPartySnapshot(AUTH_READY, { view: "auth" }),

  // 3 — 계정은 됐고, 아직 폴더도 파티도 없다.
  workspace: emptyPartySnapshot(AUTH_READY),

  // 4 — Parties 의 + 를 눌러 새 파티 모달을 연 결과.
  newparty: emptyPartySnapshot(AUTH_READY, {
    steps: [
      { do: "click", selector: ".wb-new-party .wb-icon-btn" },
      { do: "fill", selector: ".wb-new-party-modal .wb-gate-name-input", text: "todo-api" },
    ],
  }),

  // 5 — 만들었다. main 이 함께 생겼고 아직 아무것도 열려 있지 않다.
  partyready: snap({ members: SOLO, sessions: [], panels: noPanels }),

  // 6-8 — 멤버 마법사 세 단계. 같은 세계, 마법사만 한 걸음씩 더 간다.
  wizardname: snap({
    members: SOLO, sessions: [], panels: noPanels, harness: "codex",
    extras: {
      steps: [
        { do: "click", selector: ".wb-section-add" },
        { do: "fill", selector: ".wb-wizard .wb-wizard-input", text: "reviewer" },
        { do: "fill", selector: ".wb-wizard .wb-wizard-textarea", text: "변경된 코드를 읽고 리뷰합니다. 문제를 찾으면 담당 멤버에게 직접 말합니다." },
      ],
    },
  }),
  wizardmodel: snap({
    members: SOLO, sessions: [], panels: noPanels, harness: "codex",
    extras: {
      steps: [
        { do: "click", selector: ".wb-section-add" },
        { do: "fill", selector: ".wb-wizard .wb-wizard-input", text: "reviewer" },
        { do: "click", selector: ".wb-wizard-foot .wb-btn-accent" },
        { do: "click", selector: ".wb-wizard-runtime" },
      ],
    },
  }),
  wizardpermission: snap({
    members: SOLO, sessions: [], panels: noPanels, harness: "codex",
    extras: {
      steps: [
        { do: "click", selector: ".wb-section-add" },
        { do: "fill", selector: ".wb-wizard .wb-wizard-input", text: "reviewer" },
        { do: "click", selector: ".wb-wizard-foot .wb-btn-accent" },
        { do: "click", selector: ".wb-wizard-foot .wb-btn-accent" },
      ],
    },
  }),

  // 9 — 두 명이 되었고, 둘 다 열어 탭으로 쌓았다. 대화는 아직 비어 있다.
  membersopen: snap({
    members: PAIR,
    sessions: [sessionView("s-main", MAIN.model!, "idle"), sessionView("s-reviewer", REVIEWER.model!, "idle")],
    panels: twoTabs,
  }),

  // 10 — 입력창에 적어 놓은 상태(아직 보내기 전).
  composer: snap({
    members: PAIR,
    sessions: [sessionView("s-main", MAIN.model!, "idle")],
    panels: twoTabs,
    extras: { steps: [{ do: "fill", selector: ".wb-composer textarea", text: TASK }] },
  }),

  // 11 — 보냈다. 턴이 돌고 있고 Send 자리는 Stop 이다.
  running: snap({
    members: [MAIN_RUNNING, REVIEWER],
    sessions: [sessionView("s-main", MAIN.model!, "responding", 9000)],
    transcripts: { main: REPLIED },
    panels: twoTabs,
  }),

  // 12 — 읽고 테스트를 돌렸다. 실패한 채로 보인다.
  tools: snap({
    members: PAIR,
    sessions: [sessionView("s-main", MAIN.model!, "idle", 18000)],
    transcripts: { main: RAN_TOOL },
    panels: twoTabs,
  }),

  // 13 — 고치기 직전에 멈춰 물어본다.
  approval: snap({
    members: PAIR,
    sessions: [sessionView("s-main", MAIN.model!, "idle", 18000, 1)],
    transcripts: { main: ASKED_APPROVAL },
    panels: twoTabs,
  }),

  // 14 — 허용했다. 수정과 재실행이 남았다.
  applied: snap({
    members: PAIR,
    sessions: [sessionView("s-main", MAIN.model!, "idle", 22000)],
    transcripts: { main: APPLIED },
    panels: twoTabs,
  }),

  // 15 — 도는 중에 더 시켜서 두 건이 줄을 섰다.
  queue: snap({
    members: [MAIN_QUEUED, REVIEWER],
    sessions: [sessionView("s-main", MAIN.model!, "responding", 22000)],
    transcripts: { main: APPLIED },
    panels: twoTabs,
  }),

  // 16 — reviewer 탭을 끌어내 둘로 나눴다.
  panels: snap({
    members: PAIR,
    sessions: PAIR_SESSIONS,
    transcripts: { main: APPLIED, reviewer: [] },
    panels: twoPanels,
  }),

  // 17-18 — 시킨 한 줄과 그 결과. 같은 메시지를 양쪽에서 본다.
  channel: snap({
    members: PAIR,
    sessions: PAIR_SESSIONS,
    transcripts: { main: MAIN_CHANNEL, reviewer: REVIEWER_CHANNEL },
    panels: twoPanels,
  }),
  channelin: snap({
    members: PAIR,
    sessions: PAIR_SESSIONS,
    transcripts: { main: MAIN_CHANNEL, reviewer: REVIEWER_CHANNEL },
    panels: twoPanels,
    focused: "p2",
  }),

  // 19 — 시켜서 만든 멤버가 왼쪽에 늘어 있다.
  membercreate: snap({
    members: TEAM,
    sessions: PAIR_SESSIONS,
    transcripts: { main: MAIN_CREATED_IMPL, reviewer: REVIEWER_CHANNEL },
    panels: twoPanels,
  }),

  // 20 — 파티 게이트 설정 창. 규칙은 여기에 적는다.
  gate: snap({
    members: TEAM,
    sessions: PAIR_SESSIONS,
    transcripts: { main: MAIN_CREATED_IMPL, reviewer: REVIEWER_CHANNEL },
    panels: twoPanels,
    gate: { enabled: true, rule: "받은 말을 대신 옮기지 말고, 할 말이 있는 멤버에게 직접 말하세요." },
    extras: { qaOpenGate: { kind: "party", member: "" } },
  }),

  // 21 — 규칙에 걸린 메시지가 오른쪽 대화에 사유와 함께 남았다.
  gateblocked: snap({
    members: TEAM,
    sessions: PAIR_SESSIONS,
    transcripts: { main: MAIN_CREATED_IMPL, reviewer: REVIEWER_GATED },
    panels: twoPanels,
    gate: { enabled: true, rule: "받은 말을 대신 옮기지 말고, 할 말이 있는 멤버에게 직접 말하세요." },
  }),

  // 22 — 입력창 옆 권한 메뉴를 연 상태.
  permission: snap({
    members: TEAM,
    sessions: PAIR_SESSIONS,
    transcripts: { main: MAIN_CREATED_IMPL, reviewer: REVIEWER_GATED },
    panels: twoPanels,
    extras: { steps: [{ do: "click", selector: ".wb-composer .wb-dd-trigger" }] },
  }),

  // 23 — 모델 칩 → 이 멤버의 모델·추론 강도 창.
  model: snap({
    members: TEAM,
    sessions: PAIR_SESSIONS,
    transcripts: { main: MAIN_CREATED_IMPL, reviewer: REVIEWER_GATED },
    panels: twoPanels,
    extras: { steps: [{ do: "click", selector: ".wb-model-pill" }] },
  }),

  // 24 — ⋯ → MCP 서버.
  mcp: snap({
    members: TEAM,
    sessions: PAIR_SESSIONS,
    transcripts: { main: MAIN_CREATED_IMPL, reviewer: REVIEWER_GATED },
    panels: twoPanels,
    extras: {
      mcp: MCP_SERVERS,
      steps: [
        { do: "click", selector: ".wb-header-more" },
        { do: "click", selector: ".wb-header-menu .wb-menu-item:nth-child(3)" },
      ],
    },
  }),

  // 25 — ⋯ 메뉴를 연 상태. 세션 재시작이 첫 항목이다.
  respawn: snap({
    members: TEAM,
    sessions: PAIR_SESSIONS,
    transcripts: { main: MAIN_CREATED_IMPL, reviewer: REVIEWER_GATED },
    panels: twoPanels,
    extras: { steps: [{ do: "click", selector: ".wb-header-more" }] },
  }),

  // 26 — 왼쪽 멤버를 우클릭한 상태. 하드 리스타트가 첫 항목이다.
  hardrestart: snap({
    members: TEAM,
    sessions: PAIR_SESSIONS,
    transcripts: { main: MAIN_CREATED_IMPL, reviewer: REVIEWER_GATED },
    panels: twoPanels,
    extras: { steps: [{ do: "contextmenu", selector: ".wb-member-row" }] },
  }),

  // 27 — 앱 전체 기본값 화면.
  runtime: snap({
    members: TEAM,
    sessions: PAIR_SESSIONS,
    transcripts: { main: MAIN_CREATED_IMPL, reviewer: REVIEWER_GATED },
    panels: twoPanels,
    extras: { view: "runtime", viewTab: "general" },
  }),

  // 28 — 오래 쓴 뒤. 도넛을 눌러 압축 창을 연 상태.
  context: lateSession({ steps: [{ do: "click", selector: ".wb-ctx-donut" }] }),

  // 29 — 제목 표시줄의 남은 한도.
  limit: lateSession({ usage: USAGE }),
};

/** A slide is its catalog entry (title · caption · placement · spotlight) plus
 *  the absolute workbench state the stage shows for it. */
export type GuideSlide = (typeof GUIDE_SLIDES)[number] & {
  index: number;
  snapshot: GuideSnapshot;
};

export const GUIDE_STAGE_SLIDES: GuideSlide[] = GUIDE_SLIDES.map((meta, index) => ({
  ...meta,
  index,
  snapshot: SLIDE_SNAPSHOTS[meta.id],
}));

export function slideAt(index: number): GuideSlide {
  const slide = GUIDE_STAGE_SLIDES[index];
  if (!slide) {
    throw new Error(`가이드 슬라이드 ${index} 은(는) 없습니다.`);
  }
  return slide;
}
