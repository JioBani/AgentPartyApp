import { createHash } from "node:crypto";
import { BrowserWindow, WebContentsView } from "electron";
import type { BrowserActionInput, BrowserActionResult, BrowserControlPort, BrowserState } from "../shared/browserControl";

interface BrowserEntry {
  partyId: string;
  member: string;
  view: WebContentsView;
  owner?: BrowserWindow;
}

/** The app UI and untrusted websites never share a WebContents or preload. */
export class EmbeddedBrowserHost implements BrowserControlPort {
  private readonly entries = new Map<string, BrowserEntry>();

  constructor(private readonly options: {
    resolveWindow: (windowId?: string) => BrowserWindow | undefined;
    onState: (state: BrowserState) => void;
    onOpenRequested: (partyId: string, member: string) => void;
  }) {}

  async action(partyId: string, member: string, input: BrowserActionInput, windowId?: string): Promise<BrowserActionResult> {
    if (input.action === "state") return { ok: true, state: this.state(partyId, member) };
    if (input.action === "close") {
      this.close(partyId, member);
      return { ok: true, state: this.state(partyId, member) };
    }
    if (input.action === "hide") {
      const entry = this.entries.get(this.key(partyId, member));
      if (entry && (!windowId || entry.owner === this.options.resolveWindow(windowId))) this.detach(entry);
      return { ok: true, state: this.state(partyId, member) };
    }

    const entry = this.ensure(partyId, member);
    const contents = entry.view.webContents;
    switch (input.action) {
      case "tab":
        this.options.onOpenRequested(partyId, member);
        break;
      case "show": {
        const window = this.options.resolveWindow(windowId);
        if (!window || window.isDestroyed()) throw new Error("The browser tab needs an open AgentParty window.");
        const bounds = input.bounds;
        if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
          || bounds.width < 1 || bounds.height < 1) throw new Error("Invalid browser tab bounds.");
        if (entry.owner !== window) {
          this.detach(entry);
          window.contentView.addChildView(entry.view);
          entry.owner = window;
        }
        entry.view.setBounds({
          x: Math.round(bounds.x), y: Math.round(bounds.y),
          width: Math.round(bounds.width), height: Math.round(bounds.height),
        });
        break;
      }
      case "open": {
        const target = this.safeUrl(input.url);
        this.options.onOpenRequested(partyId, member);
        await contents.loadURL(target);
        break;
      }
      case "back":
        if (contents.canGoBack()) contents.goBack();
        break;
      case "forward":
        if (contents.canGoForward()) contents.goForward();
        break;
      case "reload":
        contents.reload();
        break;
      case "click": {
        this.requireVisible(entry);
        const { x, y } = this.point(input, entry);
        contents.sendInputEvent({ type: "mouseMove", x, y });
        contents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        contents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
        break;
      }
      case "type":
        this.requireVisible(entry);
        if (typeof input.text !== "string" || input.text.length > 10_000) throw new Error("text must be a string of at most 10,000 characters.");
        contents.insertText(input.text);
        break;
      case "scroll": {
        this.requireVisible(entry);
        const { x, y } = this.point(input, entry, true);
        const deltaY = input.deltaY;
        if (typeof deltaY !== "number" || !Number.isFinite(deltaY) || Math.abs(deltaY) > 10_000) {
          throw new Error("deltaY must be a finite number between -10000 and 10000.");
        }
        // A synthetic Electron wheel reports success even when Chromium does
        // not deliver it to this offscreen child view. Scroll the hit-tested
        // page container directly and return the *applied* distance instead.
        const appliedY = await contents.executeJavaScript(`(() => {
          const point = document.elementFromPoint(${x}, ${y});
          const root = document.scrollingElement;
          let target = point;
          while (target && target !== document.body && target !== document.documentElement) {
            const style = getComputedStyle(target);
            if (/(auto|scroll|overlay)/.test(style.overflowY) && target.scrollHeight > target.clientHeight) break;
            target = target.parentElement;
          }
          const scrollable = target && target !== document.body && target !== document.documentElement ? target : root;
          if (!scrollable) return 0;
          const before = scrollable.scrollTop;
          scrollable.scrollTop += ${deltaY};
          return scrollable.scrollTop - before;
        })()`);
        return { ok: true, state: this.state(partyId, member), scroll: { requestedY: deltaY, appliedY: Number(appliedY) } };
      }
      case "snapshot": {
        const snapshot = await contents.executeJavaScript(`(() => {
          const text = (document.body?.innerText || '').slice(0, 24000);
          const controls = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[tabindex]')]
            .filter(el => {
              const r = el.getBoundingClientRect();
              return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
                && r.left < innerWidth && r.top < innerHeight;
            })
            .slice(0, 150).map(el => {
              const r = el.getBoundingClientRect();
              return { tag: el.tagName.toLowerCase(), label: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').trim().slice(0, 100), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
            });
          return JSON.stringify({ url: location.href, title: document.title, text, controls });
        })()`);
        return { ok: true, state: this.state(partyId, member), snapshot: String(snapshot) };
      }
      case "screenshot": {
        this.requireVisible(entry);
        const png = (await contents.capturePage()).toPNG();
        if (!png.length) throw new Error("The browser returned an empty screenshot.");
        return { ok: true, state: this.state(partyId, member), image: { mimeType: "image/png", dataBase64: png.toString("base64") } };
      }
    }
    const state = this.state(partyId, member);
    this.options.onState(state);
    return { ok: true, state };
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      this.detach(entry);
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    }
    this.entries.clear();
  }

  private key(partyId: string, member: string): string { return `${partyId}\u0000${member}`; }

  private ensure(partyId: string, member: string): BrowserEntry {
    const key = this.key(partyId, member);
    const existing = this.entries.get(key);
    if (existing && !existing.view.webContents.isDestroyed()) return existing;
    const partition = `agentparty-browser-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    const view = new WebContentsView({ webPreferences: {
      partition, sandbox: true, nodeIntegration: false, contextIsolation: true,
      webSecurity: true, backgroundThrottling: false,
    } });
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        void view.webContents.loadURL(this.safeUrl(url)).catch((error) => {
          console.error("[browser] popup navigation failed", error);
        });
      } catch (error) {
        console.warn("[browser] blocked popup URL", error);
      }
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      try { this.safeUrl(url); } catch { event.preventDefault(); }
    });
    const entry: BrowserEntry = { partyId, member, view };
    const report = () => this.options.onState(this.state(partyId, member));
    view.webContents.on("did-start-loading", report);
    view.webContents.on("did-stop-loading", report);
    view.webContents.on("page-title-updated", report);
    view.webContents.on("did-navigate", report);
    view.webContents.on("did-navigate-in-page", report);
    this.entries.set(key, entry);
    return entry;
  }

  private safeUrl(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim()) throw new Error("A URL is required.");
    const url = new URL(raw.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) pages can open in the browser tab.");
    return url.toString();
  }

  private state(partyId: string, member: string): BrowserState {
    const entry = this.entries.get(this.key(partyId, member));
    const contents = entry?.view.webContents;
    return {
      partyId, member, url: contents && !contents.isDestroyed() ? contents.getURL() : "",
      title: contents && !contents.isDestroyed() ? contents.getTitle() : "",
      loading: Boolean(contents && !contents.isDestroyed() && contents.isLoadingMainFrame()),
      visible: Boolean(entry?.owner && !entry.owner.isDestroyed()),
      canGoBack: Boolean(contents && !contents.isDestroyed() && contents.canGoBack()),
      canGoForward: Boolean(contents && !contents.isDestroyed() && contents.canGoForward()),
    };
  }

  private point(input: BrowserActionInput, entry: BrowserEntry, defaultCenter = false): { x: number; y: number } {
    const bounds = entry.view.getBounds();
    const x = defaultCenter && input.x === undefined ? Math.floor(bounds.width / 2) : input.x;
    const y = defaultCenter && input.y === undefined ? Math.floor(bounds.height / 2) : input.y;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)
      || x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) {
      throw new Error(`Coordinates must be inside the visible browser viewport (${bounds.width} x ${bounds.height}).`);
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  private requireVisible(entry: BrowserEntry): void {
    if (!entry.owner || entry.owner.isDestroyed()) throw new Error("Open this member's Browser tab in AgentParty before controlling it.");
  }

  private detach(entry: BrowserEntry): void {
    if (entry.owner && !entry.owner.isDestroyed()) entry.owner.contentView.removeChildView(entry.view);
    entry.owner = undefined;
    this.options.onState(this.state(entry.partyId, entry.member));
  }

  private close(partyId: string, member: string): void {
    const key = this.key(partyId, member);
    const entry = this.entries.get(key);
    if (!entry) return;
    this.detach(entry);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    this.entries.delete(key);
    this.options.onState(this.state(partyId, member));
  }
}
