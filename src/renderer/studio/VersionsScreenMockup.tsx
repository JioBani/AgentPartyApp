/**
 * PROPOSAL — 버전을 설정 탭에서 꺼내 사이드바의 한 화면으로 만든다.
 *
 * 지금은 설정 → 버전 탭의 760px 카드 안에서 릴리스 노트가 320px 높이 상자에
 * 갇혀 있어, 이미지가 든 노트를 끝까지 읽을 수 없다. 이 제안은
 *
 *   1. 사이드바에 `버전` 을 둔다(설정 바로 위). 새 버전이 있으면 점이 붙는다.
 *   2. 화면은 위에서부터: 업데이트 배너 → 목록 | 읽기 영역.
 *      읽기 영역은 노트를 상자 없이 본문 폭으로 펼치고, 옆에 목차를 둔다.
 *   3. 창이 좁으면(컨테이너 폭 기준) 목록이 버전 선택 버튼으로 접히고 목차가 빠진다.
 *
 * 크롬(`TitleBar`, `NavRail`, `UpdatePill`)과 노트 렌더러(`Markdown`), 채널
 * 선택(`Segmented`)은 앱의 컴포넌트 그대로다. 새 CSS 는 `proposedVersions.css` 에만 있다.
 */
import { useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowRight, ChevronDown, ChevronUp, ExternalLink, RefreshCw, RotateCw, Search } from "lucide-react";
import { NAV_ICONS, NavRail, TitleBar, type NavBadge } from "../app/AppChrome";
import { UpdatePill } from "../workbench/UpdatePill";
import { Markdown } from "../workbench/Markdown";
import { Segmented } from "../workbench/Segmented";
import { useTheme } from "../theme/ThemeProvider";
import { THEME_METADATA } from "../../shared/appTheme";
import type { ReleaseSummary } from "../../shared/appUpdate";
import { RELEASES } from "./versionsFixtures";

export type VersionsState = "available" | "downloaded" | "current";

const INSTALLED: Record<VersionsState, string> = { available: "0.14.0", downloaded: "0.14.0", current: "0.15.0" };

const NAV_LABELS: Record<string, string> = {
  workbench: "워크벤치",
  guide: "가이드",
  usage: "사용량",
  auth: "인증",
  agent: "에이전트",
  versions: "버전",
  settings: "설정",
};

/** The rail as the app would build it, with the versions badge driven by update state. */
export function railItems(state: VersionsState, latest: string) {
  const badge: NavBadge | undefined = state === "available" ? "available" : state === "downloaded" ? "ready" : undefined;
  const hint = state === "available" ? `v${latest} 설치 가능` : state === "downloaded" ? `다시 시작하면 v${latest} 설치` : undefined;
  return Object.keys(NAV_ICONS).map((id) => ({
    id,
    label: NAV_LABELS[id] ?? id,
    icon: NAV_ICONS[id],
    ...(id === "versions" ? { badge, hint } : {}),
  }));
}

