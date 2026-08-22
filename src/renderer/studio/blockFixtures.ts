/**
 * Transcript BLOCK inputs.
 *
 * A block story is one event run through the real reducer and handed to the
 * real `<Transcript/>`. That is the whole trick: no block markup is written
 * here, so a block page shows what the app shows, including the parts nobody
 * remembered to copy.
 *
 * Approvals are the RECORDED harness payloads, mapped by the app's own
 * `codexApprovalFields` / `claudeApprovalFields` — the same call the engine
 * makes when a live harness asks. A hand-written approval card would document
 * a request no harness ever sends.
 */
import { APPROVAL_SCENARIOS } from "../../shared/approvalScenarios";
import { codexApprovalFields, claudeApprovalFields } from "../../shared/approvalRequest";
import { fileEditsFrom } from "../../shared/codexItems";
import { STUDIO_AT } from "./fixtures";

/** One recorded approval, in the shape the reducer receives it. */
export function approvalEvent(scenario: string, requestId = `studio-${scenario}`): unknown {
  const recorded = APPROVAL_SCENARIOS[scenario];
  if (!recorded) throw new Error(`unknown approval scenario '${scenario}'`);
  const fields = recorded.harness === "codex"
    ? codexApprovalFields(recorded.method, recorded.params, fileEditsFrom((recorded as { changes?: unknown }).changes))
    : claudeApprovalFields(recorded.toolName, recorded.input, recorded.options as never);
  return { type: "approval_request", requestId, ...fields };
}

export const QUESTION_EVENT: unknown = {
  type: "approval_request",
  requestId: "studio-question",
  toolName: "AskUserQuestion",
  title: "답변 대기 중",
  input: {
    questions: [
      {
        question: "어떤 작업을 진행할까요?",
        header: "작업 선택",
        multiSelect: false,
        options: [
          { label: "코드 리뷰", description: "현재 변경점을 리뷰합니다." },
          { label: "버그 수정", description: "보고된 버그를 수정합니다." },
        ],
      },
    ],
  },
};

export const COMPACT_DONE: unknown[] = [
  { type: "compact_state", state: "done", trigger: "manual", preTokens: 824_000, postTokens: 6_900, keptCount: 3, durationMs: 17_000 },
];

export const COMPACT_RUNNING: unknown[] = [
  { type: "compact_state", state: "running", trigger: "auto", preTokens: 824_000 },
];

export const ENVIRONMENT_EVENT: unknown[] = [
  {
    type: "diagnostic",
    severity: "warning",
    category: "environment",
    title: "Claude Code 버전이 이 빌드와 다릅니다.",
    detail: "이 PC에 설치된 Claude Code(PATH)는 2.1.191, 이 빌드의 Agent SDK 는 2.1.229 입니다.",
    at: STUDIO_AT,
  },
];

export const GATE_EVENT: unknown[] = [
  {
    type: "gate",
    gate: "rejected",
    from: "design",
    to: "impl",
    reason: "결정도 대상도 없이 \"확인 부탁해\" 만 보냈습니다. 무엇을 확인해야 하는지 적어 다시 보내세요.",
    rule: "메시지에는 결정과 구체적 대상이 있어야 한다",
  },
];

export const FILE_CHANGE_EVENT: unknown[] = [
  {
    type: "file_change",
    changes: [
      { kind: "update", path: "src/renderer/workbench/Composer.tsx", added: 14, removed: 5 },
      { kind: "add", path: "src/renderer/studio/stories.tsx", added: 132, removed: 0 },
    ],
    status: "completed",
  },
];

export const ERROR_EVENT: unknown[] = [
  { type: "error", message: "세션이 예기치 않게 종료되었습니다 (exit 3221226505).", at: STUDIO_AT },
];

export const REASONING_EVENT: unknown[] = [
  { type: "reasoning_delta", text: "빌드 로그의 첫 실패 지점을 찾고, 그 위의 설정 변경과 대조한다. 패키지의 exports 필드를 먼저 본다." },
  { type: "assistant_text_delta", text: "확인했습니다." },
];

/**
 * An inbound inter-member message. It really arrives as a "sent" turn carrying
 * a `<channel>` envelope, which the reducer parses into a card — so the fixture
 * is the envelope, not the card. Feeding the card directly would document a
 * shape the transport never produces.
 */
export const CHANNEL_IN: unknown = {
  type: "status",
  status: "sent",
  detail: '<channel source="agentparty" from="design" to="impl">스튜디오 스토리 15개 올렸어. 워크벤치 쪽 먼저 봐줘.</channel>',
};

export const CHANNEL_OUT: unknown = {
  type: "status",
  status: "sent",
  detail: '<channel source="agentparty" from="impl" to="design">확인했어. TabStrip 만 폭 계산이 달라 보인다.</channel>',
};

/** The harness process coming up — the conditions the turn below runs under. */
export const SESSION_SPAWN: unknown = {
  type: "session_spawn",
  state: "ready",
  harness: "claude-code",
  model: "claude-sonnet-4.5",
  host: "windows",
  cwd: "C:/…/AgentPartyApp",
};

/** A person's message, delivered out of the queue. */
export const USER_INPUT: unknown = {
  type: "queue_dequeued",
  count: 2,
  text: "리뷰 끝나면 이어서 부탁해\n\n릴리스 노트 초안도 같이",
};
