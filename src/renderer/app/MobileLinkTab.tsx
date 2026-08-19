import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { AlertTriangle, Check, Info as InfoIcon, KeyRound, Link2Off, LockKeyhole, MonitorSmartphone, QrCode, RefreshCw, Server, Smartphone, Trash2, X } from "lucide-react";
import type { DiagnosticReason, GatewayStatus, MobileConnectionLockKind, MobileConnectionLockStatus, MobileSettings, NatDiagnostics, TrustedDevice } from "../../shared/mobileProtocol";
import { ipcErrorMessage } from "./ipcError";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * 설정 → 모바일 연결 (04 §4).
 *
 * Four questions, in the order a user asks them: is the link on, how do I pair
 * a phone, which phones are paired and what are they doing right now, and — when
 * it does not connect — why and what do I do about it.
 */

/** What each diagnostic verdict means for THIS user, and the next thing to try. */
const REASON_GUIDANCE: Record<DiagnosticReason, { title: string; tone: "ok" | "warn" | "bad"; detail: string; next: string }> = {
  ok_direct: {
    title: "직결 가능",
    tone: "ok",
    detail: "공인 IP와 포트 매핑이 모두 확인되었습니다. 폰이 다른 네트워크(LTE·5G)에 있어도 대개 바로 연결됩니다.",
    next: "추가 설정이 필요 없습니다.",
  },
  no_upnp: {
    title: "공유기가 포트 매핑을 거부",
    tone: "warn",
    detail: "공인 IP는 있지만 공유기가 UPnP/NAT-PMP 요청에 응답하지 않았습니다. 연결이 되더라도 폰이 먼저 걸어야 하는 경우가 늘어 실패율이 올라갑니다.",
    next: "공유기 관리 페이지에서 UPnP를 켜세요. 켤 수 없다면 같은 Wi-Fi에서 쓰거나, 아래 포트를 수동으로 포워딩하세요.",
  },
  double_nat: {
    title: "공유기가 두 겹",
    tone: "warn",
    detail: "인터넷 회선과 이 PC 사이에 공유기가 두 대 이상 있습니다. 바깥 공유기가 안쪽 공유기에게 사설 IP를 주고 있어, 안쪽에서 연 포트가 바깥까지 닿지 않습니다.",
    next: "둘 중 하나를 브리지(허브) 모드로 바꾸거나, 이 PC를 바깥쪽 공유기에 직접 연결하세요.",
  },
  cgnat_100_64: {
    title: "통신사 공유 IP (CGNAT)",
    tone: "bad",
    detail: "통신사가 공인 IP 대신 가입자끼리 나눠 쓰는 주소(100.64~100.127 대역)를 주고 있습니다. 외부에서 이 PC로 들어오는 연결을 열 방법이 없습니다.",
    next: "통신사 고객센터에 공인 IP(고정 IP가 아니어도 됩니다)를 요청하세요. 그 전까지는 폰과 PC를 같은 Wi-Fi에 두면 연결됩니다.",
  },
  private_wan: {
    title: "회선이 사설 IP",
    tone: "bad",
    detail: "이 PC의 바깥 주소가 공인 IP가 아닙니다. 회사·학교·기숙사 망이나 상위 장비의 NAT 안에 있을 때 나타납니다.",
    next: "망 관리자에게 문의하거나, 폰과 PC를 같은 네트워크에 두고 사용하세요.",
  },
  symmetric_nat: {
    title: "대칭형 NAT",
    tone: "bad",
    detail: "상대마다 다른 포트를 배정하는 방식이라, 서로의 주소를 미리 알아내는 P2P 방식이 통하지 않습니다. 직결 실패의 가장 흔한 원인입니다.",
    next: "공유기의 NAT 유형을 'full cone'/'개방형'으로 바꿀 수 있는지 확인하세요. 안 되면 같은 Wi-Fi에서 사용하세요.",
  },
  ipv6_only: {
    title: "IPv6 전용 회선",
    tone: "warn",
    detail: "이 PC는 IPv6만 쓰고 있습니다. 폰이 IPv4 전용 망에 있으면 서로 닿을 주소가 없습니다.",
    next: "폰과 PC 모두 IPv6를 쓰는 망이면 연결됩니다. 아니면 같은 Wi-Fi에서 사용하세요.",
  },
  unknown: {
    title: "판단 실패",
    tone: "warn",
    detail: "STUN 응답을 받지 못해 네트워크 종류를 알아내지 못했습니다. 방화벽이 UDP를 막고 있을 수 있습니다.",
    next: "방화벽에서 AgentParty의 UDP 통신을 허용한 뒤 진단을 다시 실행하세요.",
  },
};

