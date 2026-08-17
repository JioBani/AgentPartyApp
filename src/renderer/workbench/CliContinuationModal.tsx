import { useEffect, useState } from "react";
import { Check, Clipboard, SquareTerminal, X } from "lucide-react";
import type { CliContinuationDetails, CliContinuationResult } from "../../shared/cliContinuation";

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
      <div className="wb-modal wb-cli-continuation" role="dialog" aria-modal="true" aria-label={`${member} CLI로 이어가기`}>
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <SquareTerminal size={17} />
            <strong>CLI로 이어가기</strong>
            <span className="wb-modal-target" style={{ ["--member" as string]: color }}><span className="wb-dot" /> {member}</span>
          </div>
          <button type="button" className="wb-icon-btn" title="닫기" disabled={launching} onClick={onClose}><X size={16} /></button>
        </header>

        <div className="wb-cli-body">
          {!result && !error && <div className="wb-cli-loading">이어갈 대화를 확인하는 중…</div>}
          {result && !result.supported && <div className="wb-cli-unavailable"><strong>이 멤버는 CLI로 이어갈 수 없습니다.</strong><span>{result.reason}</span></div>}

          {details && (
            <>
              <button type="button" className="wb-cli-option is-primary" disabled={launching} onClick={launch}>
                <SquareTerminal size={20} />
                <span><strong>{launching ? "터미널을 여는 중…" : "기본 터미널에서 바로 이어가기"}</strong><small>AgentParty의 세션을 닫고 같은 대화를 새 터미널에서 재개합니다.</small></span>
              </button>

              <section className="wb-cli-option is-command">
                <div className="wb-cli-option-head">
                  <span><Clipboard size={18} /><span><strong>cwd와 명령어 받기</strong><small>직접 터미널을 열어 아래 순서로 실행할 때 사용합니다.</small></span></span>
                  <button type="button" className="wb-btn" onClick={() => copy("both", copyBundle(details))}>
                    {copied === "both" ? <Check size={13} /> : <Clipboard size={13} />} {copied === "both" ? "복사됨" : "모두 복사"}
                  </button>
                </div>
                <CopyRow label={details.host === "wsl" ? `cwd · WSL ${details.distro}` : "cwd"} value={details.cwd} copied={copied === "cwd"} onCopy={() => copy("cwd", details.cwd)} />
                <CopyRow label="이어가기 명령어" value={details.command} copied={copied === "command"} onCopy={() => copy("command", details.command)} />
              </section>

              <p className="wb-cli-warning">같은 대화를 두 프로세스에서 동시에 실행하지 마세요. 명령어를 직접 실행할 때는 먼저 이 멤버의 탭을 닫아 AgentParty 세션을 종료해야 합니다.</p>
              <p className="wb-cli-sync-note">외부 CLI에서 새로 진행한 대화는 현재 AgentParty 대화창에 자동 동기화되지 않습니다. 다시 앱에서 재개하면 모델 컨텍스트는 이어지지만, 외부 턴을 화면에 가져오려면 하네스 원본 기록을 별도로 가져오는 기능이 필요합니다.</p>
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
      <button type="button" className="wb-icon-btn" title={`${label} 복사`} onClick={onCopy}>{copied ? <Check size={14} /> : <Clipboard size={14} />}</button>
    </div>
  );
}

function copyBundle(details: CliContinuationDetails): string {
  return `cwd: ${details.cwd}\ncommand: ${details.command}`;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value || "알 수 없는 오류");
}
