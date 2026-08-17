/**
 * The guide SCREEN — a view inside the ordinary app window.
 *
 * It used to be its own BrowserWindow with its own preload. That bought
 * isolation for the stage but cost the user a second window to manage: opening
 * the guide threw them out of the app instead of moving them inside it. The
 * stage now gets its isolation from an iframe with its own document
 * (`renderer/guide/stage/`), so the guide can be a navigation like any other.
 *
 * This class therefore owns no window. It drives whichever app window is showing
 * the guide, and mirrors that window's own report of what is on screen — so
 * GET /api/guide never claims a slide the user is not looking at.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BrowserWindow, ipcMain, type WebContents } from "electron";
import { clampGuideSlide, GUIDE_SLIDE_COUNT, GUIDE_SLIDES, sceneOf, type GuideInspect, type GuideScreenInfo } from "../shared/guide";
import { getLogFilePath, log } from "./logger";

const NOT_OPEN = "가이드 화면이 열려 있지 않습니다. POST /api/guide/open 으로 먼저 여세요.";

export class GuideScreenHost {
  /**
   * Every window currently showing the guide. More than one is legal — the same
   * guide can be open in two windows — and chat updates must reach ALL of them,
   * or the one that is not `primary` shows a conversation frozen mid-turn.
   */
  private viewers = new Set<WebContents>();
  /** The one a command acts on: the window that most recently opened the guide. */
  private primary: WebContents | undefined;
  private slide = 0;
  private presenting = false;
  private showing = false;
  private ipcReady = false;

  constructor(private readonly deps: {
    /** The app window `open()` should navigate. No id = the focused one. */
    targetWindow: (windowId?: string) => BrowserWindow | undefined;
  }) {}

  get(): GuideScreenInfo {
    return this.info();
  }

  /** Guide chat updates go to EVERY window showing the guide. */
  send(channel: string, payload: unknown): void {
    for (const contents of this.liveViewers()) {
      contents.send(channel, payload);
    }
  }

  /** Drops closed windows on the way past — nothing else prunes the set. */
  private liveViewers(): WebContents[] {
    for (const contents of [...this.viewers]) {
      if (contents.isDestroyed()) {
        this.viewers.delete(contents);
      }
    }
    if (this.primary?.isDestroyed()) {
      this.primary = undefined;
    }
    return [...this.viewers];
  }

  async open(windowId?: string): Promise<GuideScreenInfo> {
    this.ensureIpc();
    const window = this.deps.targetWindow(windowId);
    if (!window || window.isDestroyed()) {
      throw new Error(windowId ? `창 '${windowId}' 을(를) 찾지 못했습니다.` : "가이드를 열 앱 창이 없습니다.");
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
    window.webContents.send("nav:set", { view: "guide" });
    this.viewers.add(window.webContents);
    this.primary = window.webContents;
    await this.waitForScreen(window.webContents);
    this.showing = true;
    log("info", "guide", "guide screen opened", { id: this.viewerId(), slide: this.slide });
    return this.info();
  }

  /** Navigating is not painting. A capture used to pass on the previous view. */
  private async waitForScreen(contents: WebContents): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      const ready = await contents
        .executeJavaScript(`Boolean(document.querySelector(".guide-window"))`)
        .catch(() => false);
      if (ready) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("가이드 화면에 .guide-window 가 나타나지 않았습니다.");
  }

  /** Leaves the guide in the window a command would act on, not in all of them. */
  close(): GuideScreenInfo {
    const contents = this.primary;
    if (contents && !contents.isDestroyed()) {
      contents.send("nav:set", { view: "workbench" });
      this.viewers.delete(contents);
    }
    this.primary = [...this.liveViewers()].pop();
    this.showing = Boolean(this.primary);
    this.presenting = false;
    this.slide = 0;
    return this.info();
  }

  /**
   * Reads the live guide DOM. A capture can be a white frame that still has
   * width×height — this is the measurement that cannot silently pass.
   */
  async inspect(): Promise<GuideInspect> {
    const contents = this.requireViewer();
    const result = await contents
      .executeJavaScript(`(${GUIDE_INSPECT_SCRIPT})()`)
      .catch((error: unknown) => {
        throw new Error(`가이드 inspect 실패: ${error instanceof Error ? error.message : String(error)}`);
      });
    if (!result || result.error) {
      throw new Error(String(result?.error || "가이드 inspect 가 값을 반환하지 않았습니다."));
    }
    return result as GuideInspect;
  }

  async capture(outputPath?: string): Promise<{ ok: true; path: string; width: number; height: number; bytes: number }> {
    const contents = this.requireViewer();
    const image = await contents.capturePage();
    const size = image.getSize();
    if (size.width < 2 || size.height < 2) {
      throw new Error(`가이드 화면 캡처가 비었습니다 (${size.width}×${size.height}).`);
    }
    const buffer = image.toPNG();
    const dest = outputPath?.trim()
      || path.join(path.dirname(getLogFilePath()), `guide-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buffer);
    return { ok: true, path: dest, width: size.width, height: size.height, bytes: buffer.length };
  }

  async setSlide(index: number): Promise<GuideScreenInfo> {
    const next = clampGuideSlide(index);
    const contents = this.requireViewer();
    this.slide = next;
    this.presenting = true;
    contents.send("guide:set-slide", { index: next });
    return this.info();
  }

  setAsk(open: boolean): GuideScreenInfo {
    const contents = this.requireViewer();
    if (!this.presenting) {
      throw new Error("프레젠테이션이 열려 있을 때만 질문하기 패널을 엽니다.");
    }
    contents.send("guide:set-ask", { open });
    return this.info();
  }

  /** Clicks one element on the guide screen. Surfaces the miss instead of
   *  reporting a silent success, so a QA driver cannot pass on a dead selector. */
  async click(selector: string): Promise<{ ok: true; selector: string }> {
    const contents = this.requireViewer();
    const hit = await contents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) { return false; } el.click(); return true; })()`,
    );
    if (!hit) {
      throw new Error(`가이드 화면에서 '${selector}' 를 찾지 못했습니다.`);
    }
    return { ok: true, selector };
  }

  private requireViewer(): WebContents {
    this.liveViewers();
    if (!this.showing || !this.primary) {
      throw new Error(NOT_OPEN);
    }
    return this.primary;
  }

  private info(): GuideScreenInfo {
    const meta = GUIDE_SLIDES[this.slide];
    const open = this.showing && Boolean(this.primary && !this.primary.isDestroyed());
    return {
      open,
      presenting: open && this.presenting,
      id: open ? this.viewerId() : undefined,
      slide: this.slide,
      slideCount: GUIDE_SLIDE_COUNT,
      slideId: meta?.id,
      title: meta?.title,
      sceneId: meta?.scene,
      sceneTitle: meta ? sceneOf(this.slide).title : undefined,
    };
  }

  /** The window showing the guide, named the way WindowRegistry names it. */
  private viewerId(): string {
    const window = this.primary && !this.primary.isDestroyed() ? BrowserWindow.fromWebContents(this.primary) : undefined;
    return window ? `win-${window.id}` : "";
  }

  private ensureIpc(): void {
    if (this.ipcReady) {
      return;
    }
    this.ipcReady = true;

    // The screen is the source of truth for what the user is looking at: the
    // user can leave the guide from the nav rail without main being asked.
    ipcMain.on("guide:state", (event, payload: { open?: boolean; presenting?: boolean; slide?: number }) => {
      if (typeof payload?.open !== "boolean") {
        return;
      }
      if (!payload.open) {
        this.viewers.delete(event.sender);
        if (this.primary === event.sender) {
          this.primary = [...this.liveViewers()].pop();
          this.showing = Boolean(this.primary);
          this.presenting = false;
        }
        return;
      }
      this.viewers.add(event.sender);
      this.primary = event.sender;
      this.showing = true;
      this.presenting = Boolean(payload.presenting);
      try {
        this.slide = clampGuideSlide(payload.slide ?? 0);
      } catch (error) {
        log("warn", "guide", "ignored an out-of-range slide report", {
          slide: payload.slide,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }
}

/**
 * Fixed inspect body. The page never receives caller text — same contract as
 * POST /api/measure. A selector that matches nothing is `{ present: false }`,
 * never a guessed box of zeros.
 */
const GUIDE_INSPECT_SCRIPT = `function inspectGuide() {
  const round = (value) => Math.round(value * 100) / 100;
  const parseColor = (value) => {
    const match = String(value || "").match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/i);
    if (!match) return null;
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
  };
  const luminance = (c) => {
    const chan = (n) => {
      const s = n / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
  };
  const contrastOf = (fg, bg) => {
    const a = parseColor(fg);
    const b = parseColor(bg);
    if (!a || !b || a.a < 0.2 || b.a < 0.2) return null;
    const L1 = luminance(a);
    const L2 = luminance(b);
    const hi = Math.max(L1, L2);
    const lo = Math.min(L1, L2);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const nodeOf = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return { present: false };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const box = { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
    const visible = box.width >= 2 && box.height >= 2 && cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
    return {
      present: true,
      text: (el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 240),
      box,
      visible,
      styles: {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        opacity: cs.opacity,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
      },
      contrast: contrastOf(cs.color, cs.backgroundColor),
    };
  };
  const measureFabTheme = (themeId) => {
    document.documentElement.setAttribute("data-theme", themeId);
    return nodeOf(".guide-ask-fab");
  };
  const previousTheme = document.documentElement.getAttribute("data-theme");
  const fabLight = measureFabTheme("light");
  const fabDark = measureFabTheme("dark");
  if (previousTheme) {
    document.documentElement.setAttribute("data-theme", previousTheme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  return {
    readyState: document.readyState,
    dataTheme: document.documentElement.getAttribute("data-theme"),
    url: location.href,
    presenting: Boolean(document.querySelector(".guide-stage")),
    root: nodeOf(".guide-window"),
    landing: nodeOf(".guide-chat"),
    start: nodeOf(".guide-offer-card .accent-btn"),
    chat: nodeOf(".guide-chat"),
    cost: nodeOf(".guide-composer-note"),
    fab: nodeOf(".guide-ask-fab"),
    stage: nodeOf(".guide-stage"),
    stageFocused: Boolean(document.querySelector(".guide-stage.is-focused")),
    shade: nodeOf(".guide-stage-shade"),
    spot: nodeOf(".guide-spot"),
    spotShadow: (() => {
      const el = document.querySelector(".guide-spot");
      return el ? getComputedStyle(el).boxShadow : null;
    })(),
    caption: nodeOf(".guide-caption"),
    toc: nodeOf(".guide-toc"),
    askSheet: nodeOf(".guide-ask-sheet"),
    progressSegs: document.querySelectorAll(".guide-progress-seg").length,
    fabByTheme: { light: fabLight, dark: fabDark },
    slideMissing: Array.from(document.querySelectorAll(".guide-marker-miss")).map((el) => ({ text: (el.textContent || "").trim() })),
    slideLinks: Array.from(document.querySelectorAll(".guide-marker")).map((el) => ({ text: (el.textContent || "").trim() })),
  };
}`;
