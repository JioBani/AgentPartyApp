/**
 * PROPOSAL — 버전을 설정 탭에서 꺼내 사이드바의 한 화면으로 만든다.
 *
 * 기능은 지금 설정 → 버전 탭의 것을 하나도 빼지 않는다: 설치된 버전, 업데이트
 * 확인, 업데이트 창 열기, 안정/베타 채널, 최신 릴리스 노트와 릴리스 페이지,
 * 이전 버전 목록과 노트, 목록 오류와 다시 시도.
 *
 * 달라지는 것은 둘이다.
 *   1. 사이드바에 `버전` 이 생기고, 업데이트가 있으면 아이콘에 작은 점이 붙는다.
 *   2. 노트를 320px 상자에 가두지 않는다. 최신 릴리스는 제목 한 문장과 본문을
 *      카드 폭 그대로 펼쳐 이미지까지 끝까지 읽히고, 이전 버전도 펼치면 같은
 *      모양으로 읽힌다.
 *
 * 모양은 설정 화면의 디자인 시스템 그대로다 — `screen-header`, `set-page`,
 * `set-section`, `set-card`, `set-row`, `set-btn-*`, `set-ver-*`, 채널 카드(`set-update-channel-*`).
 * 최신 릴리스만 카드 밖에서 읽는 글로 펼친다(제목 한 문장 · 넓은 줄간격 · 큰 이미지).
 * 새 CSS 는 `proposedVersions.css` 의 몇 줄뿐이다.
 */
import { useState } from "react";
import { AlertTriangle, ArrowDownToLine, ArrowRight, ChevronDown, FlaskConical, RefreshCw, RotateCw, ShieldCheck } from "lucide-react";
import { NAV_ICONS, NavRail, TitleBar, type NavBadge } from "../app/AppChrome";
import { UpdatePill } from "../workbench/UpdatePill";
import { Markdown } from "../workbench/Markdown";
import { useTheme } from "../theme/ThemeProvider";
import { THEME_METADATA } from "../../shared/appTheme";
import { UPDATE_FEED, type ReleaseSummary } from "../../shared/appUpdate";
import { RELEASES } from "./versionsFixtures";

export type VersionsState = "available" | "downloaded" | "current" | "error";

const INSTALLED: Record<VersionsState, string> = { available: "0.14.0", downloaded: "0.14.0", current: "0.15.0", error: "0.14.0" };

const NAV_LABELS: Record<string, string> = {
  workbench: "워크벤치",
  guide: "가이드",
  usage: "사용량",
  auth: "인증",
  agent: "에이전트",
  versions: "버전",
  settings: "설정",
};

/** The rail as the app would build it; the versions item carries a dot while an update waits. */
export function railItems(listState: VersionsState, latest: string) {
  const state = listState === "error" ? "available" : listState;
  const waiting = state === "available" || state === "downloaded";
  const badge: NavBadge | undefined = waiting ? (state === "downloaded" ? "ready" : "available") : undefined;
  return Object.keys(NAV_ICONS).map((id) => ({
    id,
    label: NAV_LABELS[id] ?? id,
    icon: NAV_ICONS[id],
    ...(id === "versions" ? { badge, hint: waiting ? `v${latest} 업데이트` : undefined } : {}),
  }));
}

