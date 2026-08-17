import { useEffect, useState } from "react";
import { HARNESS_IDS, HARNESS_LABELS, type HarnessId } from "../../shared/types";
import { GUIDE_DEFAULT_MODELS, GUIDE_LOCALES, type GuideChatKind, type GuideChatSettings, type GuideChatView } from "../../shared/guideChat";
import { GuideMarkedText } from "./GuideMarkedText";

export function GuideChat({
  kind,
  compact,
  viewing,
  onOpenSlide,
}: {
  kind: GuideChatKind;
  compact?: boolean;
  viewing?: { index: number; title: string; scene: string };
  onOpenSlide?: (index: number) => void;
}) {
  const [view, setView] = useState<GuideChatView>({ kind, blocks: [], busy: false, contextLevel: "unknown" });
  const [settings, setSettings] = useState<GuideChatSettings>({ harnessId: "claude-code", language: "ko" });
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    const host = window.agentPartyGuide;
    void host.getChat(kind).then(setView).catch((caught) => setError(String(caught)));
    void host.getChatSettings().then(setSettings).catch((caught) => setError(String(caught)));
    return host.onChatUpdate((payload) => {
      setView(kind === "chatbot" ? payload.chatbot : payload.slide);
      setSettings(payload.settings);
    });
  }, [kind]);

  async function send() {
    const text = draft.trim();
    if (!text || view.busy) {
      return;
    }
    setDraft("");
    setError("");
    try {
      setView(await window.agentPartyGuide.sendChat(kind, text, viewing));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function reset() {
    setError("");
    setView(await window.agentPartyGuide.resetChat(kind));
  }

  async function changeHarness(harnessId: HarnessId) {
    setError("");
    setSettings(await window.agentPartyGuide.updateChatSettings({ harnessId }));
  }

  async function changeModel(model: string) {
    setSettings(await window.agentPartyGuide.updateChatSettings({ model }));
  }

  async function changeLanguage(language: GuideChatSettings["language"]) {
    setSettings(await window.agentPartyGuide.updateChatSettings({ language }));
  }

  const needsModel = !GUIDE_DEFAULT_MODELS[settings.harnessId] && !settings.model;

  return (
    <section className={"guide-chat" + (compact ? " compact" : "")}>
      <header className="guide-chat-bar">
        <select value={settings.harnessId} onChange={(event) => void changeHarness(event.target.value as HarnessId)} aria-label="하네스">
          {HARNESS_IDS.map((id) => <option key={id} value={id}>{HARNESS_LABELS[id]}</option>)}
        </select>
        <input
          value={settings.model || ""}
          onChange={(event) => void changeModel(event.target.value)}
          placeholder={GUIDE_DEFAULT_MODELS[settings.harnessId] ? "" : "모델을 고르세요"}
          aria-label="모델"
        />
        <select value={settings.language} onChange={(event) => void changeLanguage(event.target.value as GuideChatSettings["language"])} aria-label="언어">
          {GUIDE_LOCALES.map((locale) => <option key={locale.id} value={locale.id}>{locale.label}</option>)}
        </select>
        <span className={"guide-context " + view.contextLevel} title="컨텍스트">
          {view.contextLevel === "high" ? "거의 참" : view.contextLevel === "ok" ? "여유" : "—"}
        </span>
        <button type="button" onClick={() => void reset()}>새로 시작하기</button>
      </header>
      <div className="guide-chat-log">
        {view.blocks.length === 0 ? <p className="guide-chat-empty">이 앱에 대해 물어보세요. 지식은 guide/knowledge 의 md 입니다.</p> : null}
        {view.blocks.map((block) => (
          <div key={block.id} className={"guide-bubble " + block.kind}>
            {block.kind === "user" || block.kind === "assistant" || block.kind === "error" || block.kind === "status"
              ? <GuideMarkedText text={"text" in block ? String(block.text || "") : ""} onOpenSlide={onOpenSlide} />
              : <span>{block.kind}</span>}
          </div>
        ))}
        {view.busy ? <div className="guide-bubble status">답하는 중…</div> : null}
      </div>
      <footer className="guide-chat-input">
        <p className="guide-cost-on">여기서부터는 선택한 모델의 비용이 발생한다</p>
        {needsModel ? <p className="guide-error" role="alert">이 하네스는 기본 모델이 없습니다. 모델을 고르세요.</p> : null}
        {error || view.error ? <p className="guide-error" role="alert">{error || view.error}</p> : null}
        <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={kind === "slide" ? "이 화면에 대해 묻기" : "가이드에게 묻기"}
            disabled={view.busy || needsModel}
          />
          <button type="submit" disabled={view.busy || needsModel || !draft.trim()}>보내기</button>
        </form>
      </footer>
    </section>
  );
}
