/**
 * Guide stage contract — the snapshot the stage's fake `window.agentParty`
 * serves, and the catalog the guide screen / HTTP API use to name slides.
 *
 * Slide *content* lives in `src/renderer/guide/`. This file is only the shape
 * both sides must agree on.
 */
import type { HarnessId, InitialAppState } from "./types";
import type { WorkbenchLayout } from "./workbenchLayout";
import type { TranscriptBlock } from "./transcript";
import type { UsageLimitsSnapshot } from "./usageLimits";
import type { UpdateStatus } from "./appUpdate";
import type { DiscordBridgeStatus } from "./discordBridge";
import type { McpServerSnapshot } from "./mcp";
import type { RuntimeTabId } from "./runtimeTabs";
import type { TokenUsageAggregate, TurnUsageRecord } from "./tokenUsage";

/** Chapter titles in the table of contents (§2-3). Not the slide list.
 *  Titles, blurbs and boundaries come from the design canon (guide.html SCENES). */
export const GUIDE_SCENES = [
  { id: "connect", title: "계정 연결", blurb: "구독 · API 키", from: 0 },
  { id: "party", title: "협업 구성", blurb: "작업공간·파티·멤버 생성", from: 3 },
  { id: "work", title: "작업 요청", blurb: "입력창 · 실행 · 승인 · 대기열", from: 10 },
  { id: "talk", title: "멤버 간 협업 설정", blurb: "패널 · 채널 · Message Gate", from: 16 },
  { id: "control", title: "실행 방식 설정", blurb: "권한 · 모델 · MCP · 재시작", from: 22 },
  { id: "cost", title: "사용량 확인", blurb: "컨텍스트 · 남은 한도", from: 28 },
] as const;

export type GuideSceneId = (typeof GUIDE_SCENES)[number]["id"];

/**
 * Where a slide's caption sits ON the stage.
 *
 * Not a style preference: the caption used to be a fixed band along the bottom,
 * which meant every slide about something at the bottom of the app — the
 * composer, the tab strip — covered the very thing it was pointing at. Each
 * slide now names a corner that its own spotlight does not occupy.
 */
export type GuideCaptionPlacement =
  | "bottom" | "top"
  | "bottom-left" | "bottom-right"
  | "top-left" | "top-right";

/**
 * The presentation, one user-visible action per slide.
 *
 * `spot` is a rectangle in percent of the 1440x942 stage. Do NOT eyeball these:
 * `POST /api/guide/stage/measure {selector}` returns exactly this shape for a
 * live element, and every value below came from it. Re-measure when the
 * workbench layout moves.
 */
