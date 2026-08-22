/**
 * Design studio — the design system, rendered from the shipping components.
 *
 * Every stage mounts the REAL component with fixture props. There is no second
 * implementation and no captured markup, so a page here cannot disagree with
 * the app: change `styles.css` or a token and this moves with it.
 *
 * TWO SURFACES, deliberately separate:
 *
 *   디자인 시스템 — components, their variants, and when to reach for them.
 *   앱 목업       — whole screens BUILT from that system.
 *
 * A screen is an OUTPUT of the system, not part of it. Mixing them is how a
 * design system quietly turns into a pile of screens (this project has the
 * scar — see docs/DESIGN_MIRROR.md).
 *
 * One story shows at a time, addressed by `#id`, because a design system that
 * can only be read by scrolling past everything is not a reference.
 *
 * The chrome is prefixed `st-` and never styles anything inside a stage. A
 * studio that restyles its own specimens is a lie about the app.
 */
import { useEffect, useMemo, useState } from "react";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";
import { I18nProvider } from "../i18n/I18nProvider";
import { THEME_METADATA } from "../../shared/appTheme";
import { STORIES, type Story } from "./stories";
import "../design-system.css";
import "../styles.css";
import "./studio.css";
// LAST on purpose: proposals win over the shipping rules they are proposing to
// replace. Empty file = the mockup is the app.
import "./proposed.css";

/** Screens are the mockup surface; everything else documents the system. */
const MOCKUP_GROUP = "Screens";
const SYSTEM_ORDER = ["Primitives", "Blocks", "Composites"];

function Stage({ story }: { story: Story }) {
  const [density, setDensity] = useState(story.densities?.[0]);
  const [variant, setVariant] = useState(story.variants?.[0]);
  const width = story.width ? `${story.width}px` : undefined;
  const height = story.height ? `${story.height}px` : undefined;
  return (
    <article className="st-story">
      <header className="st-story-head">
        <h1>{story.title}</h1>
        {story.densities ? (
          <div className="st-density" role="group" aria-label="밀도">
            {story.densities.map((option) => (
              <button
                key={option}
                type="button"
                className={option === density ? "is-on" : ""}
                onClick={() => setDensity(option)}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
        {story.variants ? (
          <div className="st-density" role="group" aria-label="상태">
            {story.variants.map((option) => (
              <button
                key={option}
                type="button"
                className={option === variant ? "is-on" : ""}
                onClick={() => setVariant(option)}
              >
                {option}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      {story.note ? <p className="st-note">{story.note}</p> : null}
      <div className="st-stage" style={{ width, height }}>
        {story.render(density, variant)}
      </div>
      <p className="st-hint">이 무대는 실제로 조작할 수 있습니다 — 도구 상자·추론·메뉴를 눌러 펼쳐 보세요.</p>
      <p className="st-measure">
        {story.width
          ? `무대 ${story.width}px${story.height ? ` × ${story.height}px` : ""} — 앱에서 이 컴포넌트가 받는 크기`
          : "폭은 컴포넌트가 정한다"}
      </p>
    </article>
  );
}

function Shell() {
  const { themeId, setTheme } = useTheme();
  const [id, setId] = useState(() => window.location.hash.slice(1));
  const [query, setQuery] = useState("");

  useEffect(() => {
    const onHash = () => setId(window.location.hash.slice(1));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // The surface follows the story: a link into a screen opens the mockup.
  const selected = STORIES.find((story) => story.id === id);
  const [surface, setSurface] = useState<"system" | "mockup">(
    selected?.group === MOCKUP_GROUP ? "mockup" : "system",
  );
  useEffect(() => {
    if (selected) setSurface(selected.group === MOCKUP_GROUP ? "mockup" : "system");
  }, [selected]);

  const visible = useMemo(() => {
    const inSurface = STORIES.filter((story) =>
      surface === "mockup" ? story.group === MOCKUP_GROUP : story.group !== MOCKUP_GROUP,
    );
    const term = query.trim().toLowerCase();
    if (!term) return inSurface;
    return inSurface.filter((story) => (story.title + " " + (story.note ?? "")).toLowerCase().includes(term));
  }, [surface, query]);

  const current = visible.find((story) => story.id === id) ?? visible[0];

  const groups = useMemo(() => {
    const map = new Map<string, Story[]>();
    for (const story of visible) {
      const list = map.get(story.group) ?? [];
      list.push(story);
      map.set(story.group, list);
    }
    return [...map].sort((a, b) => SYSTEM_ORDER.indexOf(a[0]) - SYSTEM_ORDER.indexOf(b[0]));
  }, [visible]);

  function open(next: string) {
    window.location.hash = next;
    setId(next);
  }

  function switchSurface(next: "system" | "mockup") {
    setSurface(next);
    const first = STORIES.find((story) =>
      next === "mockup" ? story.group === MOCKUP_GROUP : story.group !== MOCKUP_GROUP,
    );
    if (first) open(first.id);
  }

  return (
    <div className="st-root">
      <header className="st-bar">
        <strong className="st-brand">AgentParty</strong>
        <div className="st-surface" role="tablist" aria-label="표면">
          <button
            type="button"
            role="tab"
            aria-selected={surface === "system"}
            className={surface === "system" ? "is-on" : ""}
            onClick={() => switchSurface("system")}
          >
            디자인 시스템
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={surface === "mockup"}
            className={surface === "mockup" ? "is-on" : ""}
            onClick={() => switchSurface("mockup")}
          >
            앱 목업
          </button>
        </div>
        <select
          className="st-theme"
          value={themeId}
          onChange={(event) => setTheme(event.target.value)}
          aria-label="테마"
        >
          {THEME_METADATA.map((theme) => (
            <option key={theme.id} value={theme.id}>{theme.label}</option>
          ))}
        </select>
      </header>

      <div className="st-body">
        <nav className="st-nav" aria-label={surface === "mockup" ? "화면" : "컴포넌트"}>
          <input
            className="st-search"
            type="search"
            placeholder="이름으로 거르기"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {groups.map(([group, stories]) => (
            <div key={group} className="st-nav-group">
              <p className="st-nav-title">{group} <em>{stories.length}</em></p>
              {stories.map((story) => (
                <button
                  key={story.id}
                  type="button"
                  className={"st-nav-item" + (story.id === current?.id ? " is-on" : "")}
                  onClick={() => open(story.id)}
                >
                  {story.title}
                </button>
              ))}
            </div>
          ))}
          {visible.length === 0 ? <p className="st-empty">일치하는 것이 없습니다.</p> : null}
        </nav>

        <main className="st-main">
          {current ? <Stage key={current.id} story={current} /> : null}
        </main>
      </div>
    </div>
  );
}

export function Studio() {
  return (
    <ThemeProvider>
      <I18nProvider locale="ko">
        <Shell />
      </I18nProvider>
    </ThemeProvider>
  );
}