/** Phone-facing signaling states in the user's words. */
const SIGNALING_LABEL: Record<GatewayStatus["signaling"], string> = {
  disabled: "꺼짐",
  connecting: "연결 중…",
  authenticating: "인증 중…",
  connected: "대기 중",
  backoff: "재시도 대기",
  failed: "실패",
};

export function MobileLinkCard({ active }: { active: boolean }) {
  const [status, setStatus] = useState<GatewayStatus | undefined>();
  const [settings, setSettings] = useState<MobileSettings | undefined>();
  const [diagnostics, setDiagnostics] = useState<NatDiagnostics | undefined>();
  const [devices, setDevices] = useState<TrustedDevice[]>([]);
  const [qr, setQr] = useState<{ text: string; expiresAt: number } | undefined>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [statusResult, settingsResult, deviceResult] = await Promise.all([
        window.agentParty.getMobileStatus(),
        window.agentParty.getMobileSettings(),
        window.agentParty.listMobileDevices(),
      ]);
      setStatus(statusResult.status);
      setSettings(settingsResult.settings);
      setDevices(deviceResult.devices);
      setDiagnostics(statusResult.status.lastDiagnostics);
      setError("");
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
  }, [active, refresh]);

  // The gateway pushes its own status (pairing phase, sessions, signaling), so
  // the screen follows a phone that connects while nobody is clicking.
  // Read inside the status listener, which is registered once and would
  // otherwise close over the first render's device list.
  const knownDeviceCount = useRef(0);
  useEffect(() => { knownDeviceCount.current = devices.length; }, [devices.length]);

  useEffect(() => {
    const off = window.agentParty.onMobileStatus?.((next) => {
      setStatus(next);
      if (next.lastDiagnostics) setDiagnostics(next.lastDiagnostics);
      // The status carries a device COUNT, not the list, so a pairing that
      // completes (or a revoke from another window) while this screen is open
      // would leave the list below contradicting the count above.
      if (next.trustedDeviceCount !== knownDeviceCount.current) {
        void window.agentParty.listMobileDevices()
          .then((result) => setDevices(result.devices))
          // This refetch is the only thing keeping the list and the count in
          // agreement. Dropping its failure leaves the two contradicting each
          // other on screen with nothing to explain why.
          .catch((cause) => setError(ipcErrorMessage(cause)));
      }
    });
    return () => { off?.(); };
  }, []);

  const pairing = status?.pairing;
  // The pipe owns the pairing lifecycle, so a QR that expired or was cancelled
  // disappears from the screen without this component tracking a timer.
  useEffect(() => {
    if (pairing && pairing.phase !== "awaitingScan" && pairing.phase !== "awaitingConfirm") {
      setQr(undefined);
    }
  }, [pairing?.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(label);
    setError("");
    try {
      await action();
      await refresh();
    } catch (failure) {
      setError(ipcErrorMessage(failure));
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <section className="set-card">
        <div className="set-card-label"><LocalizedText id="STR-0893" /></div>
        <div className="set-inline-note">
          <InfoIcon size={14} />
          <span><LocalizedText id="STR-0896" /> <b><LocalizedText id="STR-0895" /></b>  <LocalizedText id="STR-0894" /></span>
        </div>
        {error && <div className="set-inline-note is-error" role="alert"><AlertTriangle size={14} /><span>{error}</span></div>}
        <div className="set-router-row">
          <span className="set-router-id">
            <span className={"set-dot " + (status?.running ? (status.signaling === "connected" ? "is-success" : status.signaling === "failed" ? "is-error" : "is-idle") : "is-idle")} />
            {status ? (status.running ? SIGNALING_LABEL[status.signaling] : "꺼짐") : "읽는 중…"}
          </span>
          <span className="set-router-end">
            <span className="wb-mono">{status ? `연결된 폰 ${status.sessions.length}대 · 등록 ${status.trustedDeviceCount}대` : ""}</span>
          </span>
        </div>
        {status?.signalingError && (
          <div className="set-inline-note is-error" role="alert"><AlertTriangle size={14} /><span>{status.signalingError}</span></div>
        )}
        <div className="set-harness-pick">
          <button
            type="button"
            className="set-toggle"
            disabled={!settings || Boolean(busy)}
            onClick={() => void run("enabled", () => window.agentParty.updateMobileSettings({ enabled: !settings?.enabled }))}
          >
            <span className={"set-switch" + (settings?.enabled ? " is-on" : "")}><span className="set-switch-knob" /></span>
            <span className="set-toggle-label"><LocalizedText id="STR-0900" /></span>
          </button>
          <span className="set-save-hint"><LocalizedText id="STR-0901" /></span>
        </div>
        {status && status.sessions.length > 0 && (
          <div className="set-link-list">
            {status.sessions.map((session) => (
              <div className="set-link-row" key={session.sessionId}>
                <Smartphone size={14} />
                <span className="set-link-member">{session.deviceName}</span>
                <span className={"mob-activity" + (session.inFlightRequests > 0 ? " is-live" : "")}>
                  {session.inFlightRequests > 0 ? "조작 중" : "대기"}
                  {session.lastRequestMethod ? ` · ${session.lastRequestMethod}` : ""}
                </span>
                <span className="set-link-meta wb-mono">
                  {session.transport === "lanDirect" ? "같은 네트워크 직결" : session.transport === "directViaRendezvous" ? "직결" : "릴레이"}
                  {session.subscribedWorkspaces.length ? ` · 워크스페이스 ${session.subscribedWorkspaces.length}` : ""}
                </span>
                <button
                  type="button"
                  className="set-btn-soft set-btn-disconnect"
                  disabled={Boolean(busy)}
                  onClick={() => void run(session.sessionId, () => window.agentParty.disconnectMobileSession(session.sessionId))}
                >
                  <Link2Off size={14} />  <LocalizedText id="STR-0908" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <ConnectionLockCard
        lock={status?.connectionLock}
        busy={Boolean(busy)}
        onSet={(kind, secret) => run("connection-lock", () => window.agentParty.configureMobileConnectionLock(kind, secret))}
        onClear={() => run("connection-lock", () => window.agentParty.clearMobileConnectionLock())}
      />

      <PairingCard
        pairing={pairing}
        qr={qr}
        busy={busy}
        signaling={status?.running ? status.signaling : undefined}
        signalingUrl={status?.signalingUrl}
        onOpen={() => void run("pair", async () => {
          const opened = await window.agentParty.openMobilePairing();
          setQr({ text: opened.qr, expiresAt: opened.expiresAt });
        })}
        onConfirm={() => void run("confirm", () => window.agentParty.confirmMobilePairing())}
        onCancel={() => void run("cancel", () => window.agentParty.cancelMobilePairing())}
      />

      <section className="set-card">
        <div className="set-card-label"><LocalizedText id="STR-0910" /></div>
        {devices.length === 0 ? (
          <div className="set-inline-note is-soft mob-empty"><InfoIcon size={14} /><span><LocalizedText id="STR-0911" /></span></div>
        ) : (
          <div className="set-link-list">
            {devices.map((device) => (
              <DeviceRow
                key={device.deviceId}
                device={device}
                busy={Boolean(busy)}
                onRename={(name) => void run(device.deviceId, () => window.agentParty.renameMobileDevice(device.deviceId, name))}
                onRevoke={() => void run(device.deviceId, () => window.agentParty.revokeMobileDevice(device.deviceId))}
              />
            ))}
          </div>
        )}
      </section>

      <DiagnosticsCard
        diagnostics={diagnostics}
        busy={busy === "diagnostics"}
        onRun={() => void run("diagnostics", async () => {
          setDiagnostics((await window.agentParty.runMobileDiagnostics()).diagnostics);
        })}
      />

      <ServerCard settings={settings} busy={Boolean(busy)} onSave={(patch) => void run("settings", () => window.agentParty.updateMobileSettings(patch))} />
    </>
  );
}

function ConnectionLockCard({ lock, busy, onSet, onClear }: {
  lock: MobileConnectionLockStatus | undefined;
  busy: boolean;
  onSet: (kind: MobileConnectionLockKind, secret: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [kind, setKind] = useState<MobileConnectionLockKind>("pin");
  const [secret, setSecret] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [validation, setValidation] = useState("");
  const [clearArmed, setClearArmed] = useState(false);
  const valid = kind === "pin"
    ? /^\d{6}$/.test(secret)
    : /^[0-8]{6,9}$/.test(secret) && new Set(secret).size === secret.length;

  async function save() {
    if (!valid) {
      setValidation(kind === "pin" ? "PIN은 숫자 6자리여야 합니다." : "패턴은 서로 다른 점 6~9개를 이어야 합니다.");
      return;
    }
    if (secret !== confirmation) {
      setValidation(kind === "pin" ? "PIN 확인 값이 다릅니다." : "패턴 확인 값이 다릅니다.");
      return;
    }
    setValidation("");
    await onSet(kind, secret);
    setSecret("");
    setConfirmation("");
  }

  function selectKind(next: MobileConnectionLockKind) {
    setKind(next);
    setSecret("");
    setConfirmation("");
    setValidation("");
  }

  return (
    <section className="set-card mob-lock-card">
      <div className="set-card-label"><LocalizedText id="STR-0916" /></div>
      <div className="set-inline-note is-soft">
        <LockKeyhole size={14} />
        <span><LocalizedText id="STR-0917" /></span>
      </div>
      <div className="mob-lock-status">
        <span className={"set-dot " + (lock?.configured ? "is-success" : "is-idle")} />
        <b>{lock?.configured ? `${lock.kind === "pin" ? "6자리 PIN" : "패턴"} 사용 중` : "사용 안 함"}</b>
      </div>
      <div className="mob-lock-kind" role="radiogroup" aria-label={localized("STR-0922")}>
        <button type="button" className={kind === "pin" ? "is-active" : ""} onClick={() => selectKind("pin")}><LocalizedText id="STR-0923" /></button>
        <button type="button" className={kind === "pattern" ? "is-active" : ""} onClick={() => selectKind("pattern")}><LocalizedText id="STR-0924" /></button>
      </div>
      {kind === "pin" ? (
        <div className="set-card-fields mob-lock-fields">
          <label className="set-field">
            <span className="set-field-label"><LocalizedText id="STR-0925" /></span>
            <div className="set-input"><KeyRound size={14} /><input aria-label={localized("STR-0926")} type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={secret} onChange={(event) => setSecret(event.target.value.replace(/\D/g, "").slice(0, 6))} /></div>
          </label>
          <label className="set-field">
            <span className="set-field-label"><LocalizedText id="STR-0927" /></span>
            <div className="set-input"><KeyRound size={14} /><input aria-label={localized("STR-0928")} type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={confirmation} onChange={(event) => setConfirmation(event.target.value.replace(/\D/g, "").slice(0, 6))} /></div>
          </label>
        </div>
      ) : (
        <div className="mob-pattern-pair">
          <PatternInput label={localized("STR-0929")} value={secret} onChange={setSecret} />
          <PatternInput label={localized("STR-0930")} value={confirmation} onChange={setConfirmation} />
        </div>
      )}
      {validation && <div className="set-inline-note is-error" role="alert"><AlertTriangle size={14} /><span>{validation}</span></div>}
      <div className="set-diag-actions">
        <button type="button" className="set-btn-accent" disabled={busy || !valid || secret !== confirmation} onClick={() => void save()}>
          <Check size={14} /> {lock?.configured ? "잠금 변경" : "잠금 설정"}
        </button>
        {lock?.configured && (
          <button type="button" className={"set-btn-soft" + (clearArmed ? " is-armed" : "")} disabled={busy} onClick={() => clearArmed ? void onClear() : setClearArmed(true)} onBlur={() => setClearArmed(false)}>
            <X size={14} /> {clearArmed ? "정말 해제" : "잠금 해제"}
          </button>
        )}
        <span className="set-save-hint"><LocalizedText id="STR-0935" /></span>
      </div>
    </section>
  );
}

function PatternInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [drawing, setDrawing] = useState(false);
  useEffect(() => {
    const stop = () => setDrawing(false);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  const add = (index: number) => {
    const point = String(index);
    if (value.includes(point) || value.length >= 9) return;
    onChange(value + point);
  };

  return (
    <div className="mob-pattern-field">
      <div className="set-field-label">{label} <span>{value.length}/9</span></div>
      <div className="mob-pattern-grid" onPointerLeave={() => setDrawing(false)}>
        {Array.from({ length: 9 }, (_, index) => (
          <button
            type="button"
            key={index}
            aria-label={localized("STR-0936", [index + 1])}
            aria-pressed={value.includes(String(index))}
            className={value.includes(String(index)) ? "is-selected" : ""}
            onPointerDown={(event) => { event.preventDefault(); setDrawing(true); add(index); }}
            onPointerEnter={() => { if (drawing) add(index); }}
          ><span>{value.indexOf(String(index)) >= 0 ? value.indexOf(String(index)) + 1 : ""}</span></button>
        ))}
      </div>
      <button type="button" className="mob-pattern-reset" disabled={!value} onClick={() => onChange("")}><LocalizedText id="STR-0937" /></button>
    </div>
  );
}

/**
 * QR → the phone scans → a 4-digit code appears on BOTH screens → the user
 * confirms they match. The code is what stops a stranger who intercepted the QR
 * from completing the pairing, so it is the loudest thing in this card.
 */
function PairingCard({ pairing, qr, busy, signaling, signalingUrl, onOpen, onConfirm, onCancel }: {
  pairing: GatewayStatus["pairing"] | undefined;
  qr: { text: string; expiresAt: number } | undefined;
  busy: string;
  signaling: GatewayStatus["signaling"] | undefined;
  signalingUrl: string | undefined;
  onOpen: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const phase = pairing?.phase || "idle";
  const open = phase === "awaitingScan" || phase === "awaitingConfirm";
  // The server address travels in the QR and the phone STORES it, so pairing
  // while the link is down can hand the phone an address that does not work.
  //
  // This used to add that the only way out was to unpair and pair again. 01
  // (ddc2563) settled the opposite: the signalling address is NOT part of the
  // trust relationship. The phone keeps an ordered list of addresses and
  // refreshes it from `sys.info` on a live session, so a changed or wrong
  // address is meant to be corrected in place. Telling a user to unpair would
  // send them through a recovery the design exists to avoid.
  //
  // That list is not built yet (mobile-pipe/desktop-pipe own it), so the warning
  // below states the risk without promising either remedy — naming the list
  // today would describe behaviour this build does not have.
  //
  // The pipe already refuses outright when it has NEVER connected. What is left
  // here is the case where it connected before and is retrying now; blocking
  // that would break a working flow over a blip.
  const linkDown = Boolean(signaling && signaling !== "connected");

  return (
    <section className="set-card">
      <div className="set-card-label"><LocalizedText id="STR-0938" /></div>
      {phase === "failed" && pairing?.error && (
        <div className="set-inline-note is-error" role="alert"><AlertTriangle size={14} /><span>{pairing.error}</span></div>
      )}
      {phase === "expired" && (
        <div className="set-inline-note is-warn"><AlertTriangle size={14} /><span><LocalizedText id="STR-0939" /></span></div>
      )}
      {phase === "completed" && (
        <div className="set-inline-note is-success"><Check size={14} /><span><LocalizedText id="STR-0940" /></span></div>
      )}
      {!open && linkDown && (
        <div className="set-inline-note is-warn" role="alert">
          <AlertTriangle size={14} />
          <span>

            <LocalizedText id="STR-0941" />
            {signalingUrl ? ` ${signalingUrl} 주소를` : " 이 주소를"}  <LocalizedText id="STR-0944" />
          </span>
        </div>
      )}
      {!open ? (
        <div className="set-diag-actions">
          <button type="button" className="set-btn-accent" disabled={Boolean(busy)} onClick={onOpen}>
            <QrCode size={14} />  <LocalizedText id="STR-0945" />
          </button>
          <span className="set-save-hint"><LocalizedText id="STR-0946" /></span>
        </div>
      ) : (
        <div className="mob-pair">
          <QrImage text={qr?.text || pairing?.qr || ""} />
          <div className="mob-pair-side">
            {phase === "awaitingScan" ? (
              <>
                <div className="mob-pair-step"><LocalizedText id="STR-0947" /></div>
                <ExpiryCountdown expiresAt={qr?.expiresAt || pairing?.expiresAt} />
              </>
            ) : (
              <>
                <div className="mob-pair-step">
                  <b>{pairing?.peerName || "폰"}</b><LocalizedText id="STR-0948" />
                </div>
                <div className="mob-code wb-mono" aria-label={localized("STR-0949")}>{pairing?.code}</div>
                <div className="set-inline-note is-warn">
                  <AlertTriangle size={14} />
                  <span><LocalizedText id="STR-0950" /> <b><LocalizedText id="STR-0951" /></b><LocalizedText id="STR-0952" /></span>
                </div>
              </>
            )}
            <div className="set-diag-actions">
              {phase === "awaitingConfirm" && (
                <button type="button" className="set-btn-accent" disabled={Boolean(busy)} onClick={onConfirm}>
                  <Check size={14} />  <LocalizedText id="STR-0953" />
                </button>
              )}
              <button type="button" className="set-btn-soft" disabled={Boolean(busy)} onClick={onCancel}>
                <X size={14} />  <LocalizedText id="STR-0954" />
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** Renders the pairing URI as a scannable QR. */
function QrImage({ text }: { text: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failure, setFailure] = useState("");

  useEffect(() => {
    if (!canvas.current || !text) return;
    // Fixed high error correction: the code is read off a screen at an angle,
    // often with a reflection across it.
    QRCode.toCanvas(canvas.current, text, { errorCorrectionLevel: "M", margin: 1, width: 208, color: { dark: "#000000", light: "#ffffff" } })
      .then(() => setFailure(""))
      .catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
  }, [text]);

  // A QR that failed to draw must say so — a blank white square reads as "scan
  // me" and would have the user waiting on a code that can never arrive.
  if (failure) {
    return (
      <div className="mob-qr is-error" role="alert">
        <AlertTriangle size={16} />
        <span><LocalizedText id="STR-0955" /> {failure}</span>
        <code className="mob-qr-fallback">{text}</code>
      </div>
    );
  }
  return <div className="mob-qr"><canvas ref={canvas} /></div>;
}

function ExpiryCountdown({ expiresAt }: { expiresAt: number | undefined }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!expiresAt) return null;
  const left = Math.max(0, Math.round((expiresAt - now) / 1000));
  return <div className="mob-expiry wb-mono">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}  <LocalizedText id="STR-0956" /></div>;
}

function DeviceRow({ device, busy, onRename, onRevoke }: {
  device: TrustedDevice;
  busy: boolean;
  onRename: (name: string) => void;
  onRevoke: () => void;
}) {
  const [name, setName] = useState(device.name);
  const [armed, setArmed] = useState(false);
  useEffect(() => { setName(device.name); }, [device.name]);

  return (
    <div className="set-link-row mob-device-row">
      <Smartphone size={14} />
      <div className="set-input mob-name">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => { if (name.trim() && name !== device.name) onRename(name.trim()); }}
          aria-label={localized("STR-0957")}
        />
      </div>
      <span className="set-link-meta wb-mono">
        {device.push ? "알림 등록됨 · " : ""}<LocalizedText id="STR-0958" /> {formatWhen(device.lastSeenAt)}
      </span>
      <button
        type="button"
        className={"set-btn-soft set-btn-disconnect" + (armed ? " is-armed" : "")}
        disabled={busy}
        onClick={() => (armed ? onRevoke() : setArmed(true))}
        onBlur={() => setArmed(false)}
      >
        <Trash2 size={14} /> {armed ? "정말 삭제" : "기기 삭제"}
      </button>
    </div>
  );
}

function DiagnosticsCard({ diagnostics, busy, onRun }: { diagnostics: NatDiagnostics | undefined; busy: boolean; onRun: () => void }) {
  const guidance = diagnostics ? REASON_GUIDANCE[diagnostics.reason] || REASON_GUIDANCE.unknown : undefined;
  return (
    <section className="set-card">
      <div className="set-card-label"><LocalizedText id="STR-0962" /></div>
      {!diagnostics ? (
        <div className="set-inline-note is-soft">
          <InfoIcon size={14} />
          <span><LocalizedText id="STR-0963" /></span>
        </div>
      ) : (
        <>
          <div className={"set-inline-note " + (guidance!.tone === "ok" ? "is-success" : guidance!.tone === "bad" ? "is-error" : "is-warn")}>
            {guidance!.tone === "ok" ? <Check size={14} /> : <AlertTriangle size={14} />}
            <span><b>{guidance!.title}</b> — {guidance!.detail}</span>
          </div>
          <div className="set-inline-note"><InfoIcon size={14} /><span>{guidance!.next}</span></div>
          <div className="set-diag-row">
            <span className="set-diag-key"><LocalizedText id="STR-0964" /></span>
            <span className="set-diag-value wb-mono">{diagnostics.wanAddress || "확인되지 않음"}{diagnostics.wanIsPrivate ? " (사설)" : ""}</span>
          </div>
          <div className="set-diag-row">
            <span className="set-diag-key"><LocalizedText id="STR-0967" /></span>
            <span className="set-diag-value wb-mono">
              {diagnostics.portMapping
                ? `${diagnostics.portMapping.via} · ${diagnostics.portMapping.externalAddress || "?"}:${diagnostics.portMapping.externalPort}`
                : "없음"}
            </span>
          </div>
          {diagnostics.probes.map((probe) => (
            <div className="set-diag-row" key={probe.name}>
              <span className="set-diag-key">{probe.ok ? "✓" : "✗"} {probe.name}</span>
              <span className="set-diag-value wb-mono">{probe.detail} · {probe.elapsedMs}ms</span>
            </div>
          ))}
          {/* Never swallowed: a probe that failed is why the verdict may be wrong. */}
          {diagnostics.errors.map((message, index) => (
            <div className="set-inline-note is-error" key={index} role="alert"><AlertTriangle size={14} /><span>{message}</span></div>
          ))}
        </>
      )}
      <div className="set-diag-actions">
        <button type="button" className="set-btn-soft" disabled={busy} onClick={onRun}>
          <RefreshCw size={14} /> {busy ? "진단 중…" : "진단 실행"}
        </button>
      </div>
    </section>
  );
}

/** Staged, not apply-on-change: repointing a live link mid-keystroke is worse. */
function ServerCard({ settings, busy, onSave }: { settings: MobileSettings | undefined; busy: boolean; onSave: (patch: Partial<MobileSettings>) => void }) {
  const [signalingUrl, setSignalingUrl] = useState("");
  const [pushUrl, setPushUrl] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSignalingUrl(settings?.signalingUrl || "");
    setPushUrl(settings?.pushUrl || "");
    setDeviceName(settings?.deviceName || "");
  }, [settings?.signalingUrl, settings?.pushUrl, settings?.deviceName]);

  const dirty = Boolean(settings) && (
    signalingUrl !== settings!.signalingUrl || pushUrl !== settings!.pushUrl || deviceName !== settings!.deviceName
  );

  return (
    <section className="set-card">
      <div className="set-card-label"><LocalizedText id="STR-0971" /></div>
      <div className="set-inline-note is-soft">
        <InfoIcon size={14} />
        <span><LocalizedText id="STR-0972" /></span>
      </div>
      <div className="set-card-fields">
        <label className="set-field">
          <span className="set-field-label"><LocalizedText id="STR-0973" /></span>
          <div className="set-input">
            <Server size={14} />
            <input placeholder="wss://sig.agentparty.app" value={signalingUrl} onChange={(event) => setSignalingUrl(event.target.value)} />
          </div>
        </label>
        <label className="set-field">
          <span className="set-field-label"><LocalizedText id="STR-0974" /></span>
          <div className="set-input">
            <Server size={14} />
            <input placeholder="https://push.agentparty.app" value={pushUrl} onChange={(event) => setPushUrl(event.target.value)} />
          </div>
        </label>
        <label className="set-field">
          <span className="set-field-label"><LocalizedText id="STR-0975" /></span>
          <div className="set-input">
            <MonitorSmartphone size={14} />
            <input placeholder={localized("STR-0976")} value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
          </div>
        </label>
      </div>
      <div className="set-harness-pick">
        <button
          type="button"
          className="set-toggle"
          disabled={!settings || busy}
          onClick={() => onSave({ natMappingEnabled: !settings?.natMappingEnabled })}
        >
          <span className={"set-switch" + (settings?.natMappingEnabled ? " is-on" : "")}><span className="set-switch-knob" /></span>
          <span className="set-toggle-label"><LocalizedText id="STR-0977" /></span>
        </button>
        <span className="set-save-hint"><LocalizedText id="STR-0978" /></span>
      </div>
      <div className="set-diag-actions">
        <button
          type="button"
          className={"set-btn-accent" + (saved ? " is-saved" : "")}
          disabled={!dirty || busy}
          onClick={() => {
            onSave({ signalingUrl: signalingUrl.trim(), pushUrl: pushUrl.trim(), deviceName: deviceName.trim() });
            setSaved(true);
            setTimeout(() => setSaved(false), 1500);
          }}
        >
          <Check size={14} /> {saved ? "저장됨" : "저장"}
        </button>
        <span className="set-save-hint"><LocalizedText id="STR-0981" /></span>
      </div>
    </section>
  );
}

function formatWhen(at: number | undefined): string {
  if (!at) return "없음";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}시간 전`;
  return new Date(at).toLocaleDateString();
}
