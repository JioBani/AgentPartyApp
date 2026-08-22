/**
 * The design gallery — every transcript card case, one member each.
 *
 * A card can only be designed against what the harness really sends, and the
 * only way to look at all of them at once used to be a script that spelled the
 * list out privately. So the product could not show it: the cases lived in
 * scripts/demo-approval-cards.mjs and nothing else could reach them.
 *
 * This is that list, in one place both the app and the scripts read. Every
 * member here runs on the MOCK harness — the gallery is opened to look at
 * layout, and a gallery that spent tokens (or worse, ran commands) to show a
 * card would be unusable for the job it exists for.
 *
 * Approval payloads are named recordings from src/shared/approvalScenarios.ts;
 * questions and compactions are shaped like the events their harnesses send
 * (Claude's AskUserQuestion, the SDK's `compact_metadata`).
 */

import type { HarnessId } from "./types";

/** One member in the gallery: what it is called, and what it should be showing. */
export interface GalleryCase {
  member: string;
  runtime: HarnessId;
  /** What this card is FOR — shown as the member's role so the list reads. */
  caption: string;
  /** A recorded approval to inject (APPROVAL_SCENARIOS key). */
  scenario?: string;
  /** Answer the injected approval this way, to show its resolved state. */
  resolve?: "allow" | "deny";
  /** An interactive question to inject. */
  questions?: unknown[];
  /** Answers to submit for `questions`, producing the answered card. */
  answers?: Record<string, string>;
  /** Normalized events to inject directly (compaction states). */
  events?: unknown[];
}

/**
 * Model per harness, so the badge names the harness that sent the payload.
 *
 * Deliberately PARTIAL: only the harnesses whose traffic was actually recorded
 * appear. Adding an entry for one we have no payloads for would put a member in
 * the gallery with a card no harness ever produced.
 */
export const GALLERY_MODELS: Partial<Record<HarnessId, string>> = {
  "claude-code": "claude-sonnet-4.5",
  codex: "gpt-5.4-mini",
};

export const GALLERY_PARTY = "카드 디자인 갤러리";

