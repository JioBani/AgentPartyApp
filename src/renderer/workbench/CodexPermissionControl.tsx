import { useEffect, useRef, useState } from "react";
import { ChevronDown, Shield, ShieldCheck } from "lucide-react";
import {
  ApprovalPolicy,
  CODEX_PRESETS,
  CODEX_PRESET_LABELS,
  CodexPolicy,
  SandboxMode,
  codexPresetOf,
} from "../../shared/codexPolicy";

const SANDBOX_SHORT: Record<SandboxMode, string> = { "read-only": "read", "workspace-write": "write", "danger-full-access": "full" };
const APPROVAL_SHORT: Record<ApprovalPolicy, string> = { untrusted: "untrusted", "on-request": "ask", never: "never" };
const SANDBOX_LABELS: Record<SandboxMode, string> = { "read-only": "Read only", "workspace-write": "Workspace write", "danger-full-access": "Full access" };
const APPROVAL_LABELS: Record<ApprovalPolicy, string> = { untrusted: "Untrusted", "on-request": "On request", never: "Never" };

/**
 * Codex safety control — the two-axis (sandbox × approval) counterpart to
 * Claude's single permission-mode dropdown.
 *
 * - `popover` (default): compact pill for the composer; menu opens upward.
 * - `inline`: always-visible panel for the member wizard (modal overflow would
 *   clip the popover).
 */
export function CodexPermissionControl({
  policy,
  onChange,
  variant = "popover",
}: {
  policy: CodexPolicy;
  onChange: (policy: CodexPolicy) => void;
  variant?: "popover" | "inline";
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CodexPolicy>(policy);
  const ref = useRef<HTMLDivElement>(null);

  // Re-sync when the live policy changes elsewhere (e.g. the harness reports it).
  useEffect(() => {
    setDraft(policy);
  }, [policy.sandbox, policy.approval, policy.guardian]);

  useEffect(() => {
    if (!open || variant === "inline") {
      return;
    }
    function onPointer(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, variant]);

  function update(next: CodexPolicy) {
    setDraft(next);
    onChange(next);
  }

  const preset = codexPresetOf(draft);
  const title = `Sandbox: ${SANDBOX_LABELS[draft.sandbox]} · Approval: ${APPROVAL_LABELS[draft.approval]}${draft.guardian ? " · Guardian on" : ""}`;
  const fields = (
    <>
      <div className="wb-codex-perm-head">Sandbox &amp; approvals</div>
      <div className="wb-segmented">
        {(Object.keys(CODEX_PRESETS) as (keyof typeof CODEX_PRESETS)[]).map((key) => (
          <button
            type="button"
            key={key}
            className={"wb-segment" + (preset === key ? " is-active" : "")}
            onClick={() => update({ ...draft, ...CODEX_PRESETS[key] })}
          >
            {CODEX_PRESET_LABELS[key]}
          </button>
        ))}
        {/* A combination that matches no preset is a REAL state (codexPresetOf
            returns "custom"), and without it the strip simply went blank — which
            this codebase treats as "reads as broken", not as "nothing selected".
            Deliberately NOT a button: there is no value to apply, so it must not
            invite a click. It only appears while that state is actually held. */}
        {preset === "custom" && <span className="wb-segment is-state">{CODEX_PRESET_LABELS.custom}</span>}
      </div>
      <div className="wb-axis-grid">
        <label className="wb-field-inline">
          <span>Sandbox</span>
          <select value={draft.sandbox} onChange={(event) => update({ ...draft, sandbox: event.target.value as SandboxMode })}>
            {(Object.keys(SANDBOX_LABELS) as SandboxMode[]).map((mode) => <option key={mode} value={mode}>{SANDBOX_LABELS[mode]}</option>)}
          </select>
        </label>
        <label className="wb-field-inline">
          <span>Approval</span>
          <select value={draft.approval} onChange={(event) => update({ ...draft, approval: event.target.value as ApprovalPolicy })}>
            {(Object.keys(APPROVAL_LABELS) as ApprovalPolicy[]).map((mode) => <option key={mode} value={mode}>{APPROVAL_LABELS[mode]}</option>)}
          </select>
        </label>
      </div>
      {draft.sandbox === "danger-full-access" && <div className="wb-axis-warn">Full access removes the sandbox — Codex can touch anything.</div>}
      <label className="wb-toggle-card wb-codex-guardian">
        <span className="wb-toggle-text">
          <ShieldCheck size={15} />
          <span><strong>Guardian</strong><small>위험 행동 사전 심사</small></span>
        </span>
        <input type="checkbox" className="wb-switch" checked={draft.guardian} onChange={(event) => update({ ...draft, guardian: event.target.checked })} />
      </label>
    </>
  );

  if (variant === "inline") {
    return (
      <div className="wb-codex-perm-menu is-inline" role="group" aria-label="Sandbox & approvals">
        {fields}
      </div>
    );
  }

  return (
    <div className="wb-dd" ref={ref}>
      <button type="button" className="wb-pill wb-dd-trigger wb-codex-perm-trigger" title={title} onClick={() => setOpen((value) => !value)}>
        <span className="wb-dd-ic">{draft.guardian ? <ShieldCheck size={14} /> : <Shield size={14} />}</span>
        <span className="wb-dd-label wb-codex-perm-summary">
          <span className="wb-mono">{SANDBOX_SHORT[draft.sandbox]}</span>
          <span className="wb-codex-perm-sep">·</span>
          <span className="wb-mono">{APPROVAL_SHORT[draft.approval]}</span>
        </span>
        <ChevronDown size={11} className="wb-pill-caret" />
      </button>
      {open && (
        <div className="wb-dd-menu drop-up align-right wb-codex-perm-menu" role="dialog" aria-label="Sandbox & approvals">
          {fields}
        </div>
      )}
    </div>
  );
}