/** The line a list row and the reader lead with: the first `###`, else the title, else the notes' first sentence. */
function headline(release: ReleaseSummary): string {
  const heading = release.notes.match(/^###\s+(.+)$/m)?.[1];
  if (heading) return heading.trim();
  const name = release.name.trim();
  if (name && name !== release.version && name !== `v${release.version}`) return name;
  const line = release.notes.split("\n").map((l) => l.replace(/^[-#*\s]+/, "").trim()).find((l) => l && !/^(주요 변경|변경 사항|AgentParty)/.test(l));
  return (line || `v${release.version}`).replace(/\*\*/g, "");
}

/**
 * The notes as the reader shows them under its own title: a generic opening
 * heading ("주요 변경", "AgentParty 0.12.2") and the heading already used as the
 * title would only repeat what sits right above them.
 */
function withoutGenericOpening(notes: string): string {
  return notes.trimStart().replace(/^##\s+(주요 변경|변경 사항|AgentParty[^\n]*)\s*\n+/, "");
}

/** The `###` the notes open with, if they open with one. */
function leadingHeading(release: ReleaseSummary): RegExpMatchArray | null {
  return withoutGenericOpening(release.notes).match(/^###\s+(.+)\s*\n*/);
}

function readerNotes(release: ReleaseSummary): string {
  const notes = withoutGenericOpening(release.notes);
  const lead = leadingHeading(release);
  return lead ? notes.slice(lead[0].length) : notes;
}

/**
 * The reader's title. Unlike a list row it never borrows the first bullet —
 * that bullet is printed right below it, so it would read twice.
 */
function readerTitle(release: ReleaseSummary): string {
  const heading = leadingHeading(release)?.[1];
  if (heading) return heading.trim();
  const name = release.name.trim();
  return name && name !== release.version && name !== `v${release.version}` ? name : "변경 사항";
}

/** Section headings, for the table of contents. */
function sections(notes: string): string[] {
  return Array.from(notes.matchAll(/^#{2,3}\s+(.+)$/gm), (m) => m[1].trim());
}

function shortDate(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}. ${d.getDate()}.`;
}

function longDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

type Filter = "all" | "stable" | "beta";

function UpdateBanner({ state, installed, latest }: { state: VersionsState; installed: string; latest: ReleaseSummary }) {
  if (state === "current") {
    return (
      <section className="ver-banner is-current">
        <span className="ver-banner-icon"><RotateCw size={16} /></span>
        <div className="ver-banner-text">
          <strong>최신 버전을 사용 중입니다</strong>
          <span className="ver-banner-meta"><span className="set-ver-badge">v{installed}</span> 안정 채널 · 방금 확인함</span>
        </div>
        <button type="button" className="set-btn-soft ver-banner-check"><RefreshCw size={14} /> 업데이트 확인</button>
      </section>
    );
  }
  const ready = state === "downloaded";
  return (
    <section className={`ver-banner ${ready ? "is-ready" : "is-available"}`}>
      <span className="ver-banner-icon">{ready ? <RotateCw size={16} /> : <ArrowDownToLine size={16} />}</span>
      <div className="ver-banner-text">
        <strong>{ready ? "다시 시작하면 새 버전이 설치됩니다" : "새 버전을 설치할 수 있습니다"}</strong>
        <span className="ver-banner-meta">
          <span className="set-ver-badge">v{installed}</span>
          <ArrowRight size={13} />
          <span className="set-ver-badge is-latest">v{latest.version}</span>
          <span className="ver-banner-when">안정 채널 · {longDate(latest.publishedAt)} 게시</span>
        </span>
      </div>
      <button type="button" className="set-btn-soft ver-banner-check" aria-label="업데이트 확인"><RefreshCw size={14} /><span>업데이트 확인</span></button>
      <button type="button" className="ver-btn-primary">
        {ready ? <><RotateCw size={14} /> 다시 시작</> : <><ArrowDownToLine size={14} /> v{latest.version} 설치</>}
      </button>
    </section>
  );
}

function ReleaseList({ releases, selected, installed, latest, onPick }: {
  releases: ReleaseSummary[];
  selected: string;
  installed: string;
  latest: string;
  onPick: (version: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const shown = releases.filter((r) =>
    (filter === "all" || (filter === "beta") === r.prerelease)
    && (!query || `v${r.version} ${r.notes}`.toLowerCase().includes(query.toLowerCase())));
  return (
    <aside className="ver-list" aria-label="릴리스 목록">
      <div className="ver-list-tools">
        <label className="ver-search">
          <Search size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="버전·내용 검색" aria-label="릴리스 검색" />
        </label>
        <div className="ver-list-filter">
          <Segmented<Filter>
            value={filter}
            onChange={setFilter}
            options={[{ id: "all", label: "전체" }, { id: "stable", label: "안정" }, { id: "beta", label: "베타" }]}
          />
          <span className="ver-count wb-mono">{shown.length}개</span>
        </div>
      </div>
      <ul className="ver-rows">
        {shown.map((r) => {
          const isNew = r.version === latest && latest !== installed;
          return (
            <li key={r.version}>
              <button
                type="button"
                className={`ver-row${r.version === selected ? " is-selected" : ""}`}
                aria-current={r.version === selected}
                onClick={() => onPick(r.version)}
              >
                <span className="ver-row-top">
                  {isNew && <span className="ver-row-dot" aria-label="새 버전" />}
                  <span className="set-ver-badge wb-mono">v{r.version}</span>
                  {r.version === latest && <span className="set-ver-tag is-new">최신</span>}
                  {r.version === installed && <span className="set-ver-tag is-ok">설치됨</span>}
                  {r.prerelease && <span className="set-ver-tag">베타</span>}
                  <span className="ver-row-date wb-mono">{shortDate(r.publishedAt)}</span>
                </span>
                <span className="ver-row-title">{headline(r)}</span>
              </button>
            </li>
          );
        })}
        {shown.length === 0 && <li className="set-ver-empty">맞는 릴리스가 없습니다.</li>}
      </ul>
    </aside>
  );
}

function Reader({ release, index, total, installed, latest, onStep, picker }: {
  release: ReleaseSummary;
  index: number;
  total: number;
  installed: string;
  latest: string;
  onStep: (delta: number) => void;
  picker: JSX.Element;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const notes = useMemo(() => readerNotes(release), [release]);
  const toc = useMemo(() => [readerTitle(release), ...sections(notes)], [release, notes]);
  const [active, setActive] = useState(0);

  function jump(i: number) {
    setActive(i);
    const headings = bodyRef.current?.querySelectorAll(".wb-md h2, .wb-md h3");
    if (i === 0) bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    else headings?.[i - 1]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <article className="ver-reader">
      <header className="ver-reader-head">
        {picker}
        <span className="ver-reader-when">{longDate(release.publishedAt)} · {release.prerelease ? "베타" : "안정"}</span>
        <span className="ver-reader-tags">
          {release.version === latest && <span className="set-ver-tag is-new">최신</span>}
          {release.version === installed && <span className="set-ver-tag is-ok">설치됨</span>}
        </span>
        <span className="ver-reader-spacer" />
        <button type="button" className="set-link-btn ver-reader-link"><ExternalLink size={12} /> 릴리스 페이지</button>
        <span className="ver-step">
          <button type="button" aria-label="더 새 버전" disabled={index === 0} onClick={() => onStep(-1)}><ChevronUp size={14} /></button>
          <button type="button" aria-label="이전 버전" disabled={index === total - 1} onClick={() => onStep(1)}><ChevronDown size={14} /></button>
        </span>
      </header>
      <div className="ver-reader-scroll" ref={bodyRef}>
        <div className="ver-reader-page">
          <div className="ver-reader-body">
            <div className="ver-reader-kicker">AgentParty {release.version}</div>
            <h1 className="ver-reader-title">{readerTitle(release)}</h1>
            <div className="ver-notes">
              {notes ? <Markdown text={notes} /> : <span className="set-ver-empty">노트 없이 게시된 버전입니다.</span>}
            </div>
          </div>
          {toc.length > 1 && (
            <nav className="ver-toc" aria-label="이 버전의 내용">
              <div className="ver-toc-label">이 버전에서</div>
              {toc.map((title, i) => (
                <button key={title + i} type="button" className={i === active ? "is-active" : ""} onClick={() => jump(i)}>{title}</button>
              ))}
            </nav>
          )}
        </div>
      </div>
    </article>
  );
}

/** The versions screen body — what `program-main` would hold. */
export function VersionsScreen({ state }: { state: VersionsState }) {
  const installed = INSTALLED[state];
  const latest = RELEASES[0];
  const [channel, setChannel] = useState<"stable" | "beta">("stable");
  const [selected, setSelected] = useState(latest.version);
  const [pickerOpen, setPickerOpen] = useState(false);
  const index = Math.max(0, RELEASES.findIndex((r) => r.version === selected));
  const release = RELEASES[index];

  const pick = (version: string) => { setSelected(version); setPickerOpen(false); };

  const picker = (
    <span className="ver-picker">
      <button type="button" className="ver-picker-btn" aria-haspopup="listbox" aria-expanded={pickerOpen} onClick={() => setPickerOpen((v) => !v)}>
        {release.version === latest.version && latest.version !== installed && <span className="ver-row-dot" />}
        <span className="wb-mono">v{release.version}</span>
        <ChevronDown size={13} />
      </button>
      <span className="ver-reader-version set-ver-badge wb-mono">v{release.version}</span>
      {pickerOpen && (
        <div className="ver-picker-pop">
          <ReleaseList releases={RELEASES} selected={selected} installed={installed} latest={latest.version} onPick={pick} />
        </div>
      )}
    </span>
  );

  return (
    <main className="program-main ver-main">
      <header className="screen-header">
        <div className="screen-title">
          <h1>버전</h1>
          <span className="ver-sub">설치된 버전과 모든 릴리스의 변경 내역</span>
        </div>
        <div className="ver-channel">
          <span>업데이트 채널</span>
          <Segmented<"stable" | "beta">
            value={channel}
            onChange={setChannel}
            options={[{ id: "stable", label: "안정" }, { id: "beta", label: "베타" }]}
          />
        </div>
      </header>
      <div className="ver-screen">
        <UpdateBanner state={state} installed={installed} latest={latest} />
        <div className="ver-split">
          <ReleaseList releases={RELEASES} selected={selected} installed={installed} latest={latest.version} onPick={pick} />
          <Reader
            release={release}
            index={index}
            total={RELEASES.length}
            installed={installed}
            latest={latest.version}
            onStep={(d) => pick(RELEASES[Math.min(RELEASES.length - 1, Math.max(0, index + d))].version)}
            picker={picker}
          />
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

/** The rail in each update state, side by side, with the real `NavRail`. */
export function RailBadgeStates() {
  const latest = RELEASES[0].version;
  const states: Array<{ state: VersionsState; title: string; note: string }> = [
    { state: "current", title: "최신 버전 사용 중", note: "표시 없음" },
    { state: "available", title: "새 버전 있음", note: "파란 점 · 처음 3회 파동" },
    { state: "downloaded", title: "받기 완료", note: "초록 점 · 다시 시작하면 설치" },
  ];
  return (
    <div className="ver-rail-states">
      {states.map((s) => (
        <figure key={s.state} className="ver-rail-state">
          <div className="ver-rail-frame">
            <NavRail items={railItems(s.state, latest)} current="workbench" onSelect={() => {}} avatar="JD" labels={{ navigation: "내비게이션", account: "계정" }} />
          </div>
          <figcaption><strong>{s.title}</strong><span>{s.note}</span></figcaption>
        </figure>
      ))}
    </div>
  );
}
