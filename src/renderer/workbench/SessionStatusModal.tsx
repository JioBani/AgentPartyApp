import { Activity, X } from "lucide-react";
import { harnessForRuntime, harnessLabel } from "../../shared/types";
import { statusLabel } from "./memberStatus";
import type { MemberView } from "./types";
import { LocalizedText, localized } from "../i18n/I18nProvider";
import { useModalEscape } from "./useModalEscape";

function tokens(value: number | undefined): string {
  if (value == null) return "—";
  return value >= 1_000 ? `${Math.round(value / 1_000)}K` : String(value);
}

/** Visible replacement for /status; all values come from the live MemberView/API snapshot. */
export function SessionStatusModal({ view, onClose }: { view: MemberView; onClose: () => void }) {
  useModalEscape(onClose);
  const harness = harnessForRuntime(view.member.runtime);
  const snapshot = view.session?.snapshot;
  const rows = [
    ["상태", statusLabel(view.status)],
    ["하네스", harnessLabel(harness)],
    ["모델", view.model || "—"],
    ["추론 강도", view.effort || "—"],
    ["턴", String(snapshot?.turnCount ?? 0)],
    ["승인 대기", String(snapshot?.pendingApprovalCount ?? (view.pendingApproval ? 1 : 0))],
    ["메시지 대기", String(view.member.queue?.items?.length ?? snapshot?.queuedTurnCount ?? 0)],
    ["컨텍스트", view.context?.total ? `${tokens(view.context.used)} / ${tokens(view.context.total)}` : tokens(view.context?.used)],
  ];
  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-modal-sm wb-command-modal" role="dialog" aria-modal="true" aria-label={localized("STR-2126")}>
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <Activity size={16} />
            <strong><LocalizedText id="STR-2127" /></strong>
            <span className="wb-modal-target" style={{ ["--member" as string]: view.color }}><span className="wb-dot" /> {view.name}</span>
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-2128")} onClick={onClose}><X size={16} /></button>
        </header>
        <div className="wb-modal-body wb-command-status-grid">
          {rows.map(([label, value]) => (
            <div className="wb-command-status-row" key={label}><span>{label}</span><strong className="wb-mono">{value}</strong></div>
          ))}
        </div>
        <footer className="wb-modal-foot wb-modal-foot-end">
          <button type="button" className="wb-btn wb-btn-accent" onClick={onClose}><LocalizedText id="STR-2129" /></button>
        </footer>
      </div>
    </div>
  );
}
