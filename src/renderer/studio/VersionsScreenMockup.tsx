/**
 * PROPOSAL — 버전을 설정 탭에서 꺼내 사이드바의 한 화면으로 만든다.
 *
 * 기능은 지금 설정 → 버전 탭의 것을 하나도 빼지 않는다: 설치된 버전, 업데이트
 * 확인, 업데이트 창 열기, 안정/베타 채널, 최신 릴리스 노트와 릴리스 페이지,
 * 이전 버전 목록과 노트, 목록 오류와 다시 시도.
 *
 * 달라지는 것은 둘이다.
 *   1. 사이드바에 `버전` 이 생기고, 업데이트가 있으면 아이콘에 작은 점이 붙는다.
 *   2. 노트를 320px 상자에 가두지 않는다. 릴리스 하나를 제목 한 문장과 본문으로
 *      페이지 폭 그대로 펼치고, 이전 버전은 아래로 쌓지 않고 옆으로 넘겨 같은
 *      모양으로 읽는다(‹ 버전 선택 › 와 글 끝의 이전/다음 카드).
 *
 * 모양은 설정 화면의 디자인 시스템 그대로다 — `screen-header`, `set-page`,
 * `set-section`, `set-card`, `set-row`, `set-btn-*`, `set-ver-*`, 채널 카드(`set-update-channel-*`).
 * 최신 릴리스만 카드 밖에서 읽는 글로 펼친다(제목 한 문장 · 넓은 줄간격 · 큰 이미지).
 * 새 CSS 는 `proposedVersions.css` 의 몇 줄뿐이다.
 */
import { useRef, useState } from "react";
import { AlertTriangle, ArrowDownToLine, ArrowRight, ChevronLeft, ChevronRight, FlaskConical, RefreshCw, RotateCw, ShieldCheck } from "lucide-react";
import { NAV_ICONS, NavRail, TitleBar, type NavBadge } from "../app/AppChrome";
import { UpdatePill } from "../workbench/UpdatePill";
import { Markdown } from "../workbench/Markdown";
import { Dropdown } from "../workbench/Dropdown";
import { useTheme } from "../theme/ThemeProvider";
import { THEME_METADATA } from "../../shared/appTheme";
import type { ReleaseSummary } from "../../shared/appUpdate";
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
  const title = headline(release) || `AgentParty ${release.version}`;
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
            </span>
          </div>
          {waiting && (
            <button type="button" className="set-btn-accent">
              {ready ? <><RotateCw size={14} /> 다시 시작</> : <><ArrowDownToLine size={14} /> 설치</>}
            </button>
          )}
        </div>
        {/* The settings tab's own channel cards — wide enough to say what each channel means. */}
        <div className="set-card-label ver-row-rule">업데이트 채널</div>
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
  const [index, setIndex] = useState(0);
  const pageRef = useRef<HTMLElement>(null);
  const release = RELEASES[index];
  const newer = RELEASES[index - 1];
  const older = RELEASES[index + 1];

  /** Turn the page, and bring its top into view — a long note would otherwise open mid-way. */
  function go(next: number) {
    setIndex(next);
    pageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const options = RELEASES.map((r) => ({
    id: r.version,
    label: `v${r.version}`,
    hint: [r === latest ? "최신" : "", r.version === installed ? "설치됨" : "", date(r.publishedAt)].filter(Boolean).join(" · "),
  }));

  return (
    <main className="program-main">
      <header className="screen-header">
        <div className="screen-title">
          <h1>버전</h1>
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

          <section className="set-section" ref={pageRef}>
            <div className="set-section-head">
              <span className="set-section-label">{index === 0 ? "최신 버전" : "이전 버전"}</span>
              <span className="set-section-rule" />
              {/* One joined control, read left → right like a timeline: older ‹ [this version ▾] › newer. */}
              <div className="ver-pager" role="group" aria-label="버전 넘기기">
                <button type="button" className="ver-pager-btn" disabled={!older} onClick={() => go(index + 1)}><ChevronLeft size={14} /> 이전</button>
                <Dropdown value={release.version} options={options} onChange={(v) => go(RELEASES.findIndex((r) => r.version === v))} title="버전으로 이동" align="right" />
                <button type="button" className="ver-pager-btn" disabled={!newer} onClick={() => go(index - 1)}>다음 <ChevronRight size={14} /></button>
              </div>
            </div>
            {/* Read, not operated: meta line, one headline, prose and full-width images — no box. */}
            <article className="ver-release" key={release.version}>
              <div className="ver-release-meta">
                <span className={`wb-mono set-ver-badge${index === 0 ? " is-latest" : ""}`}>v{release.version}</span>
                {release === latest && latest.version !== installed && <span className="set-ver-tag is-new">새 버전</span>}
                {release.version === installed && <span className="set-ver-tag is-ok">설치됨</span>}
                {release.prerelease && <span className="set-ver-tag">베타</span>}
                <span className="ver-release-date">{date(release.publishedAt)}</span>
                <button type="button" className="set-link-btn ver-release-link"><ArrowRight size={12} /> 릴리스 페이지</button>
              </div>
              <ReleaseNotes release={release} />
            </article>
            {/* The end of a note is where the reader decides to keep going: offer both neighbours by name. */}
            <nav className="ver-turn" aria-label="버전 넘기기">
              {older ? (
                <button type="button" className="ver-turn-card" onClick={() => go(index + 1)}>
                  <span className="ver-turn-dir"><ChevronLeft size={13} /> 이전 버전 · v{older.version}</span>
                  <span className="ver-turn-title">{headline(older) || firstLine(older)}</span>
                </button>
              ) : <span />}
              {newer ? (
                <button type="button" className="ver-turn-card is-newer" onClick={() => go(index - 1)}>
                  <span className="ver-turn-dir">다음 버전 · v{newer.version} <ChevronRight size={13} /></span>
                  <span className="ver-turn-title">{headline(newer) || firstLine(newer)}</span>
                </button>
              ) : <span />}
            </nav>
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
