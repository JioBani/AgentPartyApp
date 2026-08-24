import { useEffect, useState } from "react";
import { Check, Clipboard, SquareTerminal, X } from "lucide-react";
import type { CliContinuationDetails, CliContinuationResult } from "../../shared/cliContinuation";
import { LocalizedText, localized } from "../i18n/I18nProvider";

interface CliContinuationModalProps {
  member: string;
  color: string;
  onClose: () => void;
}

export function CliContinuationModal({ member, color, onClose }: CliContinuationModalProps) {
  const [result, setResult] = useState<CliContinuationResult | null>(null);
  const [error, setError] = useState("");
  const [launching, setLaunching] = useState(false);
  const [copied, setCopied] = useState<"cwd" | "command" | "both" | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.agentParty.continueMemberInCli(member, "inspect").then(
      (next) => { if (!cancelled) setResult(next); },
      (cause) => { if (!cancelled) setError(messageOf(cause)); },
    );
    return () => { cancelled = true; };
  }, [member]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !launching) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [launching, onClose]);

  const details = result?.supported ? result : undefined;
  const needsCwdRecovery = Boolean(details?.locationProblem);

  async function copy(kind: "cwd" | "command" | "both", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1_500);
    } catch (cause) {
      setError(`클립보드에 복사하지 못했습니다: ${messageOf(cause)}`);
    }
  }

  async function launch() {
    setLaunching(true);
    setError("");
    try {
      const next = await window.agentParty.continueMemberInCli(member, "launch");
      if (!next.supported) {
        setResult(next);
        return;
      }
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="wb-modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !launching) onClose(); }}>
      <div className="wb-modal wb-cli-continuation" role="dialog" aria-modal="true" aria-label={localized("STR-1545", [member])}>
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <SquareTerminal size={17} />
            <strong><LocalizedText id="STR-1546" /></strong>
            <span className="wb-modal-target" style={{ ["--member" as string]: color }}><span className="wb-dot" /> {member}</span>
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-1547")} disabled={launching} onClick={onClose}><X size={16} /></button>
        </header>

        <div className="wb-cli-body">
          {!result && !error && <div className="wb-cli-loading"><LocalizedText id="STR-1548" /></div>}
          {result && !result.supported && <div className="wb-cli-unavailable"><strong><LocalizedText id="STR-1549" /></strong><span>{result.reason}</span></div>}

          {details && (
            <>
              {needsCwdRecovery ? (
                <div className="wb-cli-location-recovery" role="status">
                  <strong>저장된 작업 폴더를 사용할 수 없습니다.</strong>
                  <span>{details.locationProblem?.message}: {details.cwd}</span>
                  <small>새 작업 폴더 경로로 아래 명령의 예시 경로를 바꾼 뒤 터미널에서 실행하세요. AgentParty 세션은 종료하지 않으므로, 명령을 직접 실행하기 전 이 멤버 탭을 닫아 중복 실행을 막아야 합니다. 대기 메시지는 CLI로 옮겨지지 않고 앱 큐에 남습니다.</small>
                </div>
              ) : (
                <button type="button" className="wb-cli-option is-primary" disabled={launching} onClick={launch}>
                  <SquareTerminal size={20} />
                  <span><strong>{launching ? "터미널을 여는 중…" : "기본 터미널에서 바로 이어가기"}</strong><small><LocalizedText id="STR-1552" /></small></span>
                </button>
              )}

              <section className="wb-cli-option is-command">
                <div className="wb-cli-option-head">
                  <span><Clipboard size={18} /><span><strong>{needsCwdRecovery ? "새 작업 폴더에서 이어가기" : <LocalizedText id="STR-1554" />}</strong><small><LocalizedText id="STR-1553" /></small></span></span>
                  <button type="button" className="wb-btn" onClick={() => copy("both", copyBundle(details))}>
                    {copied === "both" ? <Check size={13} /> : <Clipboard size={13} />} {copied === "both" ? "복사됨" : "모두 복사"}
                  </button>
                </div>
                <CopyRow label={needsCwdRecovery ? "사용 불가 cwd" : details.host === "wsl" ? `cwd · WSL ${details.distro}` : "cwd"} value={details.cwd} copied={copied === "cwd"} onCopy={() => copy("cwd", details.cwd)} />
                <CopyRow label={needsCwdRecovery ? "새 cwd 명령 예시" : localized("STR-1557")} value={details.repairCommand || details.command} copied={copied === "command"} onCopy={() => copy("command", details.repairCommand || details.command)} />
              </section>

              <p className="wb-cli-warning"><LocalizedText id="STR-1558" /></p>
              <p className="wb-cli-sync-note"><LocalizedText id="STR-1559" /></p>
              {needsCwdRecovery && <p className="wb-cli-sync-note">CLI에서 사용한 새 cwd는 AgentParty 멤버 위치에 자동 반영되지 않습니다. 이후 앱에서 다시 재개하려면 원래 경로를 복구해야 하며, 그렇지 않으면 이 대화는 CLI에서 계속 사용하세요.</p>}
            </>
          )}

          {error && <div className="wb-cli-error" role="alert">{error}</div>}
        </div>
      </div>
    </div>
  );
}

function CopyRow({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="wb-cli-copy-row">
      <span>{label}</span>
      <code>{value}</code>
      <button type="button" className="wb-icon-btn" title={localized("STR-1560", [label])} onClick={onCopy}>{copied ? <Check size={14} /> : <Clipboard size={14} />}</button>
    </div>
  );
}

function copyBundle(details: CliContinuationDetails): string {
  if (details.locationProblem && details.repairCommand) {
    return `unavailable cwd: ${details.cwd}\nnew cwd command: ${details.repairCommand}`;
  }
  return `cwd: ${details.cwd}\ncommand: ${details.command}`;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value || "알 수 없는 오류");
}
