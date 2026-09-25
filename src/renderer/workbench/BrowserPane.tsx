import { FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Combine, RotateCw } from "lucide-react";
import type { BrowserActionInput, BrowserState } from "../../shared/browserControl";

// WebContentsView always paints above the renderer. Detach it whenever an
// in-app overlay crosses the browser viewport, including drag previews.
const APP_OVERLAYS = [
  '.wb-modal-scrim', '[role="dialog"]', '[role="menu"]',
  '.wb-menu-catcher', '.wb-ctx-menu', '.wb-tab-overflow-menu', '.wb-dd-menu',
  '.usage-pop', '.wb-cmd-palette', '.wb-tool-modal-backdrop', '.mcp-modal',
  '.app-toast', '.wb-mention-pop', '.wb-queue-throw',
  '.wb-drop-overlay', '.wb-drop-side', '.wb-drop-outer', '.wb-drag-ghost',
].join(', ');
const activePanes = new Map<string, object>();

function overlayCrosses(viewport: DOMRect): boolean {
  return Array.from(document.querySelectorAll(APP_OVERLAYS)).some((overlay) => {
    const box = overlay.getBoundingClientRect();
    return box.width > 0 && box.height > 0
      && box.left < viewport.right && box.right > viewport.left
      && box.top < viewport.bottom && box.bottom > viewport.top;
  });
}

/** DOM chrome around the isolated native WebContentsView owned by this member. */
export function BrowserPane({ partyId, member, canMerge }: { partyId: string; member: string; canMerge: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserState | null>(null);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const act = useCallback(async (input: BrowserActionInput) => {
    try {
      const result = await window.agentParty.browserAction(partyId, member, input);
      setState(result.state);
      if (input.action !== "state" && input.action !== "show" && input.action !== "hide") setError("");
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return undefined;
    }
  }, [partyId, member]);

  useEffect(() => {
    return window.agentParty.onBrowserState((next) => {
      if (next.partyId === partyId && next.member === member) {
        setState(next);
        setAddress((previous) => document.activeElement?.getAttribute("data-browser-address") === "true" ? previous : next.url);
      }
    });
  }, [partyId, member]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const paneKey = `${partyId}\0${member}`;
    const paneLease = {};
    activePanes.set(paneKey, paneLease);
    let disposed = false;
    let frame = 0;
    let applied = "";
    let pending: Promise<void> | null = null;
    let retryAt = 0;
    const request = (input: BrowserActionInput, target: string) => {
      pending = window.agentParty.browserAction(partyId, member, input)
        .then((result) => {
          if (!disposed) {
            applied = target;
            setState(result.state);
            setError("");
          }
        })
        .catch((cause) => {
          if (!disposed) {
            retryAt = performance.now() + 1000;
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        })
        .finally(() => { pending = null; });
    };
    // ResizeObserver misses a panel that MOVES without changing size (for
    // example, swapping two equal-width grid slots). Measure its position on
    // paint frames, but send IPC only when the rounded bounds actually change.
    const sync = () => {
      if (disposed) return;
      frame = requestAnimationFrame(sync);
      if (pending || performance.now() < retryAt) return;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || overlayCrosses(rect)) {
        if (applied !== "hidden") request({ action: "hide" }, "hidden");
        return;
      }
      const bounds = {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
      };
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
      if (applied !== key) request({ action: "show", bounds }, key);
    };
    const stopOpenListener = window.agentParty.onBrowserOpenRequested((request) => {
      if (request.partyId === partyId && request.member === member) applied = "";
    });
    sync();
    void act({ action: "state" }).then((result) => { if (result && !disposed) setAddress(result.state.url); });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      stopOpenListener();
      if (activePanes.get(paneKey) !== paneLease) return;
      activePanes.delete(paneKey);
      // A moved tab mounts a new pane before the old show IPC settles. The old
      // cleanup must not hide the new pane after its show has completed.
      void (pending || Promise.resolve()).then(() => {
        if (!activePanes.has(paneKey)) return window.agentParty.browserAction(partyId, member, { action: "hide" });
      })
        .catch((cause) => console.error("Failed to detach browser view", cause));
    };
  }, [act, partyId, member]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const raw = address.trim();
    if (!raw) return;
    void act({ action: "open", url: /^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}` });
  };

  return (
    <div className="wb-browser" data-browser-member={member}>
      <div className="wb-browser-controls">
        <button type="button" title="뒤로" disabled={!state?.canGoBack} onClick={() => void act({ action: "back" })}><ArrowLeft size={14} /></button>
        <button type="button" title="앞으로" disabled={!state?.canGoForward} onClick={() => void act({ action: "forward" })}><ArrowRight size={14} /></button>
        <button type="button" title="새로고침" onClick={() => void act({ action: "reload" })}><RotateCw size={14} /></button>
        <form onSubmit={navigate}>
          <input data-browser-address="true" aria-label="브라우저 주소" value={address} onChange={(event) => setAddress(event.target.value)} placeholder="https://example.com" spellCheck={false} />
        </form>
        <button type="button" className="wb-browser-merge" aria-label="멤버 탭과 합치기" title={canMerge ? "멤버 탭과 합치기" : "이미 멤버 탭과 같은 패널입니다"} disabled={!canMerge} onClick={() => void act({ action: "merge" })}>
          <Combine size={14} /><span className="wb-browser-merge-label">멤버 탭과 합치기</span>
        </button>
      </div>
      {error && <div className="wb-browser-error" role="alert">{error}</div>}
      <div className="wb-browser-viewport" ref={viewport} aria-label={`${member} 브라우저 화면`} />
    </div>
  );
}
