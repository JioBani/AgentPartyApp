/**
 * The guide BrowserWindow. A separate preload and an in-memory session
 * partition keep it off the user's party store, settings IPC, and localStorage.
 *
 * Not registered in WindowRegistry — a registry entry would receive
 * `party:update` / `session:events` broadcasts and show up in GET /api/windows.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BrowserWindow, ipcMain, shell } from "electron";
import { clampGuideSlide, GUIDE_SLIDE_COUNT, GUIDE_SLIDES, sceneOf, type GuideInspect, type GuideWindowInfo } from "../shared/guide";
import { getLogFilePath, log } from "./logger";

export class GuideWindowHost {
  private window: BrowserWindow | undefined;
  private slide = 0;
  private presenting = false;
  private ipcReady = false;

  constructor(private readonly deps: {
    placeWindow?: (window: BrowserWindow) => void;
    focusWorkbench?: () => void;
  }) {}

  get(): GuideWindowInfo {
    return this.info();
  }

  isFocused(): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isFocused());
  }

  send(channel: string, payload: unknown): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload);
    }
  }

  async open(): Promise<GuideWindowInfo> {
    this.ensureIpc();
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      return this.info();
    }

    const window = new BrowserWindow({
      width: 1480,
      height: 960,
      minWidth: 960,
      minHeight: 640,
      title: "AgentParty 가이드",
      backgroundColor: "#0f1419",
      titleBarStyle: "hidden",
      frame: false,
      webPreferences: {
        preload: path.join(__dirname, "../preload/guidePreload.js"),
        // In-memory session: isolated localStorage / cache, gone when the window closes.
        partition: "guide",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });
    this.deps.placeWindow?.(window);
    this.window = window;
    this.slide = 0;
    this.presenting = false;

    window.on("closed", () => {
      if (this.window === window) {
        this.window = undefined;
      }
      log("info", "guide", "guide window closed");
    });

    const rendererUrl = process.env.AGENTPARTY_RENDERER_URL;
    if (rendererUrl) {
      const base = rendererUrl.replace(/\/$/, "");
      await window.loadURL(`${base}/guide/index.html`);
      window.webContents.openDevTools({ mode: "detach" });
    } else {
      await window.loadFile(path.join(__dirname, "../../dist-renderer/guide/index.html"));
    }
    await this.waitForRoot();
    log("info", "guide", "guide window opened", { id: this.windowId(), slide: this.slide });
    return this.info();
  }

  /** loadURL resolving is not first paint. A white capture used to pass here. */
  private async waitForRoot(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) {
      throw new Error("가이드 창이 열려 있지 않습니다. POST /api/guide/open 으로 먼저 여세요.");
    }
    for (let i = 0; i < 50; i += 1) {
      const ready = await this.window.webContents
        .executeJavaScript(`Boolean(document.querySelector(".guide-root"))`)
        .catch(() => false);
      if (ready) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("가이드 창에 .guide-root 가 나타나지 않았습니다.");
  }

  close(): GuideWindowInfo {
    if (this.window && !this.window.isDestroyed()) {
      this.window.close();
    }
    this.window = undefined;
    this.presenting = false;
    this.slide = 0;
    return this.info();
  }

  /**
   * Reads the live guide DOM. A capture can be a white frame that still has
   * width×height — this is the measurement that cannot silently pass.
   */
  async inspect(): Promise<GuideInspect> {
    if (!this.window || this.window.isDestroyed()) {
      throw new Error("가이드 창이 열려 있지 않습니다. POST /api/guide/open 으로 먼저 여세요.");
    }
    const result = await this.window.webContents
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
    if (!this.window || this.window.isDestroyed()) {
      throw new Error("가이드 창이 열려 있지 않습니다. POST /api/guide/open 으로 먼저 여세요.");
    }
    const image = await this.window.webContents.capturePage();
    const size = image.getSize();
    if (size.width < 2 || size.height < 2) {
      throw new Error(`가이드 창 캡처가 비었습니다 (${size.width}×${size.height}).`);
    }
    const buffer = image.toPNG();
    const dest = outputPath?.trim()
      || path.join(path.dirname(getLogFilePath()), `guide-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buffer);
    return { ok: true, path: dest, width: size.width, height: size.height, bytes: buffer.length };
  }

  async setSlide(index: number): Promise<GuideWindowInfo> {
    const next = clampGuideSlide(index);
    if (!this.window || this.window.isDestroyed()) {
      throw new Error("가이드 창이 열려 있지 않습니다. POST /api/guide/open 으로 먼저 여세요.");
    }
    this.slide = next;
    this.presenting = true;
    this.window.webContents.send("guide:set-slide", { index: next });
    return this.info();
  }

  setAsk(open: boolean): GuideWindowInfo {
    if (!this.window || this.window.isDestroyed()) {
      throw new Error("가이드 창이 열려 있지 않습니다. POST /api/guide/open 으로 먼저 여세요.");
    }
    if (!this.presenting) {
      throw new Error("프레젠테이션이 열려 있을 때만 질문하기 패널을 엽니다.");
    }
    this.window.webContents.send("guide:set-ask", { open });
    return this.info();
  }

  private info(): GuideWindowInfo {
    const meta = GUIDE_SLIDES[this.slide];
    const open = Boolean(this.window && !this.window.isDestroyed());
    return {
      open,
      presenting: open && this.presenting,
      id: open ? this.windowId() : undefined,
      slide: this.slide,
      slideCount: GUIDE_SLIDE_COUNT,
      slideId: meta?.id,
      title: meta?.title,
      sceneId: meta?.scene,
      sceneTitle: meta ? sceneOf(this.slide).title : undefined,
    };
  }

  private windowId(): string {
    return this.window ? `guide-${this.window.id}` : "";
  }

  private ensureIpc(): void {
    if (this.ipcReady) {
      return;
    }
    this.ipcReady = true;

    ipcMain.handle("guide:window", (event, action: unknown) => {
      const target = BrowserWindow.fromWebContents(event.sender);
      if (!target || target !== this.window) {
        throw new Error("가이드 창이 아닌 곳에서 guide:window 를 호출했습니다.");
      }
      if (action === "minimize") {
        target.minimize();
        return { ok: true };
      }
      if (action === "maximize") {
        if (target.isMaximized()) {
          target.unmaximize();
        } else {
          target.maximize();
        }
        return { ok: true };
      }
      if (action === "close") {
        target.close();
        return { ok: true };
      }
      throw new Error(`알 수 없는 가이드 창 동작: ${String(action)}`);
    });

    ipcMain.handle("guide:open-external", async (_event, target: unknown) => {
      const url = String(target || "");
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, error: "가이드에서는 http(s) URL 만 열 수 있습니다." };
      }
      await shell.openExternal(url);
      return { ok: true };
    });

    ipcMain.handle("guide:leave", (event) => {
      if (!this.window || event.sender !== this.window.webContents) {
        throw new Error("가이드 창이 아닌 곳에서 guide:leave 를 호출했습니다.");
      }
      this.close();
      this.deps.focusWorkbench?.();
      return { ok: true };
    });

    ipcMain.on("guide:slide-changed", (event, payload: { index?: number }) => {
      if (!this.window || event.sender !== this.window.webContents) {
        return;
      }
      if (typeof payload?.index !== "number") {
        return;
      }
      try {
        this.slide = clampGuideSlide(payload.index);
        this.presenting = true;
      } catch (error) {
        log("warn", "guide", "ignored invalid slide-changed", {
          index: payload.index,
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
    root: nodeOf(".guide-root"),
    landing: nodeOf(".guide-landing"),
    start: nodeOf(".guide-start"),
    chat: nodeOf(".guide-chat"),
    cost: nodeOf(".guide-cost-on"),
    fab: nodeOf(".guide-ask-fab"),
    fabByTheme: { light: fabLight, dark: fabDark },
    slideMissing: Array.from(document.querySelectorAll(".guide-slide-missing")).map((el) => ({ text: (el.textContent || "").trim() })),
    slideLinks: Array.from(document.querySelectorAll(".guide-slide-link")).map((el) => ({ text: (el.textContent || "").trim() })),
  };
}`;