export const GUIDE_SLIDES = [
  // --- 계정을 연결한다 ---
  {
    id: "auth", scene: "connect", caption: "bottom-right",
    title: "사용할 계정 연결",
    text: "왼쪽 탐색 메뉴에서 열쇠 아이콘(인증)을 선택합니다. 구독 카드에서 「구독 연결」을 선택하세요. 모든 구독을 연결할 필요는 없으며 사용할 계정만 연결하면 됩니다",
    spot: { left: "5%", top: "15.87%", width: "50%", height: "19.3%" },
  },
  {
    id: "authpending", scene: "connect", caption: "bottom-right",
    title: "브라우저에서 로그인하여 연결",
    text: "「구독 연결」을 선택하면 브라우저가 열리고 카드에 「인증 대기 중」 상태가 표시됩니다. 기본 브라우저에 해당 계정이 로그인되어 있지 않으면 함께 표시되는 주소를 복사하여 다른 브라우저에서 여세요",
    spot: { left: "5%", top: "27.24%", width: "50%", height: "9.26%" },
  },
  {
    id: "authdone", scene: "connect", caption: "bottom-right",
    title: "연결 완료 후 「사용 가능」 상태로 변경",
    text: "연결된 계정의 모델을 멤버에 지정할 수 있습니다. API 키 입력란은 구독이 아닌 OpenRouter·DeepSeek 모델을 사용할 때만 입력합니다",
    spot: { left: "5%", top: "18.68%", width: "50%", height: "7.71%" },
  },

  // --- 팀을 꾸린다 ---
  {
    id: "workspace", scene: "party", caption: "bottom",
    title: "작업공간 선택",
    text: "오른쪽 상단의 「작업공간」을 선택하고 프로젝트 폴더를 지정하세요. 멤버는 이 폴더에서 파일을 읽고 수정합니다",
    spot: { left: "92.49%", top: "5.1%", width: "6.12%", height: "3.29%" },
  },
  {
    id: "newparty", scene: "party", caption: "bottom-right",
    title: "Parties의 +를 선택하여 파티 생성 창 열기",
    text: "파티 이름을 입력하고 「파티 만들기」를 선택합니다. Message Gate는 끈 상태로 시작한 후 필요할 때 켤 수 있습니다",
    spot: { left: "33.33%", top: "34.55%", width: "33.33%", height: "30.89%" },
  },
  {
    id: "partyready", scene: "party", caption: "bottom-right",
    title: "파티 생성 시 main 멤버 자동 생성",
    text: "파티는 함께 작업하는 멤버의 모음이며 main은 기본으로 생성되는 멤버입니다. 멤버 이름을 선택하면 오른쪽에 대화창이 열립니다",
    spot: { left: "4.31%", top: "37.45%", width: "14.93%", height: "4.03%" },
  },
  {
    id: "wizardname", scene: "party", caption: "bottom-right",
    title: "Members의 + 선택 후 이름과 설명 입력",
    text: "입력한 설명은 멤버의 역할로 전달됩니다. 「기본 설정으로 만들기」를 선택하면 나머지 설정 단계를 건너뛸 수 있습니다",
    spot: { left: "30.56%", top: "25.96%", width: "38.89%", height: "48.09%" },
  },
  {
    id: "wizardmodel", scene: "party", caption: "bottom-right",
    title: "「변경」을 선택하여 모델 목록 열기",
    text: "하네스(Claude Code·Codex·Cursor)를 선택한 후 해당 하네스에서 사용할 모델을 선택합니다. 하나의 파티에서 서로 다른 하네스를 함께 사용할 수 있습니다",
    spot: { left: "15.35%", top: "12.48%", width: "23.89%", height: "75.69%" },
  },
  {
    id: "wizardpermission", scene: "party", caption: "bottom-right",
    title: "초기 권한 설정",
    text: "Codex는 샌드박스와 승인 정책을 각각 설정하고 Claude Code는 하나의 권한 모드를 선택합니다. 멤버 생성 후에도 대화창에서 변경할 수 있습니다",
    spot: { left: "30.56%", top: "23.3%", width: "38.89%", height: "53.4%" },
  },
  {
    id: "membersopen", scene: "party", caption: "bottom",
    title: "멤버 이름을 선택하여 탭 열기",
    text: "열린 멤버는 상단에 탭으로 표시됩니다. 탭의 X를 선택하면 탭뿐 아니라 해당 멤버의 세션도 종료됩니다. 세션을 유지하려면 탭을 닫지 마세요",
    spot: { left: "21.11%", top: "14.65%", width: "77.99%", height: "4.03%" },
  },

  // --- 일을 시킨다 ---
  {
    id: "composer", scene: "work", caption: "top",
    title: "입력창에 작업 내용 작성",
    text: "메시지를 작성하고 Ctrl+Enter로 전송합니다. 이미지·파일은 드래그하여 첨부하고, m:을 입력하여 다른 멤버를 멘션할 수 있습니다",
    spot: { left: "21.11%", top: "86.73%", width: "77.99%", height: "11.89%" },
  },
  {
    id: "running", scene: "work", caption: "top",
    title: "메시지 전송 후 Send 버튼이 Stop으로 변경",
    text: "작업을 잘못 요청한 경우 Stop을 선택하여 현재 턴만 중단할 수 있습니다. 대화 기록은 유지됩니다. 작업 중에는 왼쪽 목록의 해당 멤버에도 「작업 중」 상태가 표시됩니다",
    spot: { left: "21.11%", top: "86.52%", width: "77.99%", height: "12.1%" },
  },
  {
    id: "tools", scene: "work", caption: "top",
    title: "도구 실행 내역 확인",
    text: "도구 실행 항목을 선택하면 명령 원문, 종료 코드, 소요 시간이 표시됩니다. 테스트가 종료 코드 1로 실패한 경우에도 결과를 그대로 표시합니다",
    spot: { left: "22.22%", top: "35.48%", width: "75.14%", height: "43.45%" },
  },
  {
    id: "approval", scene: "work", caption: "top",
    title: "파일 수정 전 승인 요청",
    text: "승인 카드에서 변경 내용을 확인할 수 있습니다. 사용자가 「이번만 허용」을 선택할 때까지 멤버는 대기하며, 왼쪽 멤버 이름에 승인 배지가 표시됩니다",
    spot: { left: "22.22%", top: "36.06%", width: "75.14%", height: "48.99%" },
  },
  {
    id: "applied", scene: "work", caption: "top",
    title: "승인 후 변경 적용 및 테스트 재실행",
    text: "수정 내용과 재실행한 테스트 결과가 순서대로 표시됩니다. 종료 코드 0을 포함한 성공 근거를 직접 확인할 수 있습니다",
    spot: { left: "22.22%", top: "39.9%", width: "75.14%", height: "39.09%" },
  },
  {
    id: "queue", scene: "work", caption: "top",
    title: "작업 중 추가 메시지는 대기열에 등록",
    text: "추가 메시지는 현재 턴을 중단하지 않고 순서대로 대기열에 등록됩니다. 대기 메시지는 취소하거나 우선 처리할 수 있으며, 다른 멤버가 보낸 메시지도 동일한 대기열에 포함됩니다",
    spot: { left: "21.88%", top: "70.59%", width: "76.46%", height: "16.14%" },
  },

  // --- 서로 이야기하게 한다 ---
  {
    id: "panels", scene: "talk", caption: "bottom-left",
    title: "탭을 오른쪽 끝으로 드래그하여 패널 분할",
    text: "두 멤버를 나란히 표시할 수 있습니다. 패널 배치는 파티별로 저장되며 다시 열 때 복원됩니다",
    spot: { left: "60.38%", top: "14.23%", width: "38.78%", height: "84.5%" },
  },
  {
    id: "channel", scene: "talk", caption: "bottom",
    title: "멤버 간 작업 요청",
    text: "입력창에 「reviewer에게 리뷰를 요청해」라고 작성하면 main이 reviewer에게 메시지를 보냅니다. 별도의 설정은 필요하지 않습니다",
    spot: { left: "22.22%", top: "59.91%", width: "35.8%", height: "19.04%" },
  },
  {
    id: "channelin", scene: "talk", caption: "bottom-left",
    title: "수신 멤버의 대화에도 메시지 기록",
    text: "오른쪽 reviewer 대화에 방향 표시와 함께 메시지가 표시되고, 답변은 다시 main에게 전달됩니다. 발신자와 메시지 내용을 양쪽 대화에서 확인할 수 있습니다",
    spot: { left: "61.56%", top: "24.63%", width: "36.42%", height: "30.3%" },
  },
  {
    id: "membercreate", scene: "talk", caption: "bottom-right",
    title: "AI를 통한 멤버 생성",
    text: "「impl 멤버를 만들어 줘」라고 요청하면 main이 도구를 사용해 멤버를 생성합니다. 생성된 멤버는 왼쪽 목록에 즉시 표시되며 바로 메시지를 보낼 수 있습니다",
    spot: { left: "4.31%", top: "46.36%", width: "14.93%", height: "4.03%" },
  },
  {
    id: "gate", scene: "talk", caption: "bottom-right",
    title: "멤버 간 메시지 규칙 설정",
    text: "파티를 마우스 오른쪽 버튼으로 선택한 후 「Message Gate 설정」을 선택합니다. 입력한 규칙에 따라 리뷰어 모델이 메시지 전달 직전에 검사합니다",
    spot: { left: "25%", top: "13.42%", width: "50%", height: "72.5%" },
  },
  {
    id: "gateblocked", scene: "talk", caption: "bottom",
    title: "규칙 위반 메시지 차단",
    text: "차단된 메시지는 사유와 함께 기록됩니다. 반드시 전달해야 하는 경우 멤버가 강제 전송할 수 있으며, 이 경우 「강제」 표시가 기록됩니다",
    spot: { left: "61.56%", top: "66.8%", width: "36.42%", height: "6.36%" },
  },

  // --- 돌아가는 방식을 바꾼다 ---
  {
    id: "permission", scene: "control", caption: "top",
    title: "멤버별 권한 변경",
    text: "기본값은 「Default」이며 파일 수정 시마다 승인을 요청합니다. 작업 특성에 따라 권한 수준을 조정할 수 있으며 멤버별로 저장됩니다",
    spot: { left: "45.73%", top: "67.09%", width: "12.5%", height: "26.22%" },
  },
  {
    id: "model", scene: "control", caption: "bottom-left",
    title: "모델 및 추론 강도 변경",
    text: "헤더의 모델 칩을 선택하여 멤버의 모델과 추론 강도를 변경할 수 있습니다. 추론 강도가 높을수록 처리 시간과 사용량이 증가할 수 있습니다",
    spot: { left: "40.76%", top: "55.92%", width: "42.36%", height: "7.06%" },
  },
  {
    id: "mcp", scene: "control", caption: "top",
    title: "연결된 MCP 서버 확인",
    text: "⋯ → 「MCP 서버」에서 연결 상태, 제공되는 도구, 연결 실패 사유를 확인할 수 있습니다. 재연결과 인증도 이 화면에서 수행합니다",
    spot: { left: "27.57%", top: "37.58%", width: "44.86%", height: "37.18%" },
  },
  {
    id: "respawn", scene: "control", caption: "bottom-left",
    title: "문제 발생 시 세션 재시작",
    text: "⋯ → 「세션 재시작」을 선택하면 대화를 유지한 채 하네스를 다시 시작합니다. MCP 서버나 설정 변경 사항을 적용할 때도 사용합니다",
    spot: { left: "45.45%", top: "22.98%", width: "13.89%", height: "11.78%" },
  },
  {
    id: "hardrestart", scene: "control", caption: "bottom-right",
    title: "대화 맥락 초기화 — 하드 리스타트",
    text: "왼쪽 멤버를 마우스 오른쪽 버튼으로 선택하고 「하드 리스타트」를 선택합니다. 기존 대화 맥락이 초기화되므로 필요한 경우에만 사용하세요",
    spot: { left: "11.81%", top: "39.49%", width: "9.72%", height: "10.93%" },
  },
  {
    id: "runtime", scene: "control", caption: "bottom-right",
    title: "앱 전체 기본값 설정",
    text: "자동 압축 임계값, 유휴 슬립, 입력창 동작, 글꼴 등 앱 전체 설정을 관리합니다. 하네스별 기본 모델도 이 화면에서 지정합니다",
    spot: { left: "3.61%", top: "15.23%", width: "95.76%", height: "5.31%" },
  },

  // --- 얼마나 쓰는지 본다 ---
  {
    id: "context", scene: "cost", caption: "bottom",
    title: "컨텍스트 사용량 확인 및 압축",
    text: "도넛 차트는 해당 멤버의 컨텍스트 사용량을 표시합니다. 차트를 선택하여 즉시 압축하거나 자동 압축 임계값을 설정할 수 있습니다",
    spot: { left: "21.18%", top: "34.89%", width: "57.64%", height: "30.23%" },
  },
  {
    id: "limit", scene: "cost", caption: "bottom",
    title: "사용 한도 확인",
    text: "구독 사용 한도는 제목 표시줄에서 확인할 수 있습니다. 기본 안내가 완료되었습니다. 작업공간을 선택하고 파티를 생성해 보세요",
    spot: { left: "69.5%", top: "9.02%", width: "29.12%", height: "2.76%" },
  },
] as const satisfies ReadonlyArray<{
  id: string;
  scene: GuideSceneId;
  caption: GuideCaptionPlacement;
  title: string;
  text: string;
  spot: { left: string; top: string; width: string; height: string };
}>;

