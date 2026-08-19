import { useEffect, useState } from "react";
import { AlertTriangle, Link2Off, Smartphone } from "lucide-react";
import type { GatewayStatus } from "../../shared/mobileProtocol";
import { ipcErrorMessage } from "../app/ipcError";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * Titlebar indicator for "a phone is connected to this desktop" (04 §성능·안전).
 *
 * Renders NOTHING when no phone is connected, so the titlebar stays quiet on
 * the overwhelmingly common case. When one IS connected it says which phone and
 * lights up while a request is actually in flight — the desktop must never be
 * acted on invisibly — and the same control cuts the session immediately.
 *
 * Fed by the `mobile:status` push, the same value `GET /api/mobile/status`
 * returns, so this pill and the 모바일 연결 tab cannot disagree.
 */
export function MobileDrivingPill() {
  const [status, setStatus] = useState<GatewayStatus | undefined>();
  const [cutting, setCutting] = useState("");
  const [error, setError] = useState("");

  function probe() {
    setError("");
    void window.agentParty.getMobileStatus?.()
      .then((result) => setStatus(result?.status))
      // Never swallowed. This pill is a safety indicator — its silence is a
      // claim that no phone is driving the desktop. If the probe failed we do
      // not know that, and rendering nothing would state it anyway.
      .catch((cause) => setError(ipcErrorMessage(cause)));
  }

  useEffect(() => {
    probe();
    const off = window.agentParty.onMobileStatus?.((next) => {
      setError("");
      setStatus(next);
    });
    return () => { off?.(); };
  }, []);

  if (error) {
    return (
      <button
        type="button"
        className="wb-mobile-pill is-error"
        title={localized("STR-1840", [error])}
        onClick={probe}
      >
        <AlertTriangle size={13} />
        <span><LocalizedText id="STR-1841" /></span>
      </button>
    );
  }

  const sessions = status?.sessions || [];
  if (sessions.length === 0) {
    return null;
  }
  const driving = sessions.filter((session) => session.inFlightRequests > 0);
  const active = driving[0] || sessions[0];
  const busy = driving.length > 0;
  const label = sessions.length > 1
    ? `폰 ${sessions.length}대`
    : active.deviceName;

  async function cut() {
    setCutting(active.sessionId);
    try {
      const result = await window.agentParty.disconnectMobileSession(active.sessionId);
      setStatus(result.status);
    } catch (cause) {
      // A cut that failed leaves the phone still attached. Saying nothing here
      // would let the user believe they had disconnected it.
      setError(ipcErrorMessage(cause));
    } finally {
      setCutting("");
    }
  }

  return (
    <button
      type="button"
      className={"wb-mobile-pill" + (busy ? " is-live" : "")}
      title={busy
        ? localized("STR-1843", [active.deviceName, active.lastRequestMethod ? ` — ${active.lastRequestMethod}` : ""])
        : localized("STR-1844", [active.deviceName])}
      disabled={Boolean(cutting)}
      onClick={() => void cut()}
    >
      <Smartphone size={13} />
      <span>{busy ? `${label} 조작 중` : label}</span>
      <Link2Off size={12} className="wb-mobile-pill-cut" />
    </button>
  );
}
