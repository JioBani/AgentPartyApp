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

/** Chapter titles in the table of contents (§2-3). Not the slide list. */
export const GUIDE_SCENES = [
  { id: "empty", title: "빈 화면" },
  { id: "members", title: "멤버" },
  { id: "states", title: "여러 상태" },
  { id: "start", title: "이제 시작" },
] as const;

export type GuideSceneId = (typeof GUIDE_SCENES)[number]["id"];

/** Placeholder beats to exercise the stage. Content is not the product yet. */
export const GUIDE_SLIDES = [
  { id: "empty", scene: "empty", title: "파티가 없다" },
  { id: "one-member", scene: "members", title: "멤버 하나" },
  { id: "first-chat", scene: "members", title: "첫 대화" },
  { id: "two-members", scene: "members", title: "멤버 둘" },
  { id: "channel", scene: "states", title: "멤버끼리 메시지" },
  { id: "working", scene: "states", title: "일하는 중 / 잠든 중" },
  { id: "approval", scene: "states", title: "승인 카드" },
  { id: "gate", scene: "states", title: "게이트 거절" },
  { id: "ready", scene: "start", title: "이 화면이 작업공간이다" },
  { id: "leave", scene: "start", title: "작업공간으로" },
] as const satisfies ReadonlyArray<{ id: string; scene: GuideSceneId; title: string }>;

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
