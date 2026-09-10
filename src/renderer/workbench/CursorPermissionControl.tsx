import { useEffect, useRef, useState } from "react";
import { ChevronDown, Shield, ShieldCheck } from "lucide-react";
import {
  type CursorAgentMode,
  type CursorApprovalMode,
  type CursorPolicy,
} from "../../shared/cursorPolicy";
import { LocalizedText, localized } from "../i18n/I18nProvider";
import { FloatingMenu } from "./FloatingMenu";

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
 *
 * - `popover` (default): compact pill for the composer.
 * - `inline`: always-visible panel for the member wizard (modal overflow would
 *   clip the popover).
 */
export function CursorPermissionControl({
  policy,
  onChange,
  variant = "popover",
}: {
  policy: CursorPolicy;
  onChange: (policy: CursorPolicy) => void;
  variant?: "popover" | "inline";
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CursorPolicy>(policy);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(policy), [policy.mode, policy.approval]);
  function update(next: CursorPolicy) {
    setDraft(next);
    onChange(next);
  }

  const unrestricted = draft.approval === "unrestricted";
  const title = `Mode: ${MODE_LABELS[draft.mode]} · Approval: ${APPROVAL_LABELS[draft.approval]}`;
  const fields = (
    <>
      <div className="wb-codex-perm-head"><LocalizedText id="STR-1634" /></div>
      <div className="wb-axis-grid">
        <label className="wb-field-inline">
          <span>Mode</span>
          <select value={draft.mode} onChange={(event) => update({ ...draft, mode: event.target.value as CursorAgentMode })}>
            {(Object.keys(MODE_LABELS) as CursorAgentMode[]).map((mode) => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}
          </select>
        </label>
        <label className="wb-field-inline">
          <span><LocalizedText id="STR-1635" /></span>
          <select value={draft.approval} onChange={(event) => update({ ...draft, approval: event.target.value as CursorApprovalMode })}>
            {(Object.keys(APPROVAL_LABELS) as CursorApprovalMode[]).map((mode) => <option key={mode} value={mode}>{APPROVAL_LABELS[mode]}</option>)}
          </select>
        </label>
      </div>
      {draft.mode === "ask" && <div className="wb-axis-warn"><LocalizedText id="STR-1636" /></div>}
      {draft.mode === "plan" && <div className="wb-axis-warn"><LocalizedText id="STR-1637" /></div>}
      {unrestricted && <div className="wb-axis-warn"><LocalizedText id="STR-1638" /></div>}
    </>
  );

  if (variant === "inline") {
    return (
      <div className="wb-codex-perm-menu is-inline" role="group" aria-label={localized("STR-1639")}>
        {fields}
      </div>
    );
  }

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
        <FloatingMenu
          anchor={ref.current}
          className="wb-codex-perm-menu"
          role="dialog"
          ariaLabel={localized("STR-1641")}
          onDismiss={() => setOpen(false)}
          drop="up"
          align="right"
        >
          {fields}
        </FloatingMenu>
      )}
    </div>
  );
}
