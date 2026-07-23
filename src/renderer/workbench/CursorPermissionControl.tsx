import { useEffect, useRef, useState } from "react";
import { ChevronDown, Shield, ShieldCheck } from "lucide-react";
import {
  type CursorAgentMode,
  type CursorApprovalMode,
  type CursorPolicy,
} from "../../shared/cursorPolicy";

const MODE_LABELS: Record<CursorAgentMode, string> = {
  agent: "Agent",
  ask: "Ask",
  plan: "Plan",
};

const APPROVAL_LABELS: Record<CursorApprovalMode, string> = {
  allowlist: "Allowlist",
  "auto-review": "Auto-review",
  unrestricted: "Run Everything",
};

/**
 * Mirrors Cursor CLI's two controls: agent mode and approval mode. These are
 * intentionally separate from Claude Code permissions and Codex policy.
 */
export function CursorPermissionControl({ policy, onChange }: { policy: CursorPolicy; onChange: (policy: CursorPolicy) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CursorPolicy>(policy);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(policy), [policy.mode, policy.approval]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function update(next: CursorPolicy) {
    setDraft(next);
    onChange(next);
  }

  const unrestricted = draft.approval === "unrestricted";
  const title = `Mode: ${MODE_LABELS[draft.mode]} · Approval: ${APPROVAL_LABELS[draft.approval]}`;
  return (
    <div className="wb-dd" ref={ref}>
      <button type="button" className="wb-pill wb-dd-trigger wb-codex-perm-trigger" title={title} onClick={() => setOpen((value) => !value)}>
        <span className="wb-dd-ic">{unrestricted ? <ShieldCheck size={14} /> : <Shield size={14} />}</span>
        <span className="wb-dd-label wb-codex-perm-summary">
          <span className="wb-mono">{MODE_LABELS[draft.mode]}</span>
          <span className="wb-codex-perm-sep">·</span>
          <span className="wb-mono">{draft.approval === "unrestricted" ? "Run all" : APPROVAL_LABELS[draft.approval]}</span>
        </span>
        <ChevronDown size={11} className="wb-pill-caret" />
      </button>
      {open && (
        <div className="wb-dd-menu drop-up align-right wb-codex-perm-menu" role="dialog" aria-label="Cursor mode and approvals">
          <div className="wb-codex-perm-head">Cursor mode &amp; approvals</div>
          <div className="wb-axis-grid">
            <label className="wb-field-inline">
              <span>Mode</span>
              <select value={draft.mode} onChange={(event) => update({ ...draft, mode: event.target.value as CursorAgentMode })}>
                {(Object.keys(MODE_LABELS) as CursorAgentMode[]).map((mode) => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}
              </select>
            </label>
            <label className="wb-field-inline">
              <span>Approval mode</span>
              <select value={draft.approval} onChange={(event) => update({ ...draft, approval: event.target.value as CursorApprovalMode })}>
                {(Object.keys(APPROVAL_LABELS) as CursorApprovalMode[]).map((mode) => <option key={mode} value={mode}>{APPROVAL_LABELS[mode]}</option>)}
              </select>
            </label>
          </div>
          {draft.mode === "ask" && <div className="wb-axis-warn">Ask is read-only exploration.</div>}
          {draft.mode === "plan" && <div className="wb-axis-warn">Plan analyzes and proposes a plan without edits.</div>}
          {unrestricted && <div className="wb-axis-warn">Run Everything force-allows tools unless explicitly denied.</div>}
        </div>
      )}
    </div>
  );
}
