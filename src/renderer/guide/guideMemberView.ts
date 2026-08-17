/**
 * Adapts the guide's own chat onto the shape the WORKBENCH conversation view
 * already speaks (`MemberView` + `WorkbenchActions`).
 *
 * The guide chat is a member conversation without the tabs — so it renders with
 * the real `Transcript` and `Composer` instead of a second, lesser chat UI.
 * Tool blocks, thinking, the working state, the queue, approvals: all of it is
 * already built and already correct there. Rebuilding a simpler version would
 * mean two chat surfaces drifting apart, and the guide getting the worse one.
 *
 * Everything a member can do that the guide must NOT do (restart, respawn,
 * permissions, gate, party wiring) throws instead of quietly doing nothing —
 * a silent no-op here would look like the button worked.
 */
import type { WorkbenchActions } from "../workbench/actions";
import type { MemberView } from "../workbench/types";
import type { GuideChatKind, GuideChatSettings, GuideChatView } from "../../shared/guideChat";
import { DEFAULT_AUTO_COMPACT } from "../../shared/autoCompact";

/** The guide answers under this name, the way a member answers under its own. */
export const GUIDE_MEMBER_NAME = "가이드";

export function guideMemberView(view: GuideChatView, settings: GuideChatSettings, label: string): MemberView {
  return {
    name: GUIDE_MEMBER_NAME,
    color: "var(--accent)",
    member: {
      name: GUIDE_MEMBER_NAME,
      role: "이 앱에 대해 답합니다",
      runtime: settings.harnessId,
      model: settings.model,
      status: view.busy ? "running" : "idle",
    } as MemberView["member"],
    status: view.busy ? "working" : "idle",
    transcript: view.blocks,
    transcriptLoading: false,
    subagents: [],
    unread: 0,
    pendingApproval: false,
    busy: view.busy,
    model: label,
    effort: settings.effort || "medium",
    permissionMode: "guide",
    effortOptions: [],
    autoCompact: DEFAULT_AUTO_COMPACT,
    compacting: false,
  } as MemberView;
}

/** Refuses loudly. The guide window must never look like it did something. */
function refuse(what: string): never {
  throw new Error(`가이드 대화에서는 ${what} 을(를) 할 수 없습니다.`);
}

/**
 * The composer's palette routes settings commands (runtime, permissions, mcp,
 * …) through `commandUi`. The workbench opens those dialogs; the guide has no
 * such dialogs and must not fake them — each refuses loudly, the same rule as
 * `guideActions`. The commands the guide CAN honour (compact, restart,
 * interrupt) never touch this object.
 */
export const guideCommandUi = {
  openRuntime: () => refuse("런타임 변경"),
  openPermissions: () => refuse("권한 설정"),
  openMcp: () => refuse("MCP 설정"),
  openStatus: () => refuse("상태 화면"),
  openUsage: () => refuse("사용량 화면"),
  openSessions: () => refuse("세션 화면"),
  openAutoCompact: () => refuse("자동 압축 설정"),
} satisfies WorkbenchCommandUi;

/** The `commandUi` prop the workbench Composer takes (duplicated here to stay
 *  independent of the component file — the two must not drift far apart). */
interface WorkbenchCommandUi {
  openRuntime: () => void;
  openPermissions: () => void;
  openMcp: () => void;
  openStatus: () => void;
  openUsage: () => void;
  openSessions: () => void;
  openAutoCompact: () => void;
}

export function guideActions(kind: GuideChatKind, onView: (next: GuideChatView) => void): WorkbenchActions {
  const host = () => window.agentPartyGuide;
  return {
    async sendMessage(_name: string, text: string) {
      onView(await host().sendChat(kind, text));
      return undefined;
    },
    async runQueueCommand() {
      return undefined;
    },
    prewarm() {},
    approve: () => refuse("권한 승인"),
    answerQuestion: () => refuse("질문 응답"),
    interrupt: () => refuse("턴 중단"),
    forceStop: () => refuse("강제 중지"),
    restart: () => refuse("세션 재시작"),
    respawn: () => refuse("세션 재생성"),
    compact: () => {
      void host().compactChat(kind).then(onView);
    },
    setAutoCompact: () => refuse("자동 압축 설정"),
    setMemberGate: () => refuse("게이트 설정"),
    setMemberOutboundInterrupt: () => refuse("인터럽트 설정"),
    setPartyGate: () => refuse("파티 게이트 설정"),
    closeSession: () => refuse("세션 닫기"),
    openEnvironmentSettings: () => refuse("환경 설정 열기"),
    applyRuntime: () => refuse("런타임 변경"),
    setEffort: () => refuse("effort 변경"),
    setThinking: () => refuse("thinking 변경"),
  } as unknown as WorkbenchActions;
}
