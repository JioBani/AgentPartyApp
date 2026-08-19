/**
 * Guide chatbot + slide-chat sessions.
 *
 * Not party members: no party binding, so no party tools. CWD is the knowledge
 * folder. Chatbot transcript survives restart; slide chat does not.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionManager } from "./sessionManager";
import type { HarnessId } from "../shared/types";
import { getSettings } from "./settings";
import { getUserDataDir } from "./userDataDir";
import { log } from "./logger";
import { applyEvents, normalizeTranscriptBlocks } from "../shared/transcriptEvents";
import type { TranscriptBlock } from "../shared/transcript";
import {
  type GuideChatKind,
  type GuideChatSettings,
  type GuideChatView,
  GUIDE_DEFAULT_MODELS,
  isGuideChatKind,
  isGuideLocaleId,
  resolveGuideModel,
} from "../shared/guideChat";
import { buildGuidePrimer, wrapGuideUserTurn } from "../shared/guidePrimer";
import { requireGuideKnowledgeDir } from "./guideKnowledge";

interface PersistedChatbot {
  settings: GuideChatSettings;
  harnessSessionId?: string;
  blocks: TranscriptBlock[];
}

interface LiveChat {
  sessionId?: string;
  harnessSessionId?: string;
  blocks: TranscriptBlock[];
  busy: boolean;
  error?: string;
}

export class GuideChatHost {
  private settings: GuideChatSettings;
  private chatbot: LiveChat = { blocks: [], busy: false };
  private slide: LiveChat = { blocks: [], busy: false };

  constructor(
    private readonly deps: {
      sessionManager: SessionManager;
      knowledge: { packaged: boolean; resourcesPath?: string; appPath: string };
      emit: (channel: string, payload: unknown) => void;
    },
  ) {
    const stored = this.load();
    this.settings = stored.settings;
    this.chatbot.blocks = stored.blocks;
    this.chatbot.harnessSessionId = stored.harnessSessionId;
    this.deps.sessionManager.on("events", (payload: { sessionId?: string; events?: unknown[] }) => {
      this.onEvents(String(payload?.sessionId || ""), Array.isArray(payload?.events) ? payload.events : []);
    });
    this.deps.sessionManager.on("snapshot", (payload: { sessionId?: string; snapshot?: { contextTokens?: number; contextWindow?: number; sessionId?: string } }) => {
      const id = String(payload?.sessionId || "");
      const live = this.liveBySession(id);
      if (!live || !payload.snapshot?.sessionId) {
        return;
      }
      live.harnessSessionId = payload.snapshot.sessionId;
      if (live === this.chatbot) {
        this.save();
      }
    });
  }

  knowledgePath(): string {
    return requireGuideKnowledgeDir(this.deps.knowledge);
  }

  getSettings(): GuideChatSettings {
    return { ...this.settings };
  }

  updateSettings(patch: Partial<GuideChatSettings>): GuideChatSettings {
    if (patch.harnessId) {
      this.settings.harnessId = patch.harnessId;
      const next = GUIDE_DEFAULT_MODELS[patch.harnessId];
      this.settings.model = next?.model;
      this.settings.effort = next?.effort;
    }
    if (typeof patch.model === "string") {
      this.settings.model = patch.model;
    }
    if (patch.effort) {
      this.settings.effort = patch.effort;
    }
    if (patch.language && isGuideLocaleId(patch.language)) {
      this.settings.language = patch.language;
    }
    this.save();
    this.push();
    return this.getSettings();
  }

  view(kind: GuideChatKind): GuideChatView {
    const live = kind === "chatbot" ? this.chatbot : this.slide;
    return {
      kind,
      blocks: live.blocks,
      busy: live.busy,
      sessionId: live.sessionId,
      contextLevel: this.contextLevel(live.sessionId),
      error: live.error,
    };
  }

  async send(kind: GuideChatKind, text: string, viewing?: { index: number; title: string; scene: string }): Promise<GuideChatView> {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
      throw new Error("보낼 내용이 없습니다.");
    }
    const route = resolveGuideModel(this.settings);
    const live = kind === "chatbot" ? this.chatbot : this.slide;
    const sessionId = this.ensureSession(kind, route);
    const primer = buildGuidePrimer({
      knowledgeDir: this.knowledgePath(),
      language: this.settings.language,
      kind,
      viewing: kind === "slide" ? viewing : undefined,
    });
    if (kind === "slide") {
      if (viewing) {
        log("info", "guide", `looking at slide ${viewing.index}`, {
          title: viewing.title,
          scene: viewing.scene,
        });
      } else {
        log("warn", "guide", "slide chat turn missing viewing context");
      }
    }
    live.blocks = [...live.blocks, { id: `u-${Date.now()}`, kind: "user", text: trimmed, at: nowTime() }];
    live.busy = true;
    live.error = undefined;
    if (kind === "chatbot") {
      this.save();
    }
    this.push();
    try {
      this.deps.sessionManager.sendUserTurn(sessionId, wrapGuideUserTurn(primer, trimmed));
    } catch (error) {
      live.busy = false;
      live.error = error instanceof Error ? error.message : String(error);
      this.push();
      throw error;
    }
    return this.view(kind);
  }

  reset(kind: GuideChatKind): GuideChatView {
    const live = kind === "chatbot" ? this.chatbot : this.slide;
    if (live.sessionId) {
      this.deps.sessionManager.closeSession(live.sessionId);
    }
    live.sessionId = undefined;
    live.harnessSessionId = undefined;
    live.blocks = [];
    live.busy = false;
    live.error = undefined;
    if (kind === "chatbot") {
      this.save();
    }
    this.push();
    return this.view(kind);
  }

  compact(kind: GuideChatKind): GuideChatView {
    const live = kind === "chatbot" ? this.chatbot : this.slide;
    if (!live.sessionId) {
      throw new Error("압축할 대화가 없습니다.");
    }
    this.deps.sessionManager.compact(live.sessionId);
    return this.view(kind);
  }

  private ensureSession(kind: GuideChatKind, route: { model: string; effort: "low" | "medium" | "high" | "xhigh" | "max" }): string {
    const live = kind === "chatbot" ? this.chatbot : this.slide;
    if (live.sessionId && this.deps.sessionManager.listSessions().some((session) => session.id === live.sessionId)) {
      return live.sessionId;
    }
    const cwd = this.knowledgePath();
    const created = this.deps.sessionManager.createSession({
      workspacePath: cwd,
      selectedHarnessId: this.settings.harnessId,
      model: route.model,
      effort: route.effort,
      permissionMode: "plan",
      codexPolicy: { sandbox: "read-only", approval: "never", guardian: false },
      cursorPolicy: { mode: "ask", approval: "allowlist" },
    }, kind === "chatbot" ? live.harnessSessionId : undefined);
    live.sessionId = created.id;
    return created.id;
  }

  private onEvents(sessionId: string, events: unknown[]): void {
    const live = this.liveBySession(sessionId);
    if (!live || !events.length) {
      return;
    }
    const mapped = applyEvents({ current: live.blocks }, "current", events as any);
    live.blocks = normalizeTranscriptBlocks((mapped.current || live.blocks).filter((block) => !(
      block.kind === "status" && block.sent && /<guide>/.test(block.text || "")
    )));
    const ended = events.some((event) => {
      const type = (event as { type?: string }).type;
      return type === "turn_complete" || type === "error";
    });
    if (ended) {
      live.busy = false;
    }
    const errorEvent = events.find((event) => (event as { type?: string }).type === "error") as { text?: string; message?: string } | undefined;
    if (errorEvent) {
      live.error = errorEvent.text || errorEvent.message || "가이드 세션에서 오류가 발생했습니다.";
    }
    if (live === this.chatbot) {
      this.save();
    }
    this.push();
  }

  private liveBySession(sessionId: string): LiveChat | undefined {
    if (this.chatbot.sessionId === sessionId) {
      return this.chatbot;
    }
    if (this.slide.sessionId === sessionId) {
      return this.slide;
    }
    return undefined;
  }

  private contextLevel(sessionId?: string): GuideChatView["contextLevel"] {
    if (!sessionId) {
      return "unknown";
    }
    const snapshot = this.deps.sessionManager.listSessions().find((session) => session.id === sessionId)?.snapshot;
    const used = snapshot?.contextTokens;
    const total = snapshot?.contextWindow;
    if (!used || !total) {
      return "unknown";
    }
    return used / total >= 0.8 ? "high" : "ok";
  }

  private persistPath(): string {
    return path.join(getUserDataDir(), "guide", "chatbot.json");
  }

  private load(): PersistedChatbot {
    const fallback: PersistedChatbot = {
      settings: {
        harnessId: (getSettings().selectedHarnessId || "claude-code") as HarnessId,
        language: "ko",
        ...GUIDE_DEFAULT_MODELS[(getSettings().selectedHarnessId || "claude-code") as HarnessId],
      },
      blocks: [],
    };
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath(), "utf8")) as PersistedChatbot;
      return {
        settings: {
          harnessId: raw.settings?.harnessId || fallback.settings.harnessId,
          model: raw.settings?.model,
          effort: raw.settings?.effort,
          language: isGuideLocaleId(raw.settings?.language) ? raw.settings.language : "ko",
        },
        harnessSessionId: raw.harnessSessionId,
        blocks: Array.isArray(raw.blocks) ? normalizeTranscriptBlocks(raw.blocks) : [],
      };
    } catch {
      return fallback;
    }
  }

  private save(): void {
    const file = this.persistPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body: PersistedChatbot = {
      settings: this.settings,
      harnessSessionId: this.chatbot.harnessSessionId,
      blocks: this.chatbot.blocks,
    };
    fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
  }

  private push(): void {
    this.deps.emit("guide:chat-update", {
      chatbot: this.view("chatbot"),
      slide: this.view("slide"),
      settings: this.getSettings(),
    });
  }
}

function nowTime(): string {
  return new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function requireChatKind(value: unknown): GuideChatKind {
  if (!isGuideChatKind(value)) {
    throw new Error("kind는 chatbot 또는 slide여야 합니다.");
  }
  return value;
}
