import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Menu,
  MessageSquare,
  Play,
  X,
} from "lucide-react";
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
import { GuideStage } from "./GuideStage";
import "./guide.css";

/** The stage renders the real workbench at a fixed 1440×942 (see
 *  `.guide-stage-app` / `.guide-stage-frame`) and scales the whole box down. The
 *  spotlight rectangles are percentages measured against exactly those
 *  dimensions, so the two must not drift apart. */
const STAGE_W = 1440;

type GuideMode = "chat" | "deck" | "end";

function requireGuideHost(): typeof window.agentPartyGuide {
  const host = window.agentPartyGuide;
  if (!host) {
    throw new Error("preload 가 window.agentPartyGuide 를 노출하지 않았습니다.");
  }
  return host;
}

/**
 * The guide screen. Lives in the main window like any other view — the nav rail,
 * the titlebar and the window controls stay where the user left them, and
 * leaving the guide is a navigation, not a window close.
 */
export function GuideView({ onLeave }: { onLeave: () => void }) {
  const [mode, setMode] = useState<GuideMode>("chat");
  const [index, setIndex] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(1);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /** Takes focus back from the stage iframe. A modal inside the demo autofocuses
   *  its first field, and while that holds focus the arrow keys type into the
   *  picture instead of turning the slide. */
  const takeFocus = useCallback(() => {
    const active = document.activeElement;
    // The stage iframe IS inside this root, so "contains" is not the question —
    // focus on the frame element means focus is in the demo document. A field of
    // our own (the ask sheet) keeps it: the user may be typing a question.
    const inStage = active instanceof HTMLIFrameElement;
    if (!rootRef.current || (!inStage && rootRef.current.contains(active))) {
      return;
    }
    rootRef.current.focus({ preventScroll: true });
  }, []);

  const apply = useCallback((next: number, { present = true }: { present?: boolean } = {}) => {
    try {
      const slide = slideAt(next);
      setIndex(slide.index);
      if (present) {
        setMode("deck");
      }
      setTocOpen(false);
      // Bumped even when the index is unchanged: re-selecting a slide must
      // rebuild the stage from the snapshot, never leave an edited state behind.
      setGeneration((value) => value + 1);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  // Main mirrors what is on screen so GET /api/guide answers about the real
  // view, not about a window it used to own.
  useEffect(() => {
    try {
      requireGuideHost().notifyState({ open: true, presenting: mode === "deck", slide: index });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [mode, index]);

  useEffect(() => () => {
    window.agentPartyGuide?.notifyState({ open: false, presenting: false, slide: 0 });
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

  // The stage keeps the workbench whole — never cropped — so it is scaled to fit
  // whatever the window currently gives it.
  useLayoutEffect(() => {
    if (mode !== "deck") {
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
  }, [mode]);

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
      if (typing || mode !== "deck") {
        return;
      }
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        if (index >= GUIDE_SLIDE_COUNT - 1) {
          setMode("end");
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
  }, [apply, index, mode]);

  const slide = slideAt(index);
  const scene = sceneOf(index);
  const paid = mode !== "deck" || askOpen;

  return (
    // tabIndex -1: the deck's own arrow-key handler lives on THIS document, so
    // the chrome must be able to hold focus itself. Without a focusable root
    // there is nowhere to put focus back to after the stage's modals grab it.
    <div className="guide-window" ref={rootRef} tabIndex={-1}>
      {/* The app titlebar already names the screen and carries the theme toggle
          and window controls, so this row keeps only what is the guide's own:
          where you are, what it costs, and the language. */}
      <div className="guide-topbar">
        {/* The two halves of the guide, always both reachable. The offer card on
            the empty landing disappears as soon as you ask something, and the
            deck had no way back at all — so the switch lives here instead. */}
        <div className="wb-segmented guide-mode">
          <button
            type="button"
            className={"wb-segment" + (mode === "chat" ? " is-active" : "")}
            title="가이드에게 물어보기"
            onClick={() => { setMode("chat"); setTocOpen(false); setAskOpen(false); }}
          >
            <MessageSquare size={13} />
            물어보기
          </button>
          <button
            type="button"
            className={"wb-segment" + (mode === "deck" ? " is-active" : "")}
            title="앱을 움직여 보여주는 프레젠테이션"
            // Re-applies the CURRENT slide, so leaving to ask a question and
            // coming back puts you where you were rather than at the start.
            onClick={() => apply(index)}
          >
            <Play size={13} />
            가이드 보기
          </button>
        </div>
        <span className="guide-spacer" />
        <span
          className={"guide-cost " + (paid ? "is-paid" : "is-free")}
          title={paid ? "채팅은 선택한 모델의 비용이 발생한다" : "프레젠테이션은 AI를 쓰지 않는다"}
        >
          <DollarSign size={11} />
          {paid ? "채팅은 비용이 발생" : "AI 사용 안 함"}
        </span>
        <GuideLanguage onError={setError} />
      </div>

      <div className="guide-body">
        {error ? <div className="wb-inline-note is-warning" role="alert" style={{ margin: "10px 12px 0" }}>{error}</div> : null}

        {mode === "chat" ? (
          <GuideChat
            kind="chatbot"
            onStart={() => apply(0)}
            onOpenSlide={(next) => apply(next)}
          />
        ) : null}

        {mode === "deck" ? (
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
                    <GuideStage snapshot={slide.snapshot} generation={generation} onStaged={takeFocus} />
                  </div>
                  <div className="guide-stage-shade" />
                  <div className="guide-spot" style={slide.spot} />
                  <div className={"guide-caption at-" + slide.caption}>
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
                  onClick={() => (index >= GUIDE_SLIDE_COUNT - 1 ? setMode("end") : apply(index + 1))}
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

        {mode === "end" ? (
          <div className="guide-end">
            <h2>여기까지입니다</h2>
            <p>
              이제 직접 해 볼 차례입니다. 하다가 막히면 왼쪽 메뉴의 <strong>문제 해결</strong>,
              사용법이 궁금하면 언제든 이 가이드를 다시 열면 됩니다.
            </p>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button type="button" className="ghost-btn" onClick={() => apply(0)}>다시 보기</button>
              <button type="button" className="accent-btn" onClick={onLeave}>
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

/** Language lives in the guide's own top row. Only Korean ships today; the
 *  placeholder stays so the seam is visible rather than invented later (§9). */
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
