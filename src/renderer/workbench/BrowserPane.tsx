import { FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import type { BrowserActionInput, BrowserState } from "../../shared/browserControl";

/** DOM chrome around the isolated native WebContentsView owned by this member. */
export function BrowserPane({ partyId, member }: { partyId: string; member: string }) {
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
    let disposed = false;
    let frame = 0;
    let modalOpen = Boolean(document.querySelector('.wb-modal-scrim, [role="dialog"][aria-modal="true"]'));
    const show = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed || modalOpen) return;
        const rect = element.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        void act({ action: "show", bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      });
    };
    const observer = new ResizeObserver(show);
    observer.observe(element);
    // Native WebContentsView paints above renderer DOM. Detach it while a
    // dialog is open so it cannot cover the dialog or intercept its clicks.
    const modalObserver = new MutationObserver(() => {
      const next = Boolean(document.querySelector('.wb-modal-scrim, [role="dialog"][aria-modal="true"]'));
      if (next === modalOpen) return;
      modalOpen = next;
      if (next) void act({ action: "hide" });
      else show();
    });
    modalObserver.observe(document.body, { childList: true, subtree: true });
    const stopOpenListener = window.agentParty.onBrowserOpenRequested((request) => {
      if (request.partyId === partyId && request.member === member) show();
    });
    show();
    void act({ action: "state" }).then((result) => { if (result && !disposed) setAddress(result.state.url); });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      modalObserver.disconnect();
      stopOpenListener();
      void window.agentParty.browserAction(partyId, member, { action: "hide" });
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
      </div>
      {error && <div className="wb-browser-error" role="alert">{error}</div>}
      <div className="wb-browser-viewport" ref={viewport} aria-label={`${member} 브라우저 화면`} />
    </div>
  );
}
