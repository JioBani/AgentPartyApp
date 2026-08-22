/**
 * Inputs for the SCREEN stories — whole app surfaces, not single components.
 *
 * The workbench screen mounts the real `<Workbench/>`. Everything it needs is
 * data or callbacks, so a design page can show the entire surface — sidebar,
 * tabs, panels, transcript, composer — with nothing running and no copy of the
 * layout anywhere. The party/group/cwd fixtures are the ones the existing
 * design preview already uses, so the two surfaces describe the same app.
 */
import {
  GALLERY_APP_WORKSPACE_ROOT,
  GALLERY_CWD_PREFERENCES,
  GALLERY_GROUPS,
  GALLERY_NOW,
  GALLERY_PARTIES,
  GALLERY_MEMBER_PROFILE,
  GALLERY_ROUTE,
} from "../../shared/partyGroupsGallery";
import { DEFAULT_SIDEBAR_DRAWERS } from "../../shared/sidebarDrawers";
import { CONVERSATION, STUDIO_AT, studioActions, view } from "./fixtures";
import type { MemberView } from "../workbench/types";

/** The party the workbench screen is looking at. */
export const SCREEN_PARTY_ID = "p-agentparty";

/** A second member, so the screen shows what two panels really look like. */
const REVIEW_CONVERSATION: unknown[] = [
  { type: "queue_dequeued", count: 1, text: "리뷰 결과 정리해서 알려줘" },
  {
    type: "assistant_text_delta",
    text: "변경점 12개 중 **2개**가 눈에 걸립니다.\n\n- `applyEvents` 의 압축 분기가 이전 블록을 지웁니다\n- 큐 병합이 발신자 경계를 넘습니다\n",
  },
  { type: "status", status: "idle", contextTokens: 41_200, contextWindow: 200_000, at: STUDIO_AT },
];

export const SCREEN_VIEWS: MemberView[] = [
  view("impl", { member: { role: "구현 담당", runtime: "claude-code" }, events: CONVERSATION }),
  view("luna", { member: { role: "리뷰 담당", runtime: "codex", model: "gpt-5.4-mini" }, events: REVIEW_CONVERSATION }),
];

const noop = () => {};
const asyncTrue = async () => true;

/**
 * Everything `<Workbench/>` takes. Casts are deliberate and follow the
 * precedent in `guide/guideMemberView.ts`: a design surface supplies the shape
 * a component reads, not a live backend's full types.
 */
export function workbenchProps(panels: string[][] = [["impl"], ["luna"]]) {
  return {
    parties: GALLERY_PARTIES as never,
    activePartyId: SCREEN_PARTY_ID,
    partyLayout: {
      partyId: SCREEN_PARTY_ID,
      layout: {
        panels: panels.map((tabs, index) => ({
          id: `panel-${index + 1}`,
          tabs,
          active: tabs[0],
          weight: 1,
        })),
        focusedPanelId: "panel-1",
      },
    } as never,
    onPersistLayout: noop,
    views: SCREEN_VIEWS,
    routes: [GALLERY_ROUTE] as never,
    defaultProfile: GALLERY_MEMBER_PROFILE as never,
    harnessDefaults: {} as never,
    gateDefaults: {} as never,
    debugEnabled: false,
    drawers: DEFAULT_SIDEBAR_DRAWERS,
    actions: studioActions,
    onCreateParty: asyncTrue,
    onCreateGroup: noop,
    onMovePartyToGroup: noop,
    onRenameGroup: noop,
    onRemoveGroup: noop,
    onReorderGroups: noop,
    onBrowseCwd: async () => null,
    groups: GALLERY_GROUPS as never,
    registeredParties: GALLERY_PARTIES as never,
    cwdPrefs: GALLERY_CWD_PREFERENCES as never,
    appWorkspaceRoot: GALLERY_APP_WORKSPACE_ROOT,
    now: GALLERY_NOW,
    onCreateMember: asyncTrue,
    onRemoveMember: noop,
    onSetMemberKeepAwake: noop,
    onSleepMember: noop,
    onWakeMember: noop,
    onRemoveParty: noop,
    onOpenPartyInNewWindow: noop,
    onSelectParty: noop,
    onMemberOpened: noop,
    onVisibleMembersChange: noop,
    onToggleDrawer: noop,
    onOpenUsage: noop,
  };
}
