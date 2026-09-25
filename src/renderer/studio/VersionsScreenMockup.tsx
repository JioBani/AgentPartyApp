/**
 * PROPOSAL — 버전을 설정 탭에서 꺼내 사이드바의 "새로운 기능" 화면으로 만든다.
 *
 * 조작 패널이 아니라 읽는 페이지다(Linear·Notion·Cursor 체인지로그의 문법):
 *
 *   - 편집 폭 단일 컬럼. 목록·검색·필터·목차 없이 최신부터 흐른다.
 *   - 릴리스마다 한 문장 제목이 주인공이고, 버전·날짜는 작은 메타다.
 *   - 이미지는 컬럼 폭 그대로 크게. 설명은 짧은 산문.
 *   - 업데이트는 맨 위 한 줄 + 버튼 하나. 채널 설정은 설정 화면에 남는다.
 *   - 사이드바 알림은 작은 점 하나. 움직이지 않는다.
 *
 * 크롬(`TitleBar`, `NavRail`, `UpdatePill`)과 노트 렌더러(`Markdown`)는 앱의
 * 컴포넌트 그대로다. 새 CSS 는 `proposedVersions.css` 에만 있다.
 */
import { useState } from "react";
import { NAV_ICONS, NavRail, TitleBar, type NavBadge } from "../app/AppChrome";
import { UpdatePill } from "../workbench/UpdatePill";
import { Markdown } from "../workbench/Markdown";
import { useTheme } from "../theme/ThemeProvider";
import { THEME_METADATA } from "../../shared/appTheme";
import type { ReleaseSummary } from "../../shared/appUpdate";
import { RELEASES } from "./versionsFixtures";

export type VersionsState = "available" | "downloaded" | "current";

const INSTALLED: Record<VersionsState, string> = { available: "0.14.0", downloaded: "0.14.0", current: "0.15.0" };

/** Releases shown before "이전 업데이트 더 보기". */
const FIRST_PAGE = 3;

const NAV_LABELS: Record<string, string> = {
  workbench: "워크벤치",
  guide: "가이드",
  usage: "사용량",
  auth: "인증",
  agent: "에이전트",
  versions: "새로운 기능",
  settings: "설정",
};

/** The rail as the app would build it; the versions item carries a dot while an update waits. */
export function railItems(state: VersionsState, latest: string) {
  const badge: NavBadge | undefined = state === "current" ? undefined : state === "downloaded" ? "ready" : "available";
  const hint = state === "current" ? undefined : `v${latest} 업데이트`;
  return Object.keys(NAV_ICONS).map((id) => ({
    id,
    label: NAV_LABELS[id] ?? id,
    icon: NAV_ICONS[id],
    ...(id === "versions" ? { badge, hint } : {}),
  }));
}

