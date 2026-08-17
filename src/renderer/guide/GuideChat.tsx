import { useEffect, useMemo, useState } from "react";
import { Cpu, Info, Play, RotateCcw } from "lucide-react";
import { Transcript } from "../workbench/Transcript";
import { Composer } from "../workbench/Composer";
import { guideActions, guideMemberView } from "./guideMemberView";
import type { GuideChatKind, GuideChatSettings, GuideChatView } from "../../shared/guideChat";
import { GuideModelModal } from "./GuideModelModal";
import { guideModelLabel, useGuideRoutes } from "./guideRoutes";

/** Questions the guide can actually answer — no app-state questions on purpose,
 *  those belong to `문제 해결` (§6-2-1). */
const SUGGESTS = [
  "멤버끼리 메시지를 주고받게 하려면?",
  "Message Gate 는 무엇을 막나요?",
  "권한 승인 카드는 언제 뜨나요?",
  "토큰 사용량은 어디서 보나요?",
];

export function GuideChat({
  kind,
  sheet,
  viewing,
  onStart,
  onOpenSlide,
}: {
  kind: GuideChatKind;
  /** Rendered inside the presentation's ask sheet rather than as the whole view. */
  sheet?: boolean;
  viewing?: { index: number; title: string; scene: string };
  onStart?: () => void;
  onOpenSlide?: (index: number) => void;
}) {
  const [view, setView] = useState<GuideChatView>({ kind, blocks: [], busy: false, contextLevel: "unknown" });
  const [settings, setSettings] = useState<GuideChatSettings>({ harnessId: "claude-code", language: "ko" });
  const [error, setError] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const { routes, error: routesError } = useGuideRoutes();
  const label = guideModelLabel(routes, settings.model);
  const empty = view.blocks.length === 0;
  const memberView = useMemo(() => guideMemberView(view, settings, label), [view, settings, label]);
  const actions = useMemo(() => guideActions(kind, setView), [kind]);

  useEffect(() => {
    const host = window.agentPartyGuide;
    void host.getChat(kind).then(setView).catch((caught) => setError(String(caught)));
    void host.getChatSettings().then(setSettings).catch((caught) => setError(String(caught)));
    return host.onChatUpdate((payload) => {
      setView(kind === "chatbot" ? payload.chatbot : payload.slide);
      setSettings(payload.settings);
    });
  }, [kind]);

  async function send(text: string) {
    const body = text.trim();
    if (!body || view.busy) {
      return;
    }
    setError("");
    try {
      setView(await window.agentPartyGuide.sendChat(kind, body, viewing));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function reset() {
    setError("");
    try {
      setView(await window.agentPartyGuide.resetChat(kind));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  // `detail="answers"`: this is a guide, not a workbench. The tool calls here are
  // the guide reading its own knowledge files, and the status lines are harness
  // plumbing — both pushed the answer the user asked for off the screen.
  const transcript = <Transcript view={memberView} density="wide" actions={actions} detail="answers" />;

  const composer = (
    <div className="guide-composer-wrap">
      {sheet ? null : (
        <p className="guide-composer-note">
          <Info size={12} />
          여기서부터는 선택한 모델의 비용이 발생합니다.
        </p>
      )}
      {error || view.error || routesError ? (
        <div className="wb-inline-note is-warning" role="alert">{error || view.error || routesError}</div>
      ) : null}
      <Composer view={memberView} density="wide" actions={actions} permission={false} />
      <div className="guide-composer-meta">
        {/* The workbench keeps this pill in the panel header, which the guide has
            no room for — so the guide's own meta row carries it. Without it the
            model catalog has no entry point at all. */}
        <button type="button" className="wb-pill wb-dd-trigger" title="모델 설정 · 카탈로그 열기" onClick={() => setModelOpen(true)}>
          <span className="wb-dd-ic"><Cpu size={13} /></span>
          <span className="wb-mono">{label} · effort {settings.effort || "medium"}</span>
        </button>
        <span className="guide-spacer" />
        {sheet ? null : empty ? (
          <span>지식 정본 <span className="wb-mono">guide/knowledge/</span> 를 읽고 답합니다</span>
        ) : (
          <button type="button" className="ghost-btn" onClick={() => void reset()}>
            <RotateCcw size={13} />
            새로 시작하기
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className={sheet ? "guide-ask-chat" : "guide-chat"}>
      {sheet ? (
        // Nothing asked yet = nothing to show. An empty scroll area here left a
        // blank strip above the composer that looked like a broken panel.
        empty ? null : transcript
      ) : empty ? (
        <div className="guide-chat-scroll">
          <div className="guide-chat-col">
                <div className="guide-hero">
                  <h1>무엇이 궁금한가요?</h1>
                  <p>이 앱에 대해 물어보세요. 처음이라면 움직이는 화면으로 한 바퀴 보는 편이 빠릅니다.</p>
                </div>
                <div className="guide-offer-card">
                  <div>
                    <strong>가이드 보기</strong>
                    <small>앱을 실제로 움직여 보여줍니다 · 장면 4개 · 슬라이드 10장</small>
                  </div>
                  <button type="button" className="accent-btn" onClick={onStart}>
                    <Play size={14} />
                    처음부터 보기
                  </button>
                </div>
                <p className="guide-section-label">이런 걸 물어봅니다</p>
                <div className="guide-suggests">
                  {SUGGESTS.map((text) => (
                    <button key={text} type="button" className="guide-suggest" onClick={() => void send(text)}>{text}</button>
                  ))}
                </div>
          </div>
        </div>
      ) : (
        // NOT wrapped in a scroll container. `Transcript` scrolls itself and
        // pins to the bottom as a reply streams in; nesting it inside another
        // scroller left that logic driving an element that never scrolls, so
        // the answer grew off the bottom of the screen.
        transcript
      )}
      {/* The ask sheet IS a panel already — putting the floating island inside it
          would draw a box inside a box. Only the full-screen chat gets the band. */}
      {sheet ? composer : <div className="guide-composer-band">{composer}</div>}
      {modelOpen ? (
        <GuideModelModal
          routes={routes}
          settings={settings}
          onApply={(next) => setSettings(next)}
          onClose={() => setModelOpen(false)}
        />
      ) : null}
    </div>
  );
}
