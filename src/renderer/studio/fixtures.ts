/**
 * The inputs the studio feeds the SHIPPING components.
 *
 * Nothing here draws UI. Every layer is the app's own:
 *
 *   recorded events → applyEvents()      (the real transcript reducer)
 *                   → buildMemberView()  (the real view assembler)
 *                   → <Panel/> <Composer/> …  (the real components)
 *
 * That chain is why a studio page cannot look different from the app: there is
 * no second implementation anywhere in it. The previous design bundle lifted
 * DOM out of a running app and wrapped it in empty ancestor stubs, which lost
 * siblings, lost state, and needed a made-up width to stand up at all.
 */
import { applyEvents } from "../../shared/transcriptEvents";
import { DEFAULT_AUTO_COMPACT } from "../../shared/autoCompact";
import { buildMemberView } from "../workbench/memberStatus";
import type { WorkbenchActions } from "../workbench/actions";
import type { MemberView } from "../workbench/types";
import type { PartyMember } from "../../shared/types";
import type { TranscriptBlock } from "../../shared/transcript";

/** A fixed clock: a studio page that re-renders must not change its own text. */
export const STUDIO_AT = "2026-08-22T09:49:00.000Z";

/**
 * Actions are inert here. The studio is a picture of the UI, not a running
 * session — there is no harness to send to. They are silent (rather than the
 * guide window's loud refusal) because nobody is being misled: no state in a
 * studio page claims a turn happened.
 */
export const studioActions = new Proxy({} as WorkbenchActions, {
  get: () => async () => undefined,
});

export const studioCommandUi = {
  openRuntime: () => {},
  openPermissions: () => {},
  openMcp: () => {},
  openStatus: () => {},
  openUsage: () => {},
  openAutoCompact: () => {},
};

export function member(name: string, over: Partial<PartyMember> = {}): PartyMember {
  return {
    name,
    role: "",
    runtime: "claude-code",
    model: "claude-sonnet-4.5",
    status: "opened",
    location: "C:/Project/AgentPartyApp",
    ...over,
  } as PartyMember;
}

/** Runs events through the app's reducer and returns the blocks it produced. */
export function blocksFrom(events: unknown[]): TranscriptBlock[] {
  return applyEvents({}, "studio", events as any[])["studio"] || [];
}

interface ViewOptions {
  member?: Partial<PartyMember>;
  /** Blocks to show. Passed as `restored`, so no live session is needed. */
  blocks?: TranscriptBlock[];
  events?: unknown[];
  subagents?: unknown[];
  unreadFrom?: number;
}

/** One member as the workbench would assemble it. */
export function view(name: string, options: ViewOptions = {}): MemberView {
  const blocks = options.blocks ?? blocksFrom(options.events ?? []);
  return buildMemberView({
    member: member(name, options.member),
    sessions: [],
    transcriptBySession: {},
    seenCount: options.unreadFrom ?? blocks.length,
    restored: blocks,
    compactDefault: DEFAULT_AUTO_COMPACT,
  });
}

/**
 * The conversation the design pages show. Recorded shapes only — the same event
 * kinds the harnesses really send, so the reducer takes the same branches it
 * takes in a session.
 */
export const CONVERSATION: unknown[] = [
  { type: "queue_dequeued", count: 1, text: '@luna 이 "C:/Project/AgentPartyApp/src/main.ts" 빌드 실패 같이 봐줘' },
  {
    type: "assistant_text_delta",
    text: "빌드 로그부터 확인했습니다.\n\n## 원인\n\n`moduleResolution` 이 `bundler` 인데 이 패키지는 `node16` 을 기대합니다.\n\n```ts\n{ \"compilerOptions\": { \"moduleResolution\": \"node16\" } }\n```\n",
  },
  {
    type: "tool_call",
    id: "c-bash",
    name: "Bash",
    status: "completed",
    input: { command: "npm run build" },
    result: "✓ built in 3.41s",
    exitCode: 0,
    durationMs: 3410,
    cwd: "C:/Project/AgentPartyApp",
  },
  {
    type: "plan",
    steps: [
      { step: "tsconfig 조정", status: "completed" },
      { step: "빌드 재실행", status: "inProgress" },
      { step: "실패한 테스트만 재실행", status: "pending" },
    ],
  },
  { type: "status", status: "idle", contextTokens: 118_400, contextWindow: 200_000, at: STUDIO_AT },
];
