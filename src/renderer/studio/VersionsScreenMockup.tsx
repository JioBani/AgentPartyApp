/**
 * 버전 화면 in the studio — the SHIPPING `VersionsPage` with fixture data.
 *
 * The page component takes its releases, status and actions as props, so the
 * studio hands it the real public release list (versionsFixtures) and no-op
 * actions. Nothing here redraws the screen; the chrome is `TitleBar`/`NavRail`
 * from app/AppChrome, the same as the app.
 */
import { useState } from "react";
import { NAV_ICONS, NavRail, TitleBar, type NavBadge } from "../app/AppChrome";
import { VersionsPage, type VersionsActions } from "../app/VersionsView";
import { UpdatePill } from "../workbench/UpdatePill";
import { useTheme } from "../theme/ThemeProvider";
import { THEME_METADATA } from "../../shared/appTheme";
import type { UpdateStatus } from "../../shared/appUpdate";
import { RELEASES } from "./versionsFixtures";

export type VersionsState = "available" | "downloaded" | "current" | "error";

const LATEST = RELEASES[0].version;

function fixtureStatus(state: VersionsState): UpdateStatus {
  if (state === "current") return { state: "up-to-date", channel: "stable", currentVersion: LATEST };
  return { state: state === "downloaded" ? "downloaded" : "available", channel: "stable", currentVersion: "0.14.0", latestVersion: LATEST };
}

const NAV_LABELS: Record<string, string> = {
  workbench: "워크벤치",
  guide: "가이드",
  usage: "사용량",
  auth: "인증",
  agent: "에이전트",
  versions: "버전",
  settings: "설정",
};

/** The rail as App.tsx builds it: a dot on 버전 while a newer version waits. */
function railItems(status: UpdateStatus) {
  const badge: NavBadge | undefined = status.state === "downloaded" ? "ready" : status.state === "available" ? "available" : undefined;
  return Object.keys(NAV_ICONS).map((id) => ({
    id,
    label: NAV_LABELS[id] ?? id,
    icon: NAV_ICONS[id],
    ...(id === "versions" && badge ? { badge, hint: `v${LATEST} 업데이트` } : {}),
  }));
}

export function VersionsWindow({ state }: { state: VersionsState }) {
  const theme = useTheme();
  const [status, setStatus] = useState(() => fixtureStatus(state));
  const actions: VersionsActions = {
    check: async () => status,
    download: async () => status,
    install: async () => undefined,
    setChannel: async (channel) => ({ ...status, channel }),
    openDialog: () => {},
    openRelease: () => {},
    reloadReleases: () => {},
  };
  return (
    <div className="app-shell st-window">
      <TitleBar
        subtitle="버전"
        themes={THEME_METADATA as never}
        preference={theme.preference}
        onPickTheme={(id) => theme.setTheme(id)}
        pills={<span className="no-drag"><UpdatePill status={status} onOpen={() => {}} /></span>}
        onMinimize={() => {}}
        onMaximize={() => {}}
        onClose={() => {}}
        labels={{ appearanceTitle: "모양", themeLabel: "테마", minimize: "최소화", maximize: "최대화", close: "닫기" }}
      />
      <div className="app-body">
        <NavRail items={railItems(status)} current="versions" onSelect={() => {}} avatar="JD" labels={{ navigation: "내비게이션", account: "계정" }} />
        <main className="program-main">
          <header className="screen-header">
            <div className="screen-title"><h1>버전</h1></div>
          </header>
          <div className="program-scroll">
            <VersionsPage
              status={status}
              onStatus={setStatus}
              releases={RELEASES}
              listError={state === "error" ? "릴리스 목록을 불러오지 못했습니다. (GitHub API 403)" : ""}
              loading={false}
              actions={actions}
            />
          </div>
        </main>
      </div>
    </div>
  );
}

/** The rail with and without a newer version waiting, with the real `NavRail`. */
export function RailBadgeStates() {
  const states: Array<{ state: VersionsState; title: string }> = [
    { state: "current", title: "평소" },
    { state: "available", title: "업데이트 있음" },
  ];
  return (
    <div className="st-rail-states">
      {states.map((s) => (
        <figure key={s.state} className="st-rail-state">
          <div className="st-rail-frame">
            <NavRail items={railItems(fixtureStatus(s.state))} current="workbench" onSelect={() => {}} avatar="JD" labels={{ navigation: "내비게이션", account: "계정" }} />
          </div>
          <figcaption>{s.title}</figcaption>
        </figure>
      ))}
    </div>
  );
}