function withoutGenericOpening(notes: string): string {
  return notes.trimStart().replace(/^##\s+(주요 변경|변경 사항|AgentParty[^\n]*)\s*\n+/, "");
}

/** The `###` the notes open with, if they open with one — it becomes the release's headline. */
function leadingHeading(release: ReleaseSummary): RegExpMatchArray | null {
  return withoutGenericOpening(release.notes).match(/^###\s+(.+)\s*\n*/);
}

/** The release title, unless it just repeats the tag — same rule as the settings tab. */
function releaseTitle(release: ReleaseSummary): string {
  const name = release.name.trim();
  return name === release.version || name === `v${release.version}` ? "" : name;
}

function headline(release: ReleaseSummary): string {
  return leadingHeading(release)?.[1].trim() || releaseTitle(release);
}

/** The notes under the headline, without the headline and a generic opening heading repeated. */
function body(release: ReleaseSummary): string {
  const notes = withoutGenericOpening(release.notes);
  const lead = leadingHeading(release);
  return lead ? notes.slice(lead[0].length) : notes;
}

function date(iso: string) {
  return new Date(iso).toLocaleDateString();
}

function ReleaseNotes({ release }: { release: ReleaseSummary }) {
  const title = headline(release);
  const text = body(release);
  return (
    <div className="ver-notes">
      {title && <h2 className="ver-notes-title">{title}</h2>}
      {text ? <Markdown text={text} /> : <span className="set-ver-empty">노트 없이 게시된 버전입니다.</span>}
    </div>
  );
}

function UpdateCard({ state, installed, latest }: { state: VersionsState; installed: string; latest: ReleaseSummary }) {
  const [channel, setChannel] = useState<"stable" | "beta">("stable");
  const waiting = state === "available" || state === "downloaded";
  const ready = state === "downloaded";
  return (
    <section className="set-section">
      <div className="set-section-head"><span className="set-section-label">업데이트</span><span className="set-section-rule" /></div>
      <div className="set-card">
        <div className="set-row set-row-flush">
          <span className={`set-row-icon${waiting ? " is-accent" : ""}`}>{ready ? <RotateCw size={18} /> : <ArrowDownToLine size={18} />}</span>
          <div className="set-row-body">
            <span className="set-row-name">
              {ready ? `다시 시작하면 v${latest.version} 이 설치됩니다` : waiting ? `v${latest.version} 을 설치할 수 있습니다` : "최신 버전을 사용 중입니다"}
            </span>
            <span className="ver-installed">
              <span className="wb-mono set-ver-badge">v{installed}</span>
              {waiting && <><ArrowRight size={12} /><span className="wb-mono set-ver-badge is-latest">v{latest.version}</span></>}
              <span className="set-card-sub wb-mono">{UPDATE_FEED.owner}/{UPDATE_FEED.repo}</span>
            </span>
          </div>
          {waiting && (
            <button type="button" className="set-btn-accent">
              {ready ? <><RotateCw size={14} /> 다시 시작</> : <><ArrowDownToLine size={14} /> 설치</>}
            </button>
          )}
        </div>
        {/* The settings tab's own channel cards — wide enough to say what each channel means. */}
        <div className="set-card-label ver-row-rule">업데이트 채널<span className="set-card-sub">이 PC에 저장됩니다</span></div>
        <div className="set-update-channel-options ver-channel" role="radiogroup" aria-label="업데이트 채널">
          <button type="button" role="radio" aria-checked={channel === "stable"} className={`set-update-channel-option${channel === "stable" ? " is-active" : ""}`} onClick={() => setChannel("stable")}>
            <span><ShieldCheck size={13} /> 안정 채널</span>
            <small>검증을 마친 정식 릴리스만 받습니다.</small>
          </button>
          <button type="button" role="radio" aria-checked={channel === "beta"} className={`set-update-channel-option${channel === "beta" ? " is-active" : ""}`} onClick={() => setChannel("beta")}>
            <span><FlaskConical size={13} /> 베타 채널</span>
            <small>시험 기능이 포함된 prerelease와 이후 정식 릴리스를 받습니다.</small>
          </button>
        </div>
        <div className="set-diag-actions">
          <button type="button" className="set-btn-soft"><RefreshCw size={14} /> 업데이트 확인</button>
          <button type="button" className="set-btn-soft">업데이트 창 열기</button>
        </div>
      </div>
    </section>
  );
}

/** The screen body: header + scrolling page, the way App.tsx frames every secondary view. */
export function VersionsScreen({ state }: { state: VersionsState }) {
  const installed = INSTALLED[state];
  const latest = RELEASES[0];
  const history = RELEASES.slice(1);
  const [showHistory, setShowHistory] = useState(true);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (version: string) => setOpen((cur) => {
    const next = new Set(cur);
    if (next.has(version)) next.delete(version); else next.add(version);
    return next;
  });

  return (
    <main className="program-main">
      <header className="screen-header">
        <div className="screen-title">
          <h1>버전</h1>
          <p>설치된 버전과 모든 배포 버전의 변경 내역</p>
        </div>
      </header>
      <div className="program-scroll">
        <div className="set-page ver-page">
          {/* The list failing says nothing about the update itself — the card keeps its own state. */}
          <UpdateCard state={state === "error" ? "available" : state} installed={installed} latest={latest} />

          {state === "error" && (
            <div className="set-inline-note is-error ver-error">
              <AlertTriangle size={14} />
              <span>릴리스 목록을 불러오지 못했습니다. (GitHub API 403)</span>
              <button type="button" className="set-link-btn"><RefreshCw size={12} /> 다시 시도</button>
            </div>
          )}

          <section className="set-section">
            <div className="set-section-head"><span className="set-section-label">최신 버전</span><span className="set-section-rule" /></div>
            {/* Read, not operated: meta line, one headline, prose and full-width images — no box. */}
            <article className="ver-release">
              <div className="ver-release-meta">
                <span className="wb-mono set-ver-badge is-latest">v{latest.version}</span>
                {latest.version !== installed && <span className="set-ver-tag is-new">새 버전</span>}
                {latest.version === installed && <span className="set-ver-tag is-ok">설치됨</span>}
                {latest.prerelease && <span className="set-ver-tag">베타</span>}
                <span className="ver-release-date">{date(latest.publishedAt)}</span>
                <button type="button" className="set-link-btn ver-release-link"><ArrowRight size={12} /> 릴리스 페이지</button>
              </div>
              <ReleaseNotes release={latest} />
            </article>
          </section>

          <section className="set-section">
            <div className="set-section-head"><span className="set-section-label">이전 버전</span><span className="set-section-rule" /></div>
            <div className="set-card">
              <button type="button" className="set-ver-toggle" onClick={() => setShowHistory((v) => !v)}>
                <ChevronDown size={14} className={showHistory ? "set-ver-chev is-open" : "set-ver-chev"} />
                <span>이전 버전 보기</span>
                <span className="set-card-sub wb-mono">{history.length}개</span>
              </button>
              {showHistory && (
                <ul className="set-ver-list">
                  {history.map((release) => (
                    <li key={release.version} className="set-ver-item">
                      <button type="button" className="set-ver-item-head" onClick={() => toggle(release.version)}>
                        <ChevronDown size={13} className={open.has(release.version) ? "set-ver-chev is-open" : "set-ver-chev"} />
                        <span className="wb-mono set-ver-badge">v{release.version}</span>
                        <span className="set-ver-name ver-item-title">{headline(release) || firstLine(release)}</span>
                        {release.prerelease && <span className="set-ver-tag">베타</span>}
                        {release.version === installed && <span className="set-ver-tag is-ok">설치됨</span>}
                        <span className="set-ver-date wb-mono">{date(release.publishedAt)}</span>
                      </button>
                      {open.has(release.version) && (
                        <div className="ver-item-body">
                          <ReleaseNotes release={release} />
                          <button type="button" className="set-link-btn"><ArrowRight size={12} /> 릴리스 페이지</button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

/** A list row's summary when the release has no title: its first line of prose. */
function firstLine(release: ReleaseSummary): string {
  const line = withoutGenericOpening(release.notes).split("\n").map((l) => l.replace(/^[-#*\s]+/, "").replace(/\*\*/g, "").trim()).find(Boolean);
  return line || "";
}

/** The whole window: the app's own title bar and rail around the proposed screen. */
export function VersionsWindow({ state }: { state: VersionsState }) {
  const theme = useTheme();
  const latest = RELEASES[0].version;
  const waiting = state !== "current";
  const status = waiting ? { state: state === "error" ? "available" : state, currentVersion: INSTALLED[state], latestVersion: latest, channel: "stable" } : undefined;
  return (
    <div className="app-shell st-window">
      <TitleBar
        subtitle="버전"
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
