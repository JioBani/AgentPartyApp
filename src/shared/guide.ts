/**
 * Guide stage contract — the snapshot the fake preload holds, and the catalog
 * the desktop window / HTTP API use to name slides.
 *
 * Slide *content* lives in `src/renderer/guide/`. This file is only the shape
 * both sides must agree on.
 */
import type { InitialAppState } from "./types";
import type { WorkbenchLayout } from "./workbenchLayout";
import type { TranscriptBlock } from "./transcript";
import type { UsageLimitsSnapshot } from "./usageLimits";
import type { UpdateStatus } from "./appUpdate";
import type { DiscordBridgeStatus } from "./discordBridge";
import type { TokenUsageAggregate, TurnUsageRecord } from "./tokenUsage";

/** Chapter titles in the table of contents (§2-3). Not the slide list.
 *  Titles, blurbs and boundaries come from the design canon (guide.html SCENES). */
export const GUIDE_SCENES = [
  { id: "party", title: "파티를 만든다", blurb: "파티 · 멤버 · 살아 있는 상태", from: 0 },
  { id: "work", title: "멤버에게 일을 시킨다", blurb: "탭 · 컴포저 · 도구 호출", from: 3 },
  { id: "talk", title: "멤버끼리 이야기한다", blurb: "채널 · Message Gate", from: 6 },
  { id: "cost", title: "비용을 본다", blurb: "Token Usage · 사용 한도", from: 8 },
] as const;

export type GuideSceneId = (typeof GUIDE_SCENES)[number]["id"];

/** Placeholder beats to exercise the stage. Content is not the product yet.
 *  Caption text and spotlight rectangles are the design canon's (guide.html SLIDES);
 *  the spot percentages were measured against the real workbench, so they must be
 *  re-measured — never eyeballed — when that layout changes. */
export const GUIDE_SLIDES = [
  { id: "sidebar", scene: "party", title: "파티는 멤버가 모여 있는 자리다", text: "왼쪽 사이드바가 파티와 그 안의 멤버를 보여줍니다. 점 색이 곧 멤버의 살아 있는 상태입니다.", spot: { left: "2.8%", top: "12%", width: "18%", height: "88.5%" } },
  { id: "harness", scene: "party", title: "멤버마다 하네스가 다르다", text: "이름 옆의 표시가 그 멤버를 움직이는 CLI 입니다. 파티 하나에 여러 하네스를 섞어 둘 수 있습니다.", spot: { left: "3.2%", top: "31.6%", width: "17.2%", height: "22%" } },
  { id: "create", scene: "party", title: "멤버를 하나 더 만든다", text: "신원 · 런타임 · 권한 세 걸음으로 끝납니다. 권한은 나중에 언제든 바꿉니다.", spot: { left: "3.2%", top: "78%", width: "17.2%", height: "21.5%" } },
  { id: "tabs", scene: "work", title: "탭으로 열어 일을 맡긴다", text: "멤버를 누르면 워크벤치에 탭이 열립니다. 탭 줄에서 패널을 나눠 여러 멤버를 나란히 봅니다.", spot: { left: "20.4%", top: "13.8%", width: "40%", height: "5.6%" } },
  { id: "composer", scene: "work", title: "말을 건다", text: "아래 입력창이 그 멤버와의 대화입니다. 파일과 다른 멤버를 칩으로 문장 안에 끼워 넣을 수 있습니다.", spot: { left: "20.4%", top: "85.6%", width: "40%", height: "13.8%" } },
  { id: "tools", scene: "work", title: "도구를 쓰는 게 보인다", text: "명령과 결과가 접힌 블록으로 남습니다. exit 코드와 소요 시간까지 그 자리에 있습니다.", spot: { left: "21.5%", top: "76.6%", width: "37.2%", height: "5.8%" } },
  { id: "channel", scene: "talk", title: "멤버끼리 이야기한다", text: "채널에서는 멤버가 서로에게 메시지를 보냅니다. 사람이 매번 옮겨 붙이지 않습니다.", spot: { left: "20.4%", top: "45.3%", width: "40%", height: "41.5%" } },
  { id: "gate", scene: "talk", title: "Message Gate 가 한 번 걸러 준다", text: "오가는 메시지를 심사해 통과 · 거절을 정합니다. 거절되면 그 사실이 배지로 남습니다.", spot: { left: "20.4%", top: "45.3%", width: "40%", height: "20%" } },
  { id: "usage", scene: "cost", title: "어디서 얼마나 타는지 본다", text: "Token Usage 화면이 멤버별 · 모델별로 사용량을 모아 줍니다.", spot: { left: "0.2%", top: "12.4%", width: "3.4%", height: "5.2%" } },
  { id: "limit", scene: "cost", title: "한도는 타이틀바에서 확인한다", text: "계정별 사용 한도는 항상 위쪽 링으로 보입니다. 여기까지가 한 바퀴입니다.", spot: { left: "69.6%", top: "8.2%", width: "29.6%", height: "4.8%" } },
] as const satisfies ReadonlyArray<{
  id: string;
  scene: GuideSceneId;
  title: string;
  text: string;
  spot: { left: string; top: string; width: string; height: string };
}>;

export type GuideSlideId = (typeof GUIDE_SLIDES)[number]["id"];

export const GUIDE_SLIDE_COUNT = GUIDE_SLIDES.length;

export const GUIDE_REFUSED = "가이드에서는 이 동작을 실행하지 않습니다.";

export interface GuideSnapshot {
  state: InitialAppState;
  transcripts: Record<string, TranscriptBlock[]>;
  layout?: WorkbenchLayout;
  usage?: UsageLimitsSnapshot;
  update?: UpdateStatus;
  discord?: DiscordBridgeStatus;
  view?: "workbench" | "sessions" | "usage" | "auth" | "runtime" | "automation";
  sessionEvents?: Array<{ sessionId: string; events: unknown[] }>;
  qaOpenSubagent?: { member: string; subId: string };
  qaOpenGate?: { kind: "member" | "party"; member: string };
  tokenUsage?: TokenUsageAggregate;
  tokenUsageTurns?: TurnUsageRecord[];
}

export interface GuideWindowInfo {
  open: boolean;
  presenting: boolean;
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
