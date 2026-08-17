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
  { id: "connect", title: "계정을 연결한다", blurb: "구독 · API 키", from: 0 },
  { id: "party", title: "팀을 꾸린다", blurb: "작업공간 · 파티 · 멤버 만들기", from: 3 },
  { id: "work", title: "일을 시킨다", blurb: "입력창 · 실행 · 승인 · 대기열", from: 10 },
  { id: "talk", title: "서로 이야기하게 한다", blurb: "패널 · 채널 · Message Gate", from: 16 },
  { id: "control", title: "돌아가는 방식을 바꾼다", blurb: "권한 · 모델 · MCP · 재시작", from: 22 },
  { id: "cost", title: "얼마나 쓰는지 본다", blurb: "컨텍스트 · 남은 한도", from: 28 },
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
    title: "먼저 쓸 계정을 연결한다",
    text: "왼쪽 세로 막대의 열쇠 아이콘(인증)을 누릅니다. 구독 카드의 「구독 연결」 을 누르면 됩니다 — 둘 다 필요하지는 않고, 쓸 것만 연결하세요.",
    spot: { left: "5%", top: "15.87%", width: "50%", height: "19.3%" },
  },
  {
    id: "authpending", scene: "connect", caption: "bottom-right",
    title: "브라우저에서 로그인하면 연결된다",
    text: "누르면 브라우저가 열리고 카드는 「인증 대기 중」 이 됩니다. 기본 브라우저에 그 계정이 없으면, 함께 뜨는 주소를 복사해 다른 브라우저에 붙여 넣으세요.",
    spot: { left: "5%", top: "27.24%", width: "50%", height: "9.26%" },
  },
  {
    id: "authdone", scene: "connect", caption: "bottom-right",
    title: "연결되면 「사용 가능」 으로 바뀐다",
    text: "이제 그 계정의 모델을 멤버에게 붙일 수 있습니다. 아래 API 키 칸은 구독이 아닌 모델(OpenRouter · DeepSeek)을 쓸 때만 채우면 됩니다.",
    spot: { left: "5%", top: "18.68%", width: "50%", height: "7.71%" },
  },

  // --- 팀을 꾸린다 ---
  {
    id: "workspace", scene: "party", caption: "bottom",
    title: "일할 폴더를 고른다",
    text: "오른쪽 위 「작업공간」 을 누르고 프로젝트 폴더를 고르세요. 멤버들은 이 폴더 안에서 파일을 읽고 고칩니다.",
    spot: { left: "92.49%", top: "5.1%", width: "6.12%", height: "3.29%" },
  },
  {
    id: "newparty", scene: "party", caption: "bottom-right",
    title: "Parties 의 + 를 누르면 이 창이 뜬다",
    text: "이름을 적고 「파티 만들기」. 메시지 게이트는 꺼진 채로 시작해도 되고, 나중에 언제든 켤 수 있습니다.",
    spot: { left: "33.33%", top: "34.55%", width: "33.33%", height: "30.89%" },
  },
  {
    id: "partyready", scene: "party", caption: "bottom-right",
    title: "파티가 생기면 main 이 함께 만들어진다",
    text: "파티는 하나의 팀이고, main 은 처음부터 있는 멤버입니다. 이름을 클릭하면 오른쪽에 그 멤버와의 대화창이 열립니다.",
    spot: { left: "4.31%", top: "37.45%", width: "14.93%", height: "4.03%" },
  },
  {
    id: "wizardname", scene: "party", caption: "bottom-right",
    title: "Members 의 + → 이름과 설명을 적는다",
    text: "설명은 그 멤버가 자기 역할로 전달받습니다. 여기서 바로 「기본 설정으로 만들기」 를 눌러 나머지를 건너뛸 수도 있습니다.",
    spot: { left: "30.56%", top: "25.96%", width: "38.89%", height: "48.09%" },
  },
  {
    id: "wizardmodel", scene: "party", caption: "bottom-right",
    title: "「변경」 을 누르면 모델 목록이 열린다",
    text: "하네스(Claude Code · Codex · Cursor)를 고르고 그 안에서 모델을 고릅니다. 한 파티에 서로 다른 하네스를 섞어도 됩니다.",
    spot: { left: "15.35%", top: "12.48%", width: "23.89%", height: "75.69%" },
  },
  {
    id: "wizardpermission", scene: "party", caption: "bottom-right",
    title: "마지막으로 처음 권한을 정한다",
    text: "Codex 는 샌드박스와 승인 두 축, Claude Code 는 한 가지 모드입니다. 만든 뒤에도 대화창 옆에서 언제든 바꿀 수 있습니다.",
    spot: { left: "30.56%", top: "23.3%", width: "38.89%", height: "53.4%" },
  },
  {
    id: "membersopen", scene: "party", caption: "bottom",
    title: "이름을 클릭하면 탭으로 열린다",
    text: "연 멤버는 위쪽에 탭으로 쌓입니다. 탭의 X 는 화면만 닫는 게 아니라 그 멤버의 세션도 끝내니, 잠깐 비울 거면 그냥 두세요.",
    spot: { left: "21.11%", top: "14.65%", width: "77.99%", height: "4.03%" },
  },

  // --- 일을 시킨다 ---
  {
    id: "composer", scene: "work", caption: "top",
    title: "시킬 일을 입력창에 적는다",
    text: "쓰고 Ctrl+Enter 로 보냅니다. 이미지·파일은 끌어다 놓고, m: 을 치면 다른 멤버를 이름으로 끼워 넣을 수 있습니다.",
    spot: { left: "21.11%", top: "86.73%", width: "77.99%", height: "11.89%" },
  },
  {
    id: "running", scene: "work", caption: "top",
    title: "보내면 Send 자리가 Stop 으로 바뀐다",
    text: "잘못 시켰다 싶으면 Stop 을 누르세요. 지금 턴만 끊고 대화는 그대로 남습니다. 왼쪽 목록의 그 멤버도 「작업 중」 으로 바뀝니다.",
    spot: { left: "21.11%", top: "86.52%", width: "77.99%", height: "12.1%" },
  },
  {
    id: "tools", scene: "work", caption: "top",
    title: "무엇을 실행했는지 그대로 보인다",
    text: "도구 상자를 클릭하면 명령 원문과 종료 코드, 걸린 시간이 나옵니다. 여기서는 테스트가 exit 1 로 떨어진 것까지 감추지 않고 보여 줍니다.",
    spot: { left: "22.22%", top: "35.48%", width: "75.14%", height: "43.45%" },
  },
  {
    id: "approval", scene: "work", caption: "top",
    title: "파일을 고치기 전에 멈추고 물어본다",
    text: "무엇이 어떻게 바뀌는지 카드 안에 그대로 나옵니다. 「이번만 허용」 을 누를 때까지 멤버는 기다리고, 왼쪽 이름에는 승인 배지가 붙습니다.",
    spot: { left: "22.22%", top: "36.06%", width: "75.14%", height: "48.99%" },
  },
  {
    id: "applied", scene: "work", caption: "top",
    title: "허용하면 반영하고 다시 돌린다",
    text: "고친 내용과 다시 돌린 테스트가 차례로 남습니다. 이번엔 exit 0 — 무엇을 근거로 「됐다」 고 하는지 확인할 수 있습니다.",
    spot: { left: "22.22%", top: "39.9%", width: "75.14%", height: "39.09%" },
  },
  {
    id: "queue", scene: "work", caption: "top",
    title: "도는 중에 더 시키면 줄을 선다",
    text: "지금 턴을 방해하지 않고 순서대로 들어갑니다. 기다리는 메시지는 취소하거나 먼저 처리할 수 있고, 다른 멤버가 보낸 것도 같은 줄에 섭니다.",
    spot: { left: "21.88%", top: "70.59%", width: "76.46%", height: "16.14%" },
  },

  // --- 서로 이야기하게 한다 ---
  {
    id: "panels", scene: "talk", caption: "bottom-left",
    title: "탭을 오른쪽 끝으로 끌면 둘로 나뉜다",
    text: "두 멤버를 나란히 두고 볼 수 있습니다. 이 배치는 파티별로 기억됐다가 다시 열 때 그대로 돌아옵니다.",
    spot: { left: "60.38%", top: "14.23%", width: "38.78%", height: "84.5%" },
  },
  {
    id: "channel", scene: "talk", caption: "bottom",
    title: "멤버끼리 말하게 하려면 그렇게 시키면 된다",
    text: "「reviewer 에게 리뷰를 부탁해」 라고 친 한 줄과, 그 결과로 main 이 보낸 메시지가 함께 남습니다. 따로 켤 설정은 없습니다.",
    spot: { left: "22.22%", top: "59.91%", width: "35.8%", height: "19.04%" },
  },
  {
    id: "channelin", scene: "talk", caption: "bottom-left",
    title: "받은 쪽에도 같은 말이 남는다",
    text: "오른쪽 reviewer 의 대화에 방향 표시와 함께 들어와 있고, 답장은 다시 main 에게 돌아갑니다. 누가 무엇을 말했는지 양쪽에서 확인됩니다.",
    spot: { left: "61.56%", top: "24.63%", width: "36.42%", height: "30.3%" },
  },
  {
    id: "membercreate", scene: "talk", caption: "bottom-right",
    title: "멤버를 만드는 일도 시킬 수 있다",
    text: "「impl 멤버를 만들어 줘」 라고 하면 main 이 도구를 써서 만듭니다. 왼쪽 목록에 바로 나타나고, 곧장 말을 걸 수 있습니다.",
    spot: { left: "4.31%", top: "46.36%", width: "14.93%", height: "4.03%" },
  },
  {
    id: "gate", scene: "talk", caption: "bottom-right",
    title: "오가는 말에 규칙을 걸어 둔다",
    text: "파티를 우클릭 → 「메시지 게이트 설정」. 여기 적은 규칙을 리뷰어 모델이 전달 직전에 심사합니다.",
    spot: { left: "25%", top: "13.42%", width: "50%", height: "73.17%" },
  },
  {
    id: "gateblocked", scene: "talk", caption: "bottom",
    title: "규칙을 어기면 전달되지 않는다",
    text: "막힌 메시지는 사유와 함께 남습니다. 정말 보내야 하는 경우 멤버가 강제로 보낼 수 있고, 그때도 「강제」 표시가 남습니다.",
    spot: { left: "61.56%", top: "66.8%", width: "36.42%", height: "6.36%" },
  },

  // --- 돌아가는 방식을 바꾼다 ---
  {
    id: "permission", scene: "control", caption: "top",
    title: "권한은 입력창 옆에서 바꾼다",
    text: "기본은 「Default」 — 파일을 고칠 때마다 물어봅니다. 승인 누르기가 번거로우면 올리고, 위험한 작업을 앞두고 있으면 내리세요. 멤버마다 따로 정해집니다.",
    spot: { left: "45.73%", top: "67.09%", width: "12.5%", height: "26.22%" },
  },
  {
    id: "model", scene: "control", caption: "bottom-left",
    title: "모델과 추론 강도를 바꾼다",
    text: "헤더의 모델 칩을 누르면 이 멤버의 모델 · 추론 강도를 바로 고를 수 있습니다. 강도를 올리면 더 오래 생각하고 그만큼 더 씁니다.",
    spot: { left: "40.76%", top: "55.92%", width: "42.36%", height: "7.06%" },
  },
  {
    id: "mcp", scene: "control", caption: "top",
    title: "붙어 있는 MCP 서버를 확인한다",
    text: "⋯ → 「MCP 서버」. 어떤 서버에 붙었고 어떤 도구가 늘었는지, 못 붙은 서버는 왜인지 나옵니다. 재연결과 인증도 여기서 합니다.",
    spot: { left: "27.57%", top: "37.58%", width: "44.86%", height: "37.18%" },
  },
  {
    id: "respawn", scene: "control", caption: "bottom-left",
    title: "이상하면 세션 재시작",
    text: "⋯ → 「세션 재시작」. 대화는 그대로 두고 하네스만 다시 띄웁니다. MCP 서버나 설정을 바꾼 뒤 적용할 때도 이걸 씁니다.",
    spot: { left: "45.45%", top: "22.98%", width: "13.89%", height: "11.78%" },
  },
  {
    id: "hardrestart", scene: "control", caption: "bottom-right",
    title: "처음부터 다시 하려면 하드 리스타트",
    text: "왼쪽 멤버를 우클릭. 「하드 리스타트」 는 대화 맥락까지 버리고 새로 시작합니다 — 지금까지의 대화가 사라지니, 헷갈릴 때만 쓰세요.",
    spot: { left: "11.81%", top: "39.49%", width: "9.72%", height: "10.93%" },
  },
  {
    id: "runtime", scene: "control", caption: "bottom-right",
    title: "전체 기본값은 런타임 설정에서",
    text: "자동 압축 임계값, 유휴 슬립, 입력창 동작, 글꼴처럼 앱 전체에 걸리는 것들이 모여 있습니다. 하네스별 기본 모델도 여기서 정합니다.",
    spot: { left: "3.61%", top: "15.23%", width: "95.76%", height: "5.31%" },
  },

  // --- 얼마나 쓰는지 본다 ---
  {
    id: "context", scene: "cost", caption: "bottom",
    title: "대화가 차면 눌러서 줄인다",
    text: "도넛은 그 멤버의 대화가 얼마나 찼는지입니다. 클릭하면 지금 압축하거나, 몇 % 에서 자동으로 줄일지 정할 수 있습니다.",
    spot: { left: "21.18%", top: "34.89%", width: "57.64%", height: "30.23%" },
  },
  {
    id: "limit", scene: "cost", caption: "bottom",
    title: "남은 한도는 늘 위에 있다",
    text: "구독의 남은 한도가 제목 표시줄에 붙어 있습니다. 여기까지가 한 바퀴입니다 — 이제 폴더를 고르고 파티를 하나 만들어 보세요.",
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
    throw new Error(`가이드 슬라이드 ${index} 은(는) 없습니다 (0…${GUIDE_SLIDE_COUNT - 1}).`);
  }
  return slide;
}

