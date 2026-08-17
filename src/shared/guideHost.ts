/**
 * Extra surface the guide window's renderer chrome uses to drive the fake
 * preload. Not part of `AgentPartyApi` — `App` never sees this.
 */
import type { GuideSnapshot } from "./guide";
import type { GuideChatKind, GuideChatSettings, GuideChatView } from "./guideChat";

export interface GuideHostApi {
  /** Replace the absolute snapshot `window.agentParty` will serve next. */
  applySnapshot: (snapshot: GuideSnapshot) => void;
  getSnapshot: () => GuideSnapshot;
  /** Tell main the chrome (or HTTP) landed on this slide, so GET /api/guide matches. */
  notifySlide: (index: number) => void;
  /** HTTP / menu asked to jump. Chrome applies the matching snapshot and remounts. */
  onSetSlide: (callback: (index: number) => void) => () => void;
  /** HTTP / inspect asked to open or close the slide-chat panel. */
  onSetAsk: (callback: (open: boolean) => void) => () => void;
  /** After App remounts and subscribes, replay view / events / QA opens. */
  flushSideEffects: () => void;
  /** Close the guide and return to the real workbench (§2-4 last beat). */
  leaveToWorkspace: () => Promise<void>;
  knowledgePath: () => Promise<{ path: string }>;
  getChat: (kind: GuideChatKind) => Promise<GuideChatView>;
  sendChat: (kind: GuideChatKind, text: string, viewing?: { index: number; title: string; scene: string }) => Promise<GuideChatView>;
  resetChat: (kind: GuideChatKind) => Promise<GuideChatView>;
  compactChat: (kind: GuideChatKind) => Promise<GuideChatView>;
  getChatSettings: () => Promise<GuideChatSettings>;
  updateChatSettings: (patch: Partial<GuideChatSettings>) => Promise<GuideChatSettings>;
  onChatUpdate: (callback: (payload: { chatbot: GuideChatView; slide: GuideChatView; settings: GuideChatSettings }) => void) => () => void;
}

declare global {
  interface Window {
    agentPartyGuide: GuideHostApi;
  }
}

export {};
