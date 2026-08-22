/**
 * The registry: one entry per component, rendering the SHIPPING component.
 *
 * `note` is the design-system documentation — when to reach for this, and what
 * the variants mean. `width` is the width the component really gets in the app
 * at that surface, not a number chosen to make the picture look right.
 *
 * Variants come from PROPS (density, value, state), never from staging a scene
 * and lifting DOM out of it. That is the whole difference between this and the
 * capture bundle it replaces.
 */
import { useState } from "react";
import { Transcript } from "../workbench/Transcript";
import { Composer } from "../workbench/Composer";
import { Dropdown } from "../workbench/Dropdown";
import { Segmented } from "../workbench/Segmented";
import type { PanelDensity } from "../workbench/types";
import { Workbench } from "../workbench/Workbench";
import { TabStrip } from "../workbench/TabStrip";
import { MessageQueue } from "../workbench/MessageQueue";
import { SubagentDock } from "../workbench/SubagentDock";
import { SubagentDetail } from "../workbench/SubagentDetail";
import { ContextDonut } from "../workbench/ContextDonut";
import { HarnessIcon } from "../workbench/HarnessIcon";
import { buildSubDock, buildSubDetail } from "../workbench/subagentModel";
import { PANEL, QUEUE, SUBAGENTS } from "./workbenchFixtures";
import { CHANNEL_IN, CHANNEL_OUT, SESSION_SPAWN, USER_INPUT } from "./blockFixtures";
import { CONVERSATION, studioActions, studioCommandUi, view } from "./fixtures";
import { AppShellMockup } from "./AppShellMockup";
import {
  approvalEvent,
  COMPACT_DONE,
  COMPACT_RUNNING,
  ENVIRONMENT_EVENT,
  ERROR_EVENT,
  FILE_CHANGE_EVENT,
  GATE_EVENT,
  QUESTION_EVENT,
  REASONING_EVENT,
} from "./blockFixtures";

export interface Story {
  id: string;
  group: string;
  title: string;
  note?: string;
  /** The width this component gets at its real surface. */
  width?: number;
  /**
   * The height this surface gets in the panel. Only for components the app
   * sizes from their parent (the drill-in fills the conversation area); a
   * component that decides its own height must NOT be given one here.
   */
  height?: number;
  /** Offered as buttons; the chosen one is passed to `render`. */
  densities?: PanelDensity[];
  /**
   * States the component takes as a PROP (collapsed/expanded, empty/loading).
   * Design lives in these as much as in the default view, so they get a switch
   * rather than a second story. States the component owns itself — a tool box
   * opening, a reasoning block unfolding — are not listed: click them.
   */
  variants?: string[];
  render: (density?: PanelDensity, variant?: string) => JSX.Element;
}

/** The panel width a two-panel workbench gives each side on a 1440px window. */
const PANEL_WIDTH = 676;

const conversation = view("impl", { member: { role: "구현 담당" }, events: CONVERSATION });
const reviewer = view("luna", { member: { role: "리뷰 담당", runtime: "codex", model: "gpt-5.4-mini" }, events: CONVERSATION });
const queued = view("impl", { member: { role: "구현 담당", queue: QUEUE } as never, events: CONVERSATION });
const VIEW_MAP = new Map([["impl", conversation], ["luna", reviewer]]);

/** A block story: one event, the real reducer, the real transcript. */
function block(events: unknown[], density: PanelDensity = "wide") {
  return (
    <Transcript
      view={view("impl", { events })}
      density={density}
      actions={studioActions}
      detail="full"
    />
  );
}

function DropdownStage() {
  const [value, setValue] = useState("default");
  return (
    <Dropdown
      value={value}
      onChange={setValue}
      title="권한"
      options={[
        { value: "default", label: "Default", hint: "민감한 작업마다 확인" },
        { value: "acceptEdits", label: "Accept edits", hint: "파일 편집 자동 승인" },
        { value: "plan", label: "Plan", hint: "실행 전 계획만" },
        { value: "auto", label: "Auto", hint: "대부분 자동 진행" },
      ] as never}
    />
  );
}

function SegmentedStage() {
  const [value, setValue] = useState("medium");
  return (
    <Segmented
      value={value}
      onChange={setValue}
      options={[
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
        { value: "max", label: "Max" },
      ] as never}
    />
  );
}

