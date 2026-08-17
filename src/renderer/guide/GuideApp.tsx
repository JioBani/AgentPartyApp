import { useCallback, useEffect, useState } from "react";
import { Maximize2, Minus, X } from "lucide-react";
import { App } from "../App";
import { firstSlideOfScene, GUIDE_SCENES, GUIDE_SLIDE_COUNT, sceneOf } from "../../shared/guide";
import { slideAt } from "./slides";
import { GuideChat } from "./GuideChat";
import "./guide.css";

function requireGuideHost(): typeof window.agentPartyGuide {
  const host = window.agentPartyGuide;
  if (!host) {
    throw new Error("가이드 preload 가 window.agentPartyGuide 를 노출하지 않았습니다.");
  }
  return host;
}

export function GuideApp() {
  const [presenting, setPresenting] = useState(false);
  const [index, setIndex] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [error, setError] = useState("");

  const apply = useCallback((next: number) => {
    try {
      const slide = slideAt(next);
      const host = requireGuideHost();
      host.applySnapshot(slide.snapshot);
      host.notifySlide(slide.index);
      setIndex(slide.index);
      setPresenting(true);
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
      offAsk = host.onSetAsk((open) => setAskOpen(open));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    return () => {
      offSlide?.();
      offAsk?.();
    };
  }, [apply]);

  useEffect(() => {
    if (!presenting) {
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
  }, [generation, presenting]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && (event.target.tagName === "INPUT" || event.target.tagName === "TEXTAREA" || event.target.tagName === "SELECT");
      if (typing) {
        return;
      }
      if (!presenting) {
        if (event.key === "Enter" || event.key === "ArrowRight") {
          event.preventDefault();
          apply(0);
        }
        return;
      }
      if (event.key === "ArrowRight" || event.key === "PageDown") {
        event.preventDefault();
        apply(Math.min(GUIDE_SLIDE_COUNT - 1, index + 1));
      } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
        event.preventDefault();
        apply(Math.max(0, index - 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        apply(0);
      } else if (event.key === "End") {
        event.preventDefault();
        apply(GUIDE_SLIDE_COUNT - 1);
      } else if (event.key === "Escape") {
        setTocOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, index, presenting]);

  const last = index >= GUIDE_SLIDE_COUNT - 1;
  const progress = presenting ? ((index + 1) / GUIDE_SLIDE_COUNT) * 100 : 0;
  const slide = presenting ? slideAt(index) : undefined;
  const scene = presenting ? sceneOf(index) : undefined;

  return (
    <div className="guide-root">
      <header className="guide-chrome">
        <span className="guide-kicker">가이드</span>
        <span className="guide-title">{presenting ? slide?.title : "AgentParty 가이드"}</span>
        {presenting ? (
          <nav className="guide-nav">
            <div className="guide-toc">
              <button type="button" aria-expanded={tocOpen} onClick={() => setTocOpen((open) => !open)}>목차</button>
              {tocOpen ? (
                <ul className="guide-toc-list">
                  {GUIDE_SCENES.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={scene?.id === item.id ? "active" : ""}
                        onClick={() => apply(firstSlideOfScene(item.id))}
                      >
                        {item.title}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <button type="button" disabled={index <= 0} onClick={() => apply(index - 1)}>이전</button>
            <span className="guide-count">{index + 1} / {GUIDE_SLIDE_COUNT}</span>
            <button type="button" disabled={last} onClick={() => apply(index + 1)}>다음</button>
          </nav>
        ) : null}
        <div className="guide-window-controls">
          <button type="button" title="최소화" onClick={() => void window.agentParty.minimizeWindow()}><Minus size={14} /></button>
          <button type="button" title="최대화" onClick={() => void window.agentParty.maximizeWindow()}><Maximize2 size={13} /></button>
          <button type="button" className="close" title="닫기" onClick={() => void window.agentParty.closeWindow()}><X size={15} /></button>
        </div>
      </header>
      <div className="guide-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>
      {error ? <div className="guide-error" role="alert">{error}</div> : null}
      {presenting ? (
        <>
          <div className="guide-stage">
            <div className="guide-stage-app">
              <App key={generation} />
            </div>
          </div>
          <div className="guide-footer">
            <p className="guide-hint">무대는 보기 전용입니다. AI를 쓰지 않습니다. 실제 파티는 바뀌지 않습니다.</p>
            {last ? (
              <button type="button" className="guide-leave" onClick={() => void requireGuideHost().leaveToWorkspace()}>
                작업공간으로
              </button>
            ) : null}
          </div>
          {askOpen ? (
            <aside className="guide-ask-panel">
              <header className="guide-ask-head">
                <span>질문하기</span>
                <button type="button" onClick={() => setAskOpen(false)}>닫기</button>
              </header>
              <GuideChat
                kind="slide"
                compact
                viewing={slide && scene ? { index, title: slide.title, scene: scene.title } : undefined}
                onOpenSlide={apply}
              />
            </aside>
          ) : (
            <button type="button" className="guide-ask-fab" onClick={() => setAskOpen(true)}>질문하기</button>
          )}
        </>
      ) : (
        <div className="guide-landing">
          <div className="guide-landing-actions">
            <button type="button" className="guide-start" onClick={() => apply(0)}>가이드 보기</button>
            <p className="guide-hint">프레젠테이션은 AI를 쓰지 않습니다.</p>
          </div>
          <GuideChat kind="chatbot" onOpenSlide={apply} />
        </div>
      )}
    </div>
  );
}