function withoutGenericOpening(notes: string): string {
  return notes.trimStart().replace(/^##\s+(주요 변경|변경 사항|AgentParty[^\n]*)\s*\n+/, "");
}

/** The `###` the notes open with, if they open with one — it becomes the release's headline. */
function leadingHeading(release: ReleaseSummary): RegExpMatchArray | null {
  return withoutGenericOpening(release.notes).match(/^###\s+(.+)\s*\n*/);
}

function headline(release: ReleaseSummary): string {
  const heading = leadingHeading(release)?.[1];
  if (heading) return heading.trim();
  const name = release.name.trim();
  return name && name !== release.version && name !== `v${release.version}` ? name : `AgentParty ${release.version}`;
}

/**
 * The body under the headline. The headline itself and a generic opening
 * heading would repeat what sits right above; an "설치" section explains the
 * installer files, which the update button already makes moot in-app.
 */
function body(release: ReleaseSummary): string {
  const notes = withoutGenericOpening(release.notes);
  const lead = leadingHeading(release);
  return (lead ? notes.slice(lead[0].length) : notes).replace(/\n##\s+설치\s*\n[\s\S]*?(?=\n##\s|$)/, "").trim();
}

function date(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

/** One quiet line at the top: what is waiting, and the one thing to press. */
function UpdateLine({ state, installed, latest }: { state: VersionsState; installed: string; latest: string }) {
  if (state === "current") {
    return (
      <div className="wn-update is-current">
        <span>최신 버전 <b>{installed}</b>을 쓰고 있어요.</span>
        <button type="button" className="wn-text-btn">업데이트 확인</button>
      </div>
    );
  }
  const ready = state === "downloaded";
  return (
    <div className="wn-update">
      <span className="wn-update-dot" />
      <span>
        {ready ? <><b>{latest}</b>이 준비됐어요. 다시 시작하면 적용됩니다.</> : <><b>{latest}</b> 업데이트가 있어요.</>}
        <span className="wn-update-from">지금 {installed}</span>
      </span>
      <button type="button" className="wn-update-btn">{ready ? "다시 시작" : "업데이트"}</button>
    </div>
  );
}

function Entry({ release, installed, latest }: { release: ReleaseSummary; installed: string; latest: string }) {
  const text = body(release);
  return (
    <article className="wn-entry">
      <div className="wn-meta">
        <time>{date(release.publishedAt)}</time>
        <span className="wn-meta-sep" />
        <span>v{release.version}</span>
        {release.version === latest && latest !== installed && <span className="wn-chip is-new">새 버전</span>}
        {release.version === installed && <span className="wn-chip">사용 중</span>}
      </div>
      <h2 className="wn-headline">{headline(release)}</h2>
      {text && <div className="wn-body"><Markdown text={text} /></div>}
    </article>
  );
}

/** The screen body — what `program-main` would hold. */
export function VersionsScreen({ state }: { state: VersionsState }) {
  const installed = INSTALLED[state];
  const latest = RELEASES[0].version;
  const [shown, setShown] = useState(FIRST_PAGE);
  return (
    <main className="program-main wn-main">
      <div className="wn-scroll">
        <div className="wn-column">
          <header className="wn-head">
            <h1>새로운 기능</h1>
            <UpdateLine state={state} installed={installed} latest={latest} />
          </header>
          {RELEASES.slice(0, shown).map((release) => (
            <Entry key={release.version} release={release} installed={installed} latest={latest} />
          ))}
          {shown < RELEASES.length && (
            <button type="button" className="wn-more" onClick={() => setShown((n) => n + FIRST_PAGE)}>이전 업데이트 더 보기</button>
          )}
        </div>
      </div>
    </main>
  );
}

/** The whole window: the app's own title bar and rail around the proposed screen. */
export function VersionsWindow({ state }: { state: VersionsState }) {
  const theme = useTheme();
  const latest = RELEASES[0].version;
  const status = state === "current" ? undefined : { state: state === "downloaded" ? "downloaded" : "available", currentVersion: INSTALLED[state], latestVersion: latest, channel: "stable" };
  return (
    <div className="app-shell st-window">
      <TitleBar
        subtitle="새로운 기능"
        themes={THEME_METADATA as never}
        preference={theme.preference}
        onPickTheme={(id) => theme.setTheme(id)}
        pills={<span className="no-drag"><UpdatePill status={status as never} onOpen={() => {}} /></span>}
        onMinimize={() => {}}
        onMaximize={() => {}}
        onClose={() => {}}
        labels={{ appearanceTitle: "모양", themeLabel: "테마", minimize: "최소화", maximize: "최대화", close: "닫기" }}
      />
      <div className="app-body">
        <NavRail items={railItems(state, latest)} current="versions" onSelect={() => {}} avatar="JD" labels={{ navigation: "내비게이션", account: "계정" }} />
        <VersionsScreen state={state} />
      </div>
    </div>
  );
}

/** The rail with and without an update waiting, with the real `NavRail`. */
export function RailBadgeStates() {
  const latest = RELEASES[0].version;
  const states: Array<{ state: VersionsState; title: string }> = [
    { state: "current", title: "평소" },
    { state: "available", title: "업데이트 있음" },
  ];
  return (
    <div className="ver-rail-states">
      {states.map((s) => (
        <figure key={s.state} className="ver-rail-state">
          <div className="ver-rail-frame">
            <NavRail items={railItems(s.state, latest)} current="workbench" onSelect={() => {}} avatar="JD" labels={{ navigation: "내비게이션", account: "계정" }} />
          </div>
          <figcaption><strong>{s.title}</strong></figcaption>
        </figure>
      ))}
    </div>
  );
}
