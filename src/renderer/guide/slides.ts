/**
 * Ten placeholder snapshots so the stage, chrome, and jump can be exercised.
 * Content is not the product — replace later in one pass.
 */
import { GUIDE_SLIDES, type GuideSlideId, type GuideSnapshot } from "../../shared/guide";
import type { TranscriptBlock } from "../../shared/transcript";
import {
  IMPL,
  MAIN,
  REVIEWER,
    member,
  sessionView,
  snap,
} from "./fixtures";

const ASK: TranscriptBlock[] = [
  { id: "a1", kind: "user", text: "이 파일을 설명해 줘.", at: "10:02" },
];
const REPLY: TranscriptBlock[] = [
  ...ASK,
  { id: "a2", kind: "assistant", text: "진입점부터 읽겠습니다.", at: "10:02" },
];
const CHANNEL_MAIN: TranscriptBlock[] = [
  ...REPLY,
  { id: "c1", kind: "channel", direction: "out", from: "main", to: "reviewer", text: "이 부분 봐 줄래?", state: "ok", at: "10:14" },
  { id: "c2", kind: "channel", direction: "in", from: "reviewer", to: "main", text: "보고 바로 남길게.", state: "ok", at: "10:15" },
];
const CHANNEL_REVIEWER: TranscriptBlock[] = [
  { id: "r1", kind: "channel", direction: "in", from: "main", to: "reviewer", text: "이 부분 봐 줄래?", state: "ok", at: "10:14" },
  { id: "r2", kind: "channel", direction: "out", from: "reviewer", to: "main", text: "보고 바로 남길게.", state: "ok", at: "10:15" },
];
const APPROVAL: TranscriptBlock[] = [
  { id: "p1", kind: "user", text: "이 파일을 고쳐 줘.", at: "10:21" },
  { id: "p2", kind: "approval", requestId: "appr-1", toolName: "Edit", title: "파일 수정", input: { path: "app.ts" }, at: "10:21" },
];
const GATE: TranscriptBlock[] = [
  ...CHANNEL_REVIEWER,
  { id: "g1", kind: "gate", gate: "rejected", to: "impl", from: "reviewer", reason: "전달하지 않았습니다.", at: "10:18" },
];

const two = [
  { id: "p1", tabs: ["main"], active: "main" },
  { id: "p2", tabs: ["reviewer"], active: "reviewer" },
];

/** The populated party the first scene spotlights — sidebar, harness badges and
 *  the member-create affordance all live on this one state. */
const TWO: GuideSnapshot = snap({
  members: [MAIN, REVIEWER],
  sessions: [sessionView("s-main", MAIN.model!, "idle", 12000), sessionView("s-reviewer", REVIEWER.model!, "idle")],
  transcripts: { main: REPLY, reviewer: [] },
  panels: two,
});

const SLIDE_SNAPSHOTS: Record<GuideSlideId, GuideSnapshot> = {
  sidebar: TWO,
  harness: TWO,
  create: TWO,
  composer: snap({
    members: [MAIN],
    sessions: [sessionView("s-main", MAIN.model!, "idle", 12000)],
    transcripts: { main: REPLY },
    panels: [{ id: "p1", tabs: ["main"], active: "main" }],
  }),
  channel: snap({
    members: [MAIN, REVIEWER],
    sessions: [sessionView("s-main", MAIN.model!, "idle", 18000), sessionView("s-reviewer", REVIEWER.model!, "idle", 4000)],
    transcripts: { main: CHANNEL_MAIN, reviewer: CHANNEL_REVIEWER },
    panels: two,
  }),
  tabs: snap({
    members: [member({ name: "main", status: "running", runtime: "claude-code", role: "진행", model: "claude-sonnet-4.5", sessionId: "s-main" }), REVIEWER, IMPL],
    sessions: [sessionView("s-main", MAIN.model!, "responding", 88000), sessionView("s-reviewer", REVIEWER.model!, "idle", 14000)],
    transcripts: { main: REPLY, reviewer: [] },
    panels: [
      { id: "p1", tabs: ["main"], active: "main" },
      { id: "p2", tabs: ["reviewer", "impl"], active: "reviewer" },
    ],
  }),
  tools: snap({
    members: [member({ name: "main", status: "running", runtime: "claude-code", role: "진행", model: "claude-sonnet-4.5", sessionId: "s-main" }), REVIEWER],
    sessions: [sessionView("s-main", MAIN.model!, "idle", 40000, 1), sessionView("s-reviewer", REVIEWER.model!, "idle")],
    transcripts: { main: APPROVAL, reviewer: [] },
    panels: two,
  }),
  gate: snap({
    members: [MAIN, REVIEWER],
    sessions: [sessionView("s-main", MAIN.model!, "idle", 18000), sessionView("s-reviewer", REVIEWER.model!, "idle", 8000)],
    transcripts: { main: CHANNEL_MAIN, reviewer: GATE },
    panels: two,
    gate: { enabled: true, rule: "자리표시자 규칙" },
  }),
  usage: snap({
    members: [MAIN, REVIEWER],
    sessions: [sessionView("s-main", MAIN.model!, "idle", 18000), sessionView("s-reviewer", REVIEWER.model!, "idle", 4000)],
    transcripts: { main: CHANNEL_MAIN, reviewer: CHANNEL_REVIEWER },
    panels: two,
  }),
  limit: snap({
    members: [MAIN, REVIEWER],
    sessions: [sessionView("s-main", MAIN.model!, "idle", 18000), sessionView("s-reviewer", REVIEWER.model!, "idle", 4000)],
    transcripts: { main: CHANNEL_MAIN, reviewer: CHANNEL_REVIEWER },
    panels: two,
  }),
};

/** A slide is its catalog entry (title · caption · spotlight) plus the absolute
 *  workbench state the stage shows for it. */
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
