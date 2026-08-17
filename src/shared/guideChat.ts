/**
 * Guide chat contract — two conversations, one model setting, markers in text.
 */
import type { EffortSetting, HarnessId } from "./types";
import type { TranscriptBlock } from "./transcript";

export const GUIDE_CHAT_KINDS = ["chatbot", "slide"] as const;
export type GuideChatKind = (typeof GUIDE_CHAT_KINDS)[number];

export const GUIDE_LOCALES = [{ id: "ko", label: "한국어" }] as const;
export type GuideLocaleId = (typeof GUIDE_LOCALES)[number]["id"];

export const GUIDE_DEFAULT_MODELS: Partial<Record<HarnessId, { model: string; effort: EffortSetting }>> = {
  "claude-code": { model: "claude-opus-5[1m]", effort: "medium" },
  codex: { model: "GPT-5.6 Sol", effort: "medium" },
};

export interface GuideChatSettings {
  harnessId: HarnessId;
  model?: string;
  effort?: EffortSetting;
  language: GuideLocaleId;
}

export interface GuideChatView {
  kind: GuideChatKind;
  blocks: TranscriptBlock[];
  busy: boolean;
  sessionId?: string;
  contextLevel: "unknown" | "ok" | "high";
  error?: string;
}

export interface GuideSlideMarker {
  kind: "text" | "slide" | "invalid";
  text?: string;
  index?: number;
  raw: string;
}

const MARKER = /\[\[slide:(\d+)]]/g;

/** Split assistant text into text runs and [[slide:N]] markers. */
export function parseGuideSlideMarkers(text: string, slideCount: number): GuideSlideMarker[] {
  const out: GuideSlideMarker[] = [];
  let last = 0;
  const source = String(text || "");
  for (const match of source.matchAll(MARKER)) {
    const at = match.index ?? 0;
    if (at > last) {
      out.push({ kind: "text", text: source.slice(last, at), raw: source.slice(last, at) });
    }
    const index = Number(match[1]);
    if (Number.isInteger(index) && index >= 0 && index < slideCount) {
      out.push({ kind: "slide", index, raw: match[0] });
    } else {
      out.push({ kind: "invalid", index, raw: match[0] });
    }
    last = at + match[0].length;
  }
  if (last < source.length) {
    out.push({ kind: "text", text: source.slice(last), raw: source.slice(last) });
  }
  return out;
}

export function resolveGuideModel(settings: GuideChatSettings): { model: string; effort: EffortSetting } {
  const fallback = GUIDE_DEFAULT_MODELS[settings.harnessId];
  const model = settings.model || fallback?.model;
  const effort = settings.effort || fallback?.effort || "medium";
  if (!model) {
    throw new Error(`${settings.harnessId} 는 기본 모델이 없습니다. 가이드에서 모델을 고르세요.`);
  }
  return { model, effort };
}

export function isGuideChatKind(value: unknown): value is GuideChatKind {
  return value === "chatbot" || value === "slide";
}

export function isGuideLocaleId(value: unknown): value is GuideLocaleId {
  return GUIDE_LOCALES.some((locale) => locale.id === value);
}
