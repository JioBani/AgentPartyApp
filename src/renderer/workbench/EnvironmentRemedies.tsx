import { useState } from "react";
import { AlertTriangle, ArrowRight, Check, CheckCircle2, ChevronDown, CircleDashed, Copy, RefreshCw, Settings2, XCircle } from "lucide-react";
import type { EnvironmentProbeStep, EnvironmentRemedy } from "../../shared/environment";
import { ipcErrorMessage } from "../app/ipcError";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * The buttons that get a user out of a failed environment check.
 *
 * Shared by the 환경 settings tab and the in-transcript blocker card so the two
 * offer the SAME fixes with the same confirmation rules — the transcript card
 * exists precisely so a user never has to go hunting for the settings screen,
 * which only works if pressing the button there does the identical thing.
 */
export function EnvironmentRemedyButtons({ remedies, onRepaired, onOpenEnvironment }: {
  remedies: EnvironmentRemedy[];
  /** Called after a repair finishes, so the host can re-render from the fresh report. */
  onRepaired?: (result: { ok: boolean; detail: string; output?: string }) => void;
  onOpenEnvironment?: (settingsField?: string) => void;
}) {
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState("");

  async function run(remedy: EnvironmentRemedy) {
    if (remedy.kind === "command" && remedy.command) {
      void navigator.clipboard?.writeText(remedy.command);
      setCopied(remedy.command);
      setTimeout(() => setCopied((value) => (value === remedy.command ? "" : value)), 1300);
      return;
    }
    if (remedy.kind === "docs" && remedy.url) {
      void window.agentParty.openExternal(remedy.url);
      return;
    }
    if (remedy.kind === "settings") {
      onOpenEnvironment?.(remedy.settingsField);
      return;
    }
    if (remedy.kind !== "repair" || !remedy.repairId) {
      return;
    }
    // `confirm` is present exactly when the repair changes the USER'S system.
    // The distinction is made by the report, never guessed here.
    if (remedy.confirm && !window.confirm(remedy.confirm)) {
      return;
    }
    setBusy(remedy.repairId);
    try {
      const result = await window.agentParty.repairEnvironment(remedy.repairId);
      onRepaired?.({ ok: result.ok, detail: result.detail, output: result.output });
    } catch (error) {
      onRepaired?.({ ok: false, detail: ipcErrorMessage(error) });
    } finally {
      setBusy("");
    }
  }

  function button(remedy: EnvironmentRemedy) {
        const running = remedy.kind === "repair" && busy === remedy.repairId;
        const justCopied = remedy.kind === "command" && copied === remedy.command;
        return (
          <button
            type="button"
            key={remedy.label}
            className={remedy.kind === "repair" ? "set-btn-accent" : "set-btn-soft"}
            data-env-remedy={remedy.repairId || remedy.kind}
            disabled={Boolean(busy)}
            onClick={() => void run(remedy)}
          >
            {justCopied
              ? <Check size={14} />
              : remedy.kind === "command"
                ? <Copy size={14} />
                : remedy.kind === "docs"
                  ? <ArrowRight size={14} />
                  : remedy.kind === "settings"
                    ? <Settings2 size={14} />
                    : <RefreshCw size={14} />}
            {running ? "진행 중…" : justCopied ? "복사됨" : remedy.label}
          </button>
        );
  }

  // A blocker is a small decision, not a toolbar. Keep the most likely fix in
  // front, retain direct path selection as the escape hatch, and fold the
  // command/docs variants away until the user asks for them.
  const primary = remedies[0]?.kind === "settings"
    ? remedies[0]
    : remedies.find((remedy) => remedy.kind === "repair") || remedies[0];
  const settings = remedies.find((remedy) => remedy.kind === "settings" && remedy !== primary);
  const more = remedies.filter((remedy) => remedy !== primary && remedy !== settings);

  return (
    <>
      {primary && button(primary)}
      {settings && button(settings)}
      {more.length > 0 && (
        <details className="set-env-more">
          <summary><LocalizedText id="STR-1651" /></summary>
          <div className="set-env-more-actions">{more.map(button)}</div>
        </details>
      )}
    </>
  );
}

/** The raw CLI output, folded away. Present but never in the user's face. */
export function EnvironmentRawDetail({ raw }: { raw: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="set-env-raw">
      <button type="button" className="set-link-btn" onClick={() => setOpen((value) => !value)}>
        <ChevronDown size={12} />  <LocalizedText id="STR-1652" />
      </button>
      {open && <pre className="set-diag-report wb-mono">{raw}</pre>}
    </div>
  );
}

/** Ordered proof of where a harness started and the exact boundary it hit. */
export function EnvironmentProbeSteps({ steps }: { steps: EnvironmentProbeStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="set-env-steps" aria-label={localized("STR-3216")}>
      {steps.map((step) => (
        <div className={`set-env-step is-${step.status}`} key={step.id} data-env-step={step.id} data-status={step.status}>
          <span className="set-env-step-icon" aria-hidden="true">
            {step.status === "ok"
              ? <CheckCircle2 size={14} />
              : step.status === "failed"
                ? <XCircle size={14} />
                : step.status === "running"
                  ? <RefreshCw size={14} className="wb-spin" />
                  : <CircleDashed size={14} />}
          </span>
          <span className="set-env-step-body">
            <span className="set-env-step-head">
              <b>{step.label}</b>
              {step.durationMs !== undefined && <span className="wb-mono">{step.durationMs}ms</span>}
            </span>
            <span className="set-env-step-detail">{step.detail}</span>
            {(step.path || step.cwd || step.command || step.failureKind || step.failureCode) && (
              <span className="set-env-step-context wb-mono">
                {step.path && <span><b>path</b> {step.path}</span>}
                {step.cwd && <span><b>cwd</b> {step.cwd}</span>}
                {step.command && <span><b>command</b> {step.command}</span>}
                {(step.failureKind || step.failureCode) && (
                  <span className="set-env-step-failure">
                    <b><LocalizedText id="STR-1032" /></b> {[step.failureKind, step.failureCode].filter(Boolean).join(" · ")}
                  </span>
                )}
              </span>
            )}
            {step.raw && <EnvironmentRawDetail raw={step.raw} />}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Outcome of a repair, shown next to the buttons that ran it. */
export function EnvironmentRepairNote({ note }: { note: { ok: boolean; detail: string; output?: string } }) {
  return (
    <div className={"set-repair-note " + (note.ok ? "is-success" : "is-error")} role="status">
      <span className="set-repair-note-main">
        {note.ok ? <Check size={14} /> : <AlertTriangle size={14} />}
        <span>{note.detail}</span>
      </span>
      {note.output && <EnvironmentRawDetail raw={note.output} />}
    </div>
  );
}