export type GuideSlideId = (typeof GUIDE_SLIDES)[number]["id"];

export const GUIDE_SLIDE_COUNT = GUIDE_SLIDES.length;

export const GUIDE_REFUSED = "가이드에서는 이 동작을 실행하지 않습니다.";

/**
 * One thing the stage does to ITSELF after it has rendered a slide's state.
 *
 * Modals, wizards and menus are component state, not app state: a snapshot alone
 * can never show the member wizard or the ⋯ menu. Rather than adding a QA hook
 * to the app for each one, the stage opens the REAL control the same way a user
 * would — so these slides keep following the app's UI instead of drifting into
 * a mock of it.
 *
 * A step whose selector never appears is a loud failure (the guide paints an
 * error banner over the stage), never a slide that quietly shows the wrong thing.
 */
export type GuideStageStep =
  | { do: "click"; selector: string }
  | { do: "contextmenu"; selector: string }
  | { do: "fill"; selector: string; text: string };

export interface GuideSnapshot {
  state: InitialAppState;
  transcripts: Record<string, TranscriptBlock[]>;
  layout?: WorkbenchLayout;
  usage?: UsageLimitsSnapshot;
  update?: UpdateStatus;
  discord?: DiscordBridgeStatus;
  /** MCP servers the member's harness reports, for the MCP modal slide. */
  mcp?: McpServerSnapshot;
  view?: "workbench" | "sessions" | "usage" | "auth" | "runtime" | "automation";
  /** Settings → 런타임 tab to land on, when `view` is `runtime`. */
  viewTab?: RuntimeTabId;
  viewHarness?: HarnessId;
  /** Real UI to open on top of the state (see {@link GuideStageStep}). */
  steps?: GuideStageStep[];
  sessionEvents?: Array<{ sessionId: string; events: unknown[] }>;
  qaOpenSubagent?: { member: string; subId: string };
  qaOpenGate?: { kind: "member" | "party"; member: string };
  tokenUsage?: TokenUsageAggregate;
  tokenUsageTurns?: TurnUsageRecord[];
}

