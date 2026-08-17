/**
 * Extra surface the guide screen uses, alongside the ordinary `window.agentParty`
 * bridge. Not part of `AgentPartyApi` — the workbench never sees this.
 *
 * The stage's fake bridge is NOT in here: it lives inside the stage iframe's own
 * document (`renderer/guide/stage/`), so nothing in the main window can reach it
 * and nothing in it can reach the real app.
 */
import type { GuideChatKind, GuideChatSettings, GuideChatView } from "./guideChat";

export interface GuideHostApi {
  /** Mirror what is on screen in main, so GET /api/guide answers about the real
   *  view rather than about state it guessed. */
  notifyState: (state: { open: boolean; presenting: boolean; slide: number }) => void;
  /** HTTP / menu asked to jump. The screen applies that slide and remounts the stage. */
  onSetSlide: (callback: (index: number) => void) => () => void;
  /** HTTP / inspect asked to open or close the slide-chat panel. */
  onSetAsk: (callback: (open: boolean) => void) => () => void;
  knowledgePath: () => Promise<{ path: string }>;
  /** The model catalog for the guide's own model settings (harness-free, §6). */
  listRoutes: () => Promise<import("../renderer/workbench/routes").RouteLike[]>;
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
