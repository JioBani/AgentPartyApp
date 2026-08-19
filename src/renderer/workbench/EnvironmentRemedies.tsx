import { useState } from "react";
import { AlertTriangle, ArrowRight, Check, ChevronDown, Copy, RefreshCw, Settings2 } from "lucide-react";
import type { EnvironmentRemedy } from "../../shared/environment";
import { ipcErrorMessage } from "../app/ipcError";
import { LocalizedText } from "../i18n/I18nProvider";

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
