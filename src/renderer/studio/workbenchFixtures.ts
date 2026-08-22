/**
 * Workbench-specific inputs: subagents, queues, panels.
 *
 * These are plain view-model objects the components already take. Where the app
 * has a builder for the shape (`buildSubDock`, `buildSubDetail`), the story
 * calls THAT builder rather than assembling the view-model by hand — the
 * grouping, the summary line and the status dots are logic, and logic copied
 * into a fixture is logic that can disagree with the app.
 */
import { STUDIO_AT } from "./fixtures";
import type { Subagent } from "../workbench/types";
import type { MemberQueueState } from "../../shared/messageQueue";
import type { WorkbenchPanel } from "../../shared/workbenchLayout";

/** Five shards, spread across every phase the dock has to show at once. */
export const SUBAGENTS: Subagent[] = [
  {
    id: "sub-auth",
    name: "shard-runner",
    hint: "auth/**",
    phase: "done",
    task: "auth 도메인 테스트를 격리 실행하고 실패·플레이키를 보고.",
    tools: "318 tests",
    dur: "2m 04s",
    blocks: [],
    updatedAt: STUDIO_AT,
  },
  {
    id: "sub-api",
    name: "shard-runner",
    hint: "api/**",
    phase: "done",
    task: "api 도메인 테스트를 격리 실행하고 실패·플레이키를 보고.",
    tools: "241 tests",
    dur: "1m 47s",
    blocks: [],
    updatedAt: STUDIO_AT,
  },
  {
    id: "sub-billing",
    name: "shard-runner",
    hint: "billing/**",
    phase: "working",
    task: "billing 도메인 테스트를 격리 실행하고 실패·플레이키를 보고.",
    tools: "2 failures",
    dur: "1m 12s",
    activity: { kind: "testing", label: "테스트 실행중 · shard 4 · billing/**" },
    blocks: [],
    updatedAt: STUDIO_AT,
  },
  {
    id: "sub-webhooks",
    name: "shard-runner",
    hint: "webhooks/**",
    phase: "working",
    task: "webhooks 도메인 테스트를 격리 실행하고 실패·플레이키를 보고.",
    tools: "0 failures",
    dur: "0m 51s",
    activity: { kind: "testing", label: "테스트 실행중 · shard 5 · webhooks/**" },
    blocks: [],
    updatedAt: STUDIO_AT,
  },
  {
    id: "sub-ui",
    name: "shard-runner",
    hint: "ui/**",
    phase: "queued",
    task: "ui 도메인 테스트를 격리 실행하고 실패·플레이키를 보고.",
    blocks: [],
    updatedAt: STUDIO_AT,
  },
];

/**
 * Two waiting messages, one of them a cut-in. The queue is the app's only
 * queue, so the card has to show ordering, the merge preference, and the
 * "중단하고 합쳐서 보내기" escape at once.
 */
export const QUEUE: MemberQueueState = {
  merge: true,
  items: [
    { id: "q-1", text: "리뷰 끝나면 이어서 부탁해", from: null, at: STUDIO_AT, cutIn: true } as never,
    { id: "q-2", text: "릴리스 노트 초안도 같이", from: null, at: STUDIO_AT } as never,
  ],
};

/** One panel holding both members, so the tab strip has something to arrange. */
export const PANEL: WorkbenchPanel = {
  id: "panel-1",
  tabs: ["impl", "luna"],
  active: "impl",
  weight: 1,
};