export const STORIES: Story[] = [
  // ------------------------------------------------------------- Primitives
  {
    id: "dropdown",
    group: "Primitives",
    title: "Dropdown",
    note: "권한·모델처럼 값이 정해진 목록에서 하나를 고른다. 항목은 라벨 아래 한 줄 설명을 달 수 있고, 열림 위치는 공간에 따라 위/아래로 뒤집힌다. 클릭해 실제로 열어볼 수 있다 — 상태가 컴포넌트 안에 있기 때문이다.",
    width: 260,
    render: () => <DropdownStage />,
  },
  {
    id: "segmented",
    group: "Primitives",
    title: "Segmented",
    note: "서로 배타적인 서너 개 중 하나. 값이 다섯을 넘으면 Dropdown 을 쓴다 — 가로가 감당하지 못한다.",
    width: 320,
    render: () => <SegmentedStage />,
  },

  // ----------------------------------------------------------------- Blocks
  {
    id: "block-approval-codex",
    group: "Blocks",
    title: "승인 · Codex 명령",
    note: "요청 사유·실행할 명령·작업 폴더·규칙을 그대로 보이고 결정 4종을 준다. 버튼 순서는 거부 → 이번만 → 항상으로, 되돌리기 쉬운 쪽이 왼쪽이다. 카드 내용은 녹화된 하네스 페이로드를 앱의 매퍼가 변환한 것 — 지어낸 요청이 아니다.",
    width: PANEL_WIDTH,
    densities: ["wide", "narrow"],
    render: (density) => block([approvalEvent("codex-command-once")], density),
  },
  {
    id: "block-approval-claude",
    group: "Blocks",
    title: "승인 · Claude 파일 편집",
    note: "같은 카드가 하네스에 따라 다른 것을 싣는다. Claude 는 규칙 제안과 막힌 경로를 함께 보낸다.",
    width: PANEL_WIDTH,
    densities: ["wide", "narrow"],
    render: (density) => block([approvalEvent("claude-file-edit")], density),
  },
  {
    id: "block-question",
    group: "Blocks",
    title: "질문 · 단일 선택",
    note: "AskUserQuestion 은 승인과 같은 자리에 오지만 결정이 아니라 선택이다. 선택지에는 한 줄 설명이 붙고, 건너뛰기가 항상 있다.",
    width: PANEL_WIDTH,
    render: () => block([QUESTION_EVENT]),
  },
  {
    id: "block-compact",
    group: "Blocks",
    title: "압축 · 진행 중 / 완료",
    note: "압축은 대화를 줄이는 파괴적 동작이라 조용히 지나가지 않는다. 완료 카드는 전/후 토큰과 유지한 건수를 남긴다 — 수치가 오지 않으면 지어내지 않고 생략한다.",
    width: PANEL_WIDTH,
    render: () => (
      <>
        {block(COMPACT_RUNNING)}
        {block(COMPACT_DONE)}
      </>
    ),
  },
  {
    id: "block-environment",
    group: "Blocks",
    title: "진단 · 환경",
    note: "하네스가 낸 진단을 조용히 버리지 않는다. 심각도·범주·제목·실제 상세를 싣고, 같은 진단이 연속되면 ×N 으로 합친다.",
    width: PANEL_WIDTH,
    render: () => block(ENVIRONMENT_EVENT),
  },
  {
    id: "block-gate",
    group: "Blocks",
    title: "Message Gate 결과",
    note: "발신 메시지가 Gate 를 거친 결과. 반려는 전달 안 됨, 강제 전송은 우회 전달, 리뷰 실패는 fail-open 전달을 뜻한다.",
    width: PANEL_WIDTH,
    render: () => block(GATE_EVENT),
  },
  {
    id: "block-filechange",
    group: "Blocks",
    title: "파일 변경",
    note: "파일 단위로 묶고, 헤더의 파일 수와 +/− 합계는 이벤트가 준 값만 쓴다. diff 가 없는 변경에 빈 diff 자리를 만들지 않는다.",
    width: PANEL_WIDTH,
    render: () => block(FILE_CHANGE_EVENT),
  },
  {
    id: "block-reasoning",
    group: "Blocks",
    title: "추론",
    note: "모델의 추론 원문은 대답과 분리된 접힌 블록이다. 펼치면 원문 그대로 읽되 요약을 지어내지 않는다.",
    width: PANEL_WIDTH,
    render: () => block(REASONING_EVENT),
  },
  {
    id: "block-error",
    group: "Blocks",
    title: "오류",
    note: "오류는 status 가 아니다. 실패는 자기 블록으로 남고 어느 모드에서도 숨지 않는다.",
    width: PANEL_WIDTH,
    render: () => block(ERROR_EVENT),
  },

  {
    id: "harness-icon",
    group: "Primitives",
    title: "Harness icon",
    note: "멤버가 어느 하네스로 도는지. 탭·툴바·마법사 어디서든 같은 마크를 쓴다 — 하네스는 멤버의 정체성이라 자리마다 다른 그림을 쓰면 같은 것을 다른 것으로 읽는다.",
    width: 200,
    render: () => (
      <div style={{ display: "flex", gap: 16, alignItems: "center", padding: 12 }}>
        <HarnessIcon harness={"claude-code" as never} size={20} />
        <HarnessIcon harness={"codex" as never} size={20} />
        <HarnessIcon harness={"cursor" as never} size={20} />
        <HarnessIcon harness={"grok" as never} size={20} />
      </div>
    ),
  },
  {
    id: "context-donut",
    group: "Primitives",
    title: "Context donut",
    note: "컨텍스트 창 점유율. 자동 압축 임계값이 있으면 그 지점을 링에 표시한다 — 숫자만으로는 \"곧 압축된다\"가 안 읽힌다. 창 크기를 모르면 비율 없이 원시 수치만 보인다.",
    width: 260,
    render: () => (
      <div style={{ display: "flex", gap: 20, alignItems: "center", padding: 12 }}>
        <ContextDonut context={{ used: 118_400, total: 200_000 }} autoCompact={{ mode: "auto", threshold: 0.85 } as never} color="var(--accent)" showRange onClick={() => {}} />
        <ContextDonut context={{ used: 186_000, total: 200_000 }} autoCompact={{ mode: "auto", threshold: 0.85 } as never} color="var(--danger)" showRange onClick={() => {}} />
      </div>
    ),
  },

  // ------------------------------------------------------------ Blocks (더)
  {
    id: "block-channel",
    group: "Blocks",
    title: "채널 · 멤버 간 메시지",
    note: "멤버 사이 메시지는 사용자 말풍선이 아니라 방향이 있는 채널 카드다. from/to·수신/송신·출처를 envelope 그대로 남긴다 — 누가 시켰는지가 기록에서 사라지면 파티가 한 일을 되짚을 수 없다.",
    width: PANEL_WIDTH,
    render: () => block([CHANNEL_IN, CHANNEL_OUT]),
  },
  {
    id: "block-session-spawn",
    group: "Blocks",
    title: "세션 시작",
    note: "하네스 프로세스가 떴다는 사실. 모델·권한·cwd 처럼 이 턴 내내 유효한 조건을 한 줄로 못박아, 뒤의 대화를 어떤 설정에서 읽어야 하는지 알려준다.",
    width: PANEL_WIDTH,
    render: () => block([SESSION_SPAWN]),
  },
  {
    id: "block-user",
    group: "Blocks",
    title: "사용자 메시지",
    note: "사람이 보낸 것. 대기열을 거쳐 온 경우 몇 건이 합쳐졌는지 남긴다 — 합쳐진 사실이 사라지면 모델이 왜 한 번에 여러 요청을 받았는지 설명되지 않는다.",
    width: PANEL_WIDTH,
    render: () => block([USER_INPUT]),
  },

  // ------------------------------------------------------------- Composites
  {
    id: "transcript",
    group: "Composites",
    title: "Transcript",
    note: "대화 본문. 밀도를 바꿔 보라 — 좁은 폭은 기능을 빼는 것이 아니라 같은 블록을 다시 흐르게 한다. 사용자 메시지·assistant 본문·도구 상자·계획 블록이 전부 같은 리듀서가 만든 실제 블록이다.",
    width: PANEL_WIDTH,
    densities: ["wide", "mid", "narrow"],
    render: (density = "wide") => (
      <Transcript view={conversation} density={density} actions={studioActions} detail="full" />
    ),
  },
  {
    id: "composer",
    group: "Composites",
    title: "Composer",
    note: "멤버별 입력창. wide/mid 는 두 줄 텍스트에어리어 + 도구 행, narrow 는 한 줄로 접히되 전송 컨트롤은 절대 사라지지 않는다. 멤버가 작업 중이면 전송이 '대기열에 추가'로 바뀐다.",
    width: PANEL_WIDTH,
    densities: ["wide", "mid", "narrow"],
    render: (density = "wide") => (
      <Composer
        view={conversation}
        density={density}
        actions={studioActions}
        commandUi={studioCommandUi}
      />
    ),
  },

  {
    id: "tabstrip",
    group: "Composites",
    title: "TabStrip",
    note: "한 패널의 탭들. 멤버 색 점·하네스 칩·상태 배지를 달고, 폭이 모자라면 +N 으로 접되 접힌 탭의 승인/안읽음은 멤버색 점으로 계속 알린다. 드래그하면 착지 위치에 삽입선이 그려진다.",
    width: PANEL_WIDTH,
    render: () => (
      <TabStrip
        panel={PANEL}
        views={VIEW_MAP}
        density="wide"
        width={PANEL_WIDTH}
        draggingMember={null}
        dropAt={null}
        onSelect={() => {}}
        onClose={() => {}}
        onPromote={() => {}}
        onTabPointerDown={() => {}}
      />
    ),
  },
  {
    id: "message-queue",
    group: "Composites",
    title: "Message queue",
    note: "앱의 유일한 큐. 합치기 토글은 같은 발신자 묶음의 전달 방식을 바꾸고, 행마다 펼치기·지금 보내기·편집·취소가 붙는다. 모두 취소는 두 번 묻는다 — 되돌릴 수 없는데 접기 버튼 옆에 있기 때문이다.",
    width: PANEL_WIDTH,
    densities: ["wide", "narrow"],
    render: (density = "wide") => (
      <MessageQueue view={queued} density={density} actions={studioActions} onEditBack={() => {}} />
    ),
  },
  {
    id: "subagent-dock",
    group: "Composites",
    title: "Subagent dock",
    variants: ["펼침", "접힘"],
    note: "툴바와 대화 사이에 고정되어 대화와 함께 스크롤되지 않는다. 헤더는 개수·상태 점·요약을 항상 보이고, 펼치면 한 줄씩 나온다. 뷰모델은 앱의 buildSubDock 이 만든다 — 요약 문장과 점 배치가 로직이라 픽스처로 베끼면 어긋난다.",
    width: PANEL_WIDTH,
    render: (_density, variant) => (
      <SubagentDock
        view={buildSubDock(SUBAGENTS, "#54b585", "wide", undefined, variant === "접힘")}
        onToggle={() => {}}
        onOpen={() => {}}
      />
    ),
  },
  {
    id: "subagent-detail",
    group: "Composites",
    title: "Subagent drill-in",
    height: 560,
    note: "독의 행을 누르면 부모 대화 대신 그 서브에이전트의 분리된 슬라이스로 들어간다. 상단 breadcrumb 와 뒤로가기가 부모를 보존한다.",
    width: PANEL_WIDTH,
    render: () => (
      <SubagentDetail
        detail={buildSubDetail(SUBAGENTS[2], "#54b585") as never}
        parentName="impl"
        parentColor="#54b585"
        density="wide"
        onBack={() => {}}
      />
    ),
  },

  // ---------------------------------------------------------------- Screens
  {
    id: "screen-app",
    group: "Screens",
    title: "앱 창 — 2패널",
    note: "앱 창 전체. 타이틀바(업데이트 필·테마 메뉴·창 버튼), 좌측 네비레일, 스크린 헤더(현재 파티·사용량 필), 그리고 워크벤치. 전부 App.tsx 가 마운트하는 그 컴포넌트라 목업이 앱과 갈라질 지점이 없다. 레일과 테마 메뉴는 실제로 눌린다.",
    render: () => <div className="st-screen"><AppShellMockup /></div>,
  },
  {
    id: "screen-app-single",
    group: "Screens",
    title: "앱 창 — 단일 패널",
    note: "패널이 하나일 때. 같은 컴포넌트가 폭을 다 받으면 밀도가 올라가고 툴바가 펼쳐진다.",
    render: () => <div className="st-screen"><AppShellMockup panels={[["impl", "luna"]]} /></div>,
  },
];