export interface GuideScreenInfo {
  /** A window is showing the guide screen right now. */
  open: boolean;
  /** The presentation is up, as opposed to the landing chat. */
  presenting: boolean;
  /** The window showing it, named the way GET /api/windows names it. */
  id?: string;
  slide: number;
  slideCount: number;
  slideId?: GuideSlideId;
  title?: string;
  sceneId?: GuideSceneId;
  sceneTitle?: string;
}

/** One measured node from GET /api/guide/inspect. Missing is `present: false`, never omitted as "empty". */
export interface GuideInspectNode {
  present: boolean;
  text?: string;
  box?: { x: number; y: number; width: number; height: number };
  visible?: boolean;
  styles?: Record<string, string>;
  contrast?: number | null;
}

export interface GuideInspect {
  readyState: string;
  dataTheme: string | null;
  url: string;
  presenting: boolean;
  root: GuideInspectNode;
  landing: GuideInspectNode;
  start: GuideInspectNode;
  chat: GuideInspectNode;
  cost: GuideInspectNode;
  fab: GuideInspectNode;
  fabByTheme: { light: GuideInspectNode; dark: GuideInspectNode };
  slideMissing: Array<{ text: string }>;
  slideLinks: Array<{ text: string }>;
}

export function guideSlideAt(index: number): (typeof GUIDE_SLIDES)[number] {
  const slide = GUIDE_SLIDES[index];
  if (!slide) {
    throw new Error(`가이드 슬라이드 ${index}은(는) 없습니다(0…${GUIDE_SLIDE_COUNT - 1})`);
  }
  return slide;
}

