import { useEffect, useRef, useState } from "react";
import { Cpu, Info, Play, RotateCcw } from "lucide-react";
import type { GuideChatKind, GuideChatSettings, GuideChatView } from "../../shared/guideChat";
import { GuideMarkedText } from "./GuideMarkedText";
import { GuideModelModal } from "./GuideModelModal";

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
  const editorRef = useRef<HTMLDivElement | null>(null);

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
    if (editorRef.current) {
      editorRef.current.textContent = "";
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

  const empty = view.blocks.length === 0;
  const pill = `${settings.model || "모델 없음"} · effort ${settings.effort || "medium"}`;

  const transcript = (
    <div className="wb-transcript density-wide" style={{ height: "auto", minHeight: 0, overflow: "visible" }}>
      {view.blocks.map((block) => {
        const text = "text" in block ? String((block as { text?: unknown }).text || "") : "";
        if (block.kind === "user") {
          return (
            <div key={block.id} className="wb-block wb-user">
              <div className="wb-user-head"><span className="wb-user-who">You</span><span className="wb-mono wb-time">{block.at}</span></div>
              <div className="wb-user-bubble"><span className="wb-msg-text">{text}</span></div>
            </div>
          );
        }
        if (block.kind === "assistant") {
          return (
            <div key={block.id} className="wb-block wb-assistant">
              <div className="wb-assistant-head"><span className="wb-dot" /><strong>가이드</strong><span className="wb-mono wb-time">{block.at}</span></div>
              <div className="wb-assistant-body">
                <div className="wb-md"><GuideMarkedText text={text} onOpenSlide={onOpenSlide} /></div>
              </div>
            </div>
          );
        }
        return (
          <div key={block.id} className="wb-block wb-assistant">
            <div className="wb-assistant-body">
              <div className="wb-inline-note is-warning">{text || block.kind}</div>
            </div>
          </div>
        );
      })}
      {view.busy ? (
        <div className="wb-block wb-assistant">
          <div className="wb-assistant-head"><span className="wb-dot" /><strong>가이드</strong></div>
          <div className="wb-assistant-body"><div className="wb-md"><p>답하는 중…</p></div></div>
        </div>
      ) : null}
    </div>
  );

  const composer = (
    <div className="guide-composer-wrap" style={sheet ? { width: "100%", maxWidth: "none", padding: "10px 12px 12px" } : undefined}>
      {sheet ? null : (
        <p className="guide-composer-note">
          <Info size={12} />
          여기서부터는 선택한 모델의 비용이 발생합니다.
        </p>
      )}
      {error || view.error ? <div className="wb-inline-note is-warning" role="alert">{error || view.error}</div> : null}
      <div className="wb-composer">
        <div className="wb-composer-box">
          <div
            ref={editorRef}
            className="wb-composer-input wb-composer-editor"
            contentEditable
            role="textbox"
            aria-label={kind === "slide" ? "이 슬라이드에 대해 물어보기" : "앱 사용법 물어보기"}
            data-placeholder={kind === "slide" ? "이 슬라이드에 대해 물어보세요" : empty ? "앱 사용법을 물어보세요" : "이어서 물어보세요"}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(event.currentTarget.textContent || "");
              }
            }}
          />
          <div className="wb-composer-row">
            <div className="wb-composer-tools">
              <button type="button" className="wb-pill wb-dd-trigger" title="모델 설정 · 카탈로그 열기" onClick={() => setModelOpen(true)}>
                <span className="wb-dd-ic"><Cpu size={13} /></span>
                <span className="wb-mono">{pill}</span>
              </button>
            </div>
            <div className="wb-composer-actions">
              <button
                type="button"
                className="accent-btn"
                disabled={view.busy}
                onClick={() => void send(editorRef.current?.textContent || "")}
              >
                보내기
              </button>
            </div>
          </div>
        </div>
      </div>
      {sheet ? null : (
        <div className="guide-composer-meta">
          {empty ? (
            <>
              <span>지식 정본 <span className="wb-mono">guide/knowledge/</span> 를 읽고 답합니다</span>
              <span className="guide-spacer" />
              <span>앱 상태 질문은 <strong>문제 해결</strong> 로 넘깁니다</span>
            </>
          ) : (
            <>
              <span>컨텍스트 {view.contextLevel === "high" ? "거의 참" : view.contextLevel === "ok" ? "여유" : "—"}</span>
              <span className="guide-spacer" />
              <button type="button" className="ghost-btn" onClick={() => void reset()}>
                <RotateCcw size={13} />
                새로 시작하기
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className={sheet ? "guide-ask-chat" : "guide-chat"}>
      {sheet ? (
        <div className="guide-ask-body">{transcript}</div>
      ) : (
        <div className="guide-chat-scroll">
          <div className="guide-chat-col">
            {empty ? (
              <>
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
              </>
            ) : (
              transcript
            )}
          </div>
        </div>
      )}
      {composer}
      {modelOpen ? (
        <GuideModelModal
          settings={settings}
          onApply={(next) => setSettings(next)}
          onClose={() => setModelOpen(false)}
        />
      ) : null}
    </div>
  );
}