export const GALLERY_CASES: GalleryCase[] = [
  // --- 승인 대기 --------------------------------------------------------
  { member: "01-codex-명령", runtime: "codex", scenario: "codex-command-once", caption: "Codex 명령 승인 — 사유·명령·cwd·규칙 + 결정 4종" },
  { member: "02-codex-사유없음", runtime: "codex", scenario: "codex-untrusted-no-reason", caption: "Codex untrusted — 요청 사유가 오지 않는 카드" },
  { member: "03-codex-파일변경", runtime: "codex", scenario: "codex-file-change", caption: "Codex 파일 변경 — 규칙 없음(버튼 3개)" },
  { member: "04-claude-명령", runtime: "claude-code", scenario: "claude-bash", caption: "Claude Bash — 막힌 경로 + 규칙 + 항상 허용" },
  { member: "05-claude-파일변경", runtime: "claude-code", scenario: "claude-file-edit", caption: "Claude Edit — 파일 diff(before/after)" },
  { member: "06-claude-작업공간밖", runtime: "claude-code", scenario: "claude-write-outside-cwd", caption: "Claude 작업공간 밖 쓰기 — 사유가 붙는 변종" },

  // --- 승인 처리 후 ------------------------------------------------------
  { member: "07-codex-승인함", runtime: "codex", scenario: "codex-command-once", resolve: "allow", caption: "Codex — 승인함" },
  { member: "08-codex-거부함", runtime: "codex", scenario: "codex-command-once", resolve: "deny", caption: "Codex — 거부함" },
  { member: "09-claude-승인함", runtime: "claude-code", scenario: "claude-bash", resolve: "allow", caption: "Claude — 승인함" },
  { member: "10-claude-거부함", runtime: "claude-code", scenario: "claude-bash", resolve: "deny", caption: "Claude — 거부함" },

  // --- 질문 -------------------------------------------------------------
  {
    member: "11-질문-단일선택", runtime: "claude-code", caption: "질문 — 단일 선택 + 선택지 설명",
    questions: [{ question: "어떤 작업을 진행할까요?", header: "작업 선택", multiSelect: false, options: [
      { label: "코드 리뷰", description: "현재 변경점을 리뷰합니다." },
      { label: "버그 수정", description: "보고된 버그를 수정합니다." },
    ] }],
  },
  {
    member: "12-질문-다중선택", runtime: "claude-code", caption: "질문 — 다중 선택(네모 표시 + '복수 선택')",
    questions: [{ question: "어떤 검사를 돌릴까요?", header: "검사", multiSelect: true, options: [
      { label: "타입체크", description: "tsc --noEmit" },
      { label: "단위 테스트", description: "npm run test:ui" },
      { label: "빌드", description: "npm run build" },
    ] }],
  },
  { member: "13-질문-자유입력", runtime: "claude-code", caption: "질문 — 선택지 없이 자유 입력", questions: [{ question: "브랜치 이름을 정해주세요.", header: "브랜치", multiSelect: false, options: [] }] },
  { member: "14-질문-비밀입력", runtime: "claude-code", caption: "질문 — 비밀 입력(마스킹)", questions: [{ question: "API 키를 입력하세요.", header: "인증", multiSelect: false, secret: true, options: [] }] },
  {
    member: "15-질문-여러단계", runtime: "claude-code", caption: "질문 — 여러 질문(이전/다음/건너뛰기)",
    questions: [
      { question: "배포 대상은?", header: "1/3", multiSelect: false, options: [{ label: "스테이징" }, { label: "프로덕션" }] },
      { question: "마이그레이션을 함께 돌릴까요?", header: "2/3", multiSelect: false, options: [{ label: "예" }, { label: "아니오" }] },
      { question: "알림을 보낼 채널은?", header: "3/3", multiSelect: false, options: [{ label: "#deploy" }, { label: "#general" }] },
    ],
  },

  // --- 질문 처리 후 ------------------------------------------------------
  {
    member: "16-답변함-한건", runtime: "claude-code", caption: "질문 — 답변함(한 건)",
    questions: [{ question: "어떤 하네스로 만들까요?", header: "멤버 설정", multiSelect: false, options: [{ label: "Claude Code" }, { label: "Codex" }] }],
    answers: { "어떤 하네스로 만들까요?": "Claude Code" },
  },
  {
    // Three answers, one too long for its line: the case that showed the
    // answers after the first were unreadable, and the one the "전체 보기"
    // popup exists for.
    member: "17-답변함-여러건", runtime: "claude-code", caption: "질문 — 답변함(여러 건 + 긴 답변은 전체 보기)",
    questions: [
      { question: "멘션을 어떻게 적용할까요?", header: "적용 여부", multiSelect: false, options: [{ label: "텍스트로만 넣는다" }] },
      { question: "단일 @ 는 어떻게 처리할까요?", header: "단일 @", multiSelect: false, options: [{ label: "짧게" }] },
      { question: "키 배분은 어떤 기준으로 나눌까요?", header: "키 배분", multiSelect: false, options: [{ label: "일반" }] },
    ],
    answers: {
      "멘션을 어떻게 적용할까요?": "텍스트로만 넣는다",
      "단일 @ 는 어떻게 처리할까요?": "'@@' 만 멤버로 인식하고, '@' 하나만 적힌 경우에는 아무 것도 하지 않으며 그대로 글자로 남긴다. 기존 대화에 이미 적혀 있던 '@' 는 소급해서 바꾸지 않고, 자동 완성 목록도 '@@' 를 입력했을 때만 연다.",
      "키 배분은 어떤 기준으로 나눌까요?": "일반 배분을 그대로 쓰되 멤버가 직접 지정한 값이 있으면 그쪽을 우선한다",
    },
  },

  // --- 대화 압축 --------------------------------------------------------
  { member: "18-압축-진행중", runtime: "claude-code", caption: "대화 압축 중 — 경과 시간 + 스윕 바", events: [{ type: "compact_state", state: "running", trigger: "manual" }] },
  { member: "19-압축-완료", runtime: "claude-code", caption: "대화 압축됨 — 수치가 모두 도착한 경우", events: [{ type: "compact_state", state: "done", trigger: "manual", preTokens: 823598, postTokens: 6883, durationMs: 197155, keptCount: 3 }] },
  { member: "20-압축-수치없음", runtime: "codex", caption: "대화 압축됨 — Codex(수치를 보내지 않음)", events: [{ type: "compact_state", state: "done" }] },
  { member: "21-압축-실패", runtime: "claude-code", caption: "압축 실패 — 다시 시도", events: [{ type: "compact_state", state: "failed", reason: "context too short to compact" }] },

  // --- 환경 문제 ---------------------------------------------------------
  // These read their label/detail/fixes from the environment report by id, so
  // the gallery installs GALLERY_ENVIRONMENT_REPORT first (qaDesignGallery).
  // Without it they would render THIS machine's state — green, on a healthy
  // one, which is the one thing the cards are not for.
  {
    member: "22-환경-미설치", runtime: "claude-code", caption: "환경 — 하네스 미설치(설치 버튼 + 접힌 원본 오류)",
    events: [{ type: "error", message: "Grok Build CLI가 설치되어 있지 않습니다.", environment: { checkId: "harness.grok", raw: "The official Grok Build CLI was not found. Tried: grok: spawn grok ENOENT. No fallback was attempted." } }],
  },
  {
    member: "23-환경-미로그인", runtime: "claude-code", caption: "환경 — 설치됐지만 미로그인(로그인 버튼)",
    events: [{ type: "error", message: "Cursor에 로그인되어 있지 않습니다.", environment: { checkId: "harness.cursor" } }],
  },
  {
    member: "24-환경-버전차이", runtime: "claude-code", caption: "환경 — 버전 스큐 경고(주의, 막지는 않음)",
    events: [{ type: "error", message: "Claude Code 버전이 이 빌드와 다릅니다.", environment: { checkId: "harness.claude-code" } }],
  },
  {
    // The state after a fix: the same card, green, offering to resend the
    // message that failed. `다시 시도` only appears once the check passes.
    member: "25-환경-해결됨", runtime: "claude-code", caption: "환경 — 해결됨(다시 시도)",
    // The user turn is part of the case: `다시 시도` resends the message that
    // failed, so a card with no message before it cannot show that button.
    events: [
      { type: "queue_dequeued", text: "이 코드 리뷰해줘", count: 1 },
      { type: "error", message: "Codex CLI를 실행하지 못했습니다.", environment: { checkId: "harness.codex" } },
    ],
  },
  {
    member: "26-환경-반복실패", runtime: "claude-code", caption: "환경 — 같은 실패 3회(카드는 1개로 유지)",
    events: [
      { type: "error", message: "Grok Build CLI가 설치되어 있지 않습니다.", environment: { checkId: "harness.grok", raw: "attempt 1" } },
      { type: "error", message: "Grok Build CLI가 설치되어 있지 않습니다.", environment: { checkId: "harness.grok", raw: "attempt 2" } },
      { type: "error", message: "Grok Build CLI가 설치되어 있지 않습니다.", environment: { checkId: "harness.grok", raw: "attempt 3" } },
    ],
  },

  // --- 세션 시작 --------------------------------------------------------
  // The card that replaced the raw `spawned: <command line>` line. Every state
  // is here because each is a different shape (a note while starting, a bare
  // fact when up, a reason + retry line when it fails), and the long-cwd case
  // is what a narrow panel has to survive.
  { member: "27-세션-시작중", runtime: "claude-code", caption: "세션 시작 중 — 준비 표시", events: [{ type: "session_spawn", state: "starting", harness: "claude-code", model: "claude-opus-5", host: "windows", cwd: "…/AgentPartyApp" }] },
  { member: "28-세션-실행중", runtime: "codex", caption: "세션 시작됨 — 하네스·모델·호스트·작업 폴더", events: [{ type: "session_spawn", state: "running", harness: "codex", model: "gpt-5.4-codex", host: "windows", cwd: "…/AgentPartyApp" }] },
  { member: "29-세션-WSL", runtime: "codex", caption: "세션 시작됨 — WSL + 긴 작업 폴더(좁은 패널 확인)", events: [{ type: "session_spawn", state: "running", harness: "codex", model: "gpt-5.4-codex", host: "wsl", cwd: "…/projects/very-long-workspace-directory-name" }] },
  { member: "30-세션-실패", runtime: "claude-code", caption: "세션 시작 실패 — 안전한 요약 + 재시도 가능", events: [{ type: "session_spawn", state: "failed", harness: "claude-code", model: "claude-opus-5", host: "windows", cwd: "…/AgentPartyApp", reason: "하네스가 시작 중 종료되었습니다 (코드 1).", retryable: true }] },
  // The card names the harness from its EVENT, so this case shows the Grok
  // wording while running on a gallery harness that has recordings.
  { member: "31-세션-실패-설정", runtime: "codex", caption: "세션 시작 실패 — 재시도로 풀리지 않는 경우", events: [{ type: "session_spawn", state: "failed", harness: "grok", model: "grok-4.6", host: "windows", cwd: "…/AgentPartyApp", reason: "하네스 실행 파일을 찾지 못했습니다. 설치 상태를 확인하세요.", retryable: false }] },

];
