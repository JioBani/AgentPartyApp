import { useEffect, useState } from "react";
import { Link2Off, Smartphone } from "lucide-react";
import type { GatewayStatus } from "../../shared/mobileProtocol";

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

  useEffect(() => {
    void window.agentParty.getMobileStatus?.().then((result) => setStatus(result?.status)).catch(() => undefined);
    const off = window.agentParty.onMobileStatus?.(setStatus);
    return () => { off?.(); };
  }, []);

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
    } finally {
      setCutting("");
    }
  }

  return (
    <button
      type="button"
      className={"wb-mobile-pill" + (busy ? " is-live" : "")}
      title={busy
        ? `${active.deviceName}이(가) 조작 중${active.lastRequestMethod ? ` — ${active.lastRequestMethod}` : ""} · 눌러서 즉시 끊기`
        : `${active.deviceName} 연결됨 · 눌러서 즉시 끊기`}
      disabled={Boolean(cutting)}
      onClick={() => void cut()}
    >
      <Smartphone size={13} />
      <span>{busy ? `${label} 조작 중` : label}</span>
      <Link2Off size={12} className="wb-mobile-pill-cut" />
    </button>
  );
}