export function clampGuideSlide(index: number): number {
  if (!Number.isInteger(index)) {
    throw new Error(`가이드 슬라이드 번호는 정수여야 합니다(입력값: ${String(index)})`);
  }
  if (index < 0 || index >= GUIDE_SLIDE_COUNT) {
    throw new Error(`가이드 슬라이드 ${index}은(는) 없습니다(0…${GUIDE_SLIDE_COUNT - 1})`);
  }
  return index;
}

export function firstSlideOfScene(scene: GuideSceneId): number {
  const index = GUIDE_SLIDES.findIndex((slide) => slide.scene === scene);
  if (index < 0) {
    throw new Error(`가이드 장면 '${scene}'이(가) 없습니다`);
  }
  return index;
}

export function sceneOf(index: number): (typeof GUIDE_SCENES)[number] {
  const slide = guideSlideAt(index);
  const scene = GUIDE_SCENES.find((item) => item.id === slide.scene);
  if (!scene) {
    throw new Error(`가이드 슬라이드 ${slide.id}에 장면 '${slide.scene}'이(가) 없습니다`);
  }
  return scene;
}

/** Slide range a scene covers, 1-based and inclusive — the "1–3" the table of
 *  contents prints on the right of each row. */
export function sceneRange(scene: GuideSceneId): { from: number; to: number } {
  const at = GUIDE_SCENES.findIndex((item) => item.id === scene);
  if (at < 0) {
    throw new Error(`가이드 장면 '${scene}'이(가) 없습니다`);
  }
  const next = GUIDE_SCENES[at + 1];
  return { from: GUIDE_SCENES[at].from + 1, to: next ? next.from : GUIDE_SLIDE_COUNT };
}

/** 1-based position of a slide's scene — the "장면 2 / 4" in the deck header. */
export function sceneNumberOf(index: number): number {
  const scene = sceneOf(index);
  return GUIDE_SCENES.findIndex((item) => item.id === scene.id) + 1;
}
