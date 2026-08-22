/**
 * The whole app window, assembled the way `App.tsx` assembles it.
 *
 * The workbench alone is not the screen a person sees: the title bar carries
 * the update pill and the window buttons, the rail carries the views, and the
 * screen header names the party and holds the usage pill. Reading a workbench
 * without them means guessing where it sits.
 *
 * Every piece here is the SAME component the app mounts (`app/AppChrome.tsx`,
 * `UpdatePill`, `UsageLimitPill`, `Workbench`). Nothing is redrawn — which is
 * why this cannot drift from the app the way a hand-built mockup would.
 */
import { useState } from "react";
import { NAV_ICONS, NavRail, TitleBar, WorkbenchScreenHeader } from "../app/AppChrome";
import { UpdatePill } from "../workbench/UpdatePill";
import { UsageLimitPill } from "../workbench/UsageLimitPill";
import { Workbench } from "../workbench/Workbench";
import { useTheme } from "../theme/ThemeProvider";
import { THEME_METADATA } from "../../shared/appTheme";
import { workbenchProps } from "./screenFixtures";

const NAV_LABELS: Record<string, string> = {
  workbench: "워크벤치",
  guide: "가이드",
  usage: "사용량",
  auth: "인증",
  agent: "에이전트",
  settings: "설정",
};

const NAV_ITEMS = Object.keys(NAV_ICONS).map((id) => ({ id, label: NAV_LABELS[id] ?? id, icon: NAV_ICONS[id] }));

/** A pending update, so the pill has something to say (it hides when there is none). */
const UPDATE_STATUS = { state: "available", version: "0.5.1" };

/** Four providers at four very different levels — the pill's whole range at once. */
const USAGE = {
  providers: {
    anthropic: { fiveHour: { utilization: 0.18 }, weekly: { utilization: 0.31 } },
    openai: { fiveHour: { utilization: 0.8 }, weekly: { utilization: 0.62 } },
    cursor: { fiveHour: { utilization: 0.9 }, weekly: { utilization: 0.71 } },
    xai: { fiveHour: { utilization: 1 }, weekly: { utilization: 0.95 } },
  },
};

export function AppShellMockup({ panels }: { panels?: string[][] }) {
  const theme = useTheme();
  const [view, setView] = useState("workbench");

  return (
    <div className="app-shell st-window" data-workspace="C:/Project/AgentPartyApp">
      <TitleBar
        subtitle={view !== "workbench" ? NAV_LABELS[view] : undefined}
        themes={THEME_METADATA as never}
        preference={theme.preference}
        onPickTheme={(id) => theme.setTheme(id)}
        pills={
          <span className="no-drag">
            <UpdatePill status={UPDATE_STATUS as never} onOpen={() => {}} />
          </span>
        }
        onMinimize={() => {}}
        onMaximize={() => {}}
        onClose={() => {}}
        labels={{ appearanceTitle: "모양", themeLabel: "테마", minimize: "최소화", maximize: "최대화", close: "닫기" }}
      />
      <div className="app-body">
        <NavRail
          items={NAV_ITEMS}
          current={view}
          onSelect={setView}
          avatar="JD"
          labels={{ navigation: "내비게이션", account: "계정" }}
        />
        <main className="program-main">
          <WorkbenchScreenHeader
            party="improve"
            description="멤버를 만들고 여러 세션을 한 화면에서 관리합니다."
            actions={
              <UsageLimitPill
                usage={USAGE as never}
                membersByProvider={{ anthropic: 3, openai: 2, cursor: 1, xai: 1 } as never}
                onOpenSettings={() => {}}
                onRefresh={() => {}}
              />
            }
            labels={{ partyLabel: "현재 파티", none: "선택 없음" }}
          />
          <Workbench {...(workbenchProps(panels) as unknown as React.ComponentProps<typeof Workbench>)} />
        </main>
      </div>
    </div>
  );
}
