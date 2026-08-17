import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Maximize2,
  Menu,
  MessageSquare,
  Minus,
  Play,
  Sun,
  X,
} from "lucide-react";
import { App } from "../App";
import { useTheme } from "../theme/ThemeProvider";
import {
  firstSlideOfScene,
  GUIDE_SCENES,
  GUIDE_SLIDE_COUNT,
  sceneNumberOf,
  sceneOf,
  sceneRange,
} from "../../shared/guide";
import { slideAt } from "./slides";
import { GuideChat } from "./GuideChat";
import "./guide.css";

/** The stage renders the real workbench at this fixed size and scales the whole
 *  box down. The spotlight rectangles are percentages measured against exactly
 *  these dimensions, so they must not drift apart. */
const STAGE_W = 1440;
const STAGE_H = 942;

type GuideView = "chat" | "deck" | "end";

function requireGuideHost(): typeof window.agentPartyGuide {
  const host = window.agentPartyGuide;
  if (!host) {
    throw new Error("가이드 preload 가 window.agentPartyGuide 를 노출하지 않았습니다.");
  }
  return host;
}

export function GuideApp() {
  const { cycleTheme } = useTheme();
  const [view, setView] = useState<GuideView>("chat");
  const [index, setIndex] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const apply = useCallback((next: number, { present = true }: { present?: boolean } = {}) => {
    try {
      const slide = slideAt(next);
      const host = requireGuideHost();
      host.applySnapshot(slide.snapshot);
      host.notifySlide(slide.index);
      setIndex(slide.index);
      if (present) {
        setView("deck");
      }
      setTocOpen(false);
      setGeneration((value) => value + 1);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    let offSlide: (() => void) | undefined;
    let offAsk: (() => void) | undefined;
    try {
      const host = requireGuideHost();
      offSlide = host.onSetSlide((next) => apply(next));
      offAsk = host.onSetAsk((open) => {
        setAskOpen(open);
        if (open) {
          setTocOpen(false);
        }
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    return () => {
      offSlide?.();
      offAsk?.();
    };
  }, [apply]);

  useEffect(() => {
    if (view !== "deck") {
      return;
    }
    const id = window.setTimeout(() => {
      try {
        requireGuideHost().flushSideEffects();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [generation, view]);

  // The stage keeps the workbench whole — never cropped — so it is scaled to fit
  // whatever the window currently gives it.
  useLayoutEffect(() => {
    if (view !== "deck") {
      return;
    }
    const element = stageRef.current;
    if (!element) {
      return;
    }
    const measure = () => setScale(element.clientWidth / STAGE_W);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [view]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (event.key === "Escape") {
        setTocOpen(false);
        setAskOpen(false);
        return;
      }
      if (typing || view !== "deck") {
        return;
      }
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        if (index >= GUIDE_SLIDE_COUNT - 1) {
          setView("end");
        } else {
          apply(index + 1);
        }
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        apply(Math.max(0, index - 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        apply(0);
      } else if (event.key === "End") {
        event.preventDefault();
        apply(GUIDE_SLIDE_COUNT - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, index, view]);

  const slide = slideAt(index);
  const scene = sceneOf(index);
  const paid = view !== "deck" || askOpen;

  return (
    <div className="guide-window">
      <div className="app-titlebar">
        <div className="titlebar-drag">
          <div className="titlebar-brand">
            <span className="brand-mark"><span className="brand-mark-dot" /></span>
            <span className="brand-name">AgentParty</span>
            <small className="brand-sub">가이드</small>
          </div>
          <div className="guide-titlebar-tools no-drag">
            <span
              className={"guide-cost " + (paid ? "is-paid" : "is-free")}
              title={paid ? "채팅은 선택한 모델의 비용이 발생한다" : "프레젠테이션은 AI를 쓰지 않는다"}
            >
              <DollarSign size={11} />
              {paid ? "채팅은 비용이 발생" : "AI 사용 안 함"}
            </span>
            <GuideLanguage onError={setError} />
            <button type="button" className="titlebar-action" title="테마 전환" onClick={cycleTheme}>
              <Sun size={14} />
            </button>
          </div>
        </div>
        <div className="window-controls">
          <button type="button" className="window-button" title="최소화" onClick={() => void window.agentParty.minimizeWindow()}><Minus size={15} /></button>
          <button type="button" className="window-button" title="최대화" onClick={() => void window.agentParty.maximizeWindow()}><Maximize2 size={14} /></button>
          <button type="button" className="window-button close" title="닫기" onClick={() => void window.agentParty.closeWindow()}><X size={16} /></button>
        </div>
      </div>

      <div className="guide-body">
        {error ? <div className="wb-inline-note is-warning" role="alert" style={{ margin: "10px 12px 0" }}>{error}</div> : null}

        {view === "chat" ? (
          <GuideChat
            kind="chatbot"
            onStart={() => apply(0)}
            onOpenSlide={(next) => apply(next)}
          />
        ) : null}

        {view === "deck" ? (
          <>
            <div className="guide-deck">
              <div className="guide-deck-top">
                <button type="button" className="ghost-btn" onClick={() => { setTocOpen((open) => !open); setAskOpen(false); }} aria-expanded={tocOpen}>
                  <Menu size={14} />
                  목차
                </button>
                <span className="guide-scene">
                  <span className="guide-scene-index">장면 {sceneNumberOf(index)} / {GUIDE_SCENES.length}</span>
                  <span>{scene.title}</span>
                </span>
                <span className="guide-spacer" />
                <span className="guide-count">슬라이드 {index + 1} / {GUIDE_SLIDE_COUNT}</span>
              </div>

              <div className="guide-progress">
                {Array.from({ length: GUIDE_SLIDE_COUNT }, (_, at) => (
                  <button
                    key={at}
                    type="button"
                    className={"guide-progress-seg" + (at < index ? " is-seen" : "") + (at === index ? " is-current" : "")}
                    title={`슬라이드 ${at + 1}`}
                    onClick={() => apply(at)}
                  />
                ))}
              </div>
              <div className="guide-progress-scene">
                {GUIDE_SCENES.map((item) => {
                  const range = sceneRange(item.id);
                  return (
                    <span key={item.id} style={{ flex: range.to - range.from + 1 }}>{item.title}</span>
                  );
                })}
              </div>

              <div className="guide-stage-area">
                <div className={"guide-stage" + (askOpen ? "" : " is-focused")} ref={stageRef}>
                  <div className="guide-stage-app" style={{ transform: `scale(${scale})` }}>
                    <App key={generation} />
                  </div>
                  <div className="guide-stage-shade" />
                  <div className="guide-spot" style={slide.spot} />
                  <div className="guide-caption">
                    <span className="guide-caption-step">{index + 1}</span>
                    <div>
                      <strong>{slide.title}</strong>
                      <p>{slide.text}</p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="guide-deck-bottom">
                <button type="button" className="guide-nav-btn" title="이전 (←)" disabled={index <= 0} onClick={() => apply(index - 1)}>
                  <ChevronLeft size={15} />
                </button>
                <button
                  type="button"
                  className="guide-nav-btn"
                  title="다음 (→)"
                  onClick={() => (index >= GUIDE_SLIDE_COUNT - 1 ? setView("end") : apply(index + 1))}
                >
                  <ChevronRight size={15} />
                </button>
                <span className="guide-hint">← → 로 한 단계씩 · Home 처음으로</span>
                <span className="guide-spacer" />
                <button type="button" className="guide-ask-fab" onClick={() => { setAskOpen((open) => !open); setTocOpen(false); }}>
                  <MessageSquare size={14} />
                  질문하기
                </button>
              </div>
            </div>

            {tocOpen ? (
              <div className="guide-toc">
                {GUIDE_SCENES.map((item) => {
                  const range = sceneRange(item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={"guide-toc-row" + (scene.id === item.id ? " is-current" : "")}
                      onClick={() => apply(firstSlideOfScene(item.id))}
                    >
                      <span>{item.title}<small>{item.blurb}</small></span>
                      <span className="guide-toc-range">{range.from}–{range.to}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {askOpen ? (
              <div className="guide-ask-sheet">
                <div className="guide-ask-head">
                  <strong>질문하기</strong>
                  <span className="guide-attach">
                    <Play size={10} />
                    슬라이드 {index + 1} · {scene.title}
                  </span>
                  <span className="guide-spacer" />
                  <span className="guide-cost is-paid"><DollarSign size={11} />여기서부터 비용 발생</span>
                  <button type="button" className="wb-icon-btn" title="접기" onClick={() => setAskOpen(false)}><X size={14} /></button>
                </div>
                <GuideChat
                  kind="slide"
                  sheet
                  viewing={{ index, title: slide.title, scene: scene.title }}
                  onOpenSlide={(next) => apply(next)}
                />
              </div>
            ) : null}
          </>
        ) : null}

        {view === "end" ? (
          <div className="guide-end">
            <h2>여기까지입니다</h2>
            <p>
              이제 직접 해 볼 차례입니다. 하다가 막히면 왼쪽 메뉴의 <strong>문제 해결</strong>,
              사용법이 궁금하면 언제든 이 가이드를 다시 열면 됩니다.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button type="button" className="ghost-btn" onClick={() => apply(0)}>다시 보기</button>
              <button type="button" className="accent-btn" onClick={() => void requireGuideHost().leaveToWorkspace()}>
                작업공간으로
                <ArrowRight size={14} />
              </button>
            </div>
            <p className="guide-hint">완료 표시는 두지 않습니다 — 다시 열면 처음부터입니다.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Language lives in the titlebar. Only Korean ships today; the placeholder row
 *  stays so the seam is visible rather than invented later (§9). */
function GuideLanguage({ onError }: { onError: (message: string) => void }) {
  const [language, setLanguage] = useState("ko");
  useEffect(() => {
    void window.agentPartyGuide
      .getChatSettings()
      .then((settings) => setLanguage(settings.language))
      .catch((caught) => onError(String(caught)));
  }, [onError]);
  return (
    <select
      className="guide-lang"
      aria-label="가이드 언어"
      value={language}
      onChange={(event) => {
        const next = event.target.value;
        if (next !== "ko") {
          return;
        }
        setLanguage(next);
        void window.agentPartyGuide.updateChatSettings({ language: "ko" }).catch((caught) => onError(String(caught)));
      }}
    >
      <option value="ko">한국어</option>
      <option value="en" disabled>English (준비 중)</option>
    </select>
  );
}