export function clampGuideSlide(index: number): number {
  if (!Number.isInteger(index)) {
    throw new Error(`가이드 슬라이드 번호는 정수여야 합니다 (받은 값: ${String(index)}).`);
  }
  if (index < 0 || index >= GUIDE_SLIDE_COUNT) {
    throw new Error(`가이드 슬라이드 ${index} 은(는) 없습니다 (0…${GUIDE_SLIDE_COUNT - 1}).`);
  }
  return index;
}

export function firstSlideOfScene(scene: GuideSceneId): number {
  const index = GUIDE_SLIDES.findIndex((slide) => slide.scene === scene);
  if (index < 0) {
    throw new Error(`가이드 장면 '${scene}' 이(가) 없습니다.`);
  }
  return index;
}

export function sceneOf(index: number): (typeof GUIDE_SCENES)[number] {
  const slide = guideSlideAt(index);
  const scene = GUIDE_SCENES.find((item) => item.id === slide.scene);
  if (!scene) {
    throw new Error(`가이드 슬라이드 ${slide.id} 의 장면 '${slide.scene}' 이(가) 없습니다.`);
  }
  return scene;
}

/** Slide range a scene covers, 1-based and inclusive — the "1–3" the table of
 *  contents prints on the right of each row. */
export function sceneRange(scene: GuideSceneId): { from: number; to: number } {
  const at = GUIDE_SCENES.findIndex((item) => item.id === scene);
  if (at < 0) {
    throw new Error(`가이드 장면 '${scene}' 이(가) 없습니다.`);
  }
  const next = GUIDE_SCENES[at + 1];
  return { from: GUIDE_SCENES[at].from + 1, to: next ? next.from : GUIDE_SLIDE_COUNT };
}

/** 1-based position of a slide's scene — the "장면 2 / 4" in the deck header. */
export function sceneNumberOf(index: number): number {
  const scene = sceneOf(index);
  return GUIDE_SCENES.findIndex((item) => item.id === scene.id) + 1;
}
