import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, RefreshCw, Settings } from "lucide-react";
import { buildUsageView, type UsageLimitsSnapshot, type UsageProviderId } from "../../shared/usageLimits";
import { HarnessIcon } from "./HarnessIcon";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/** The harness whose official mark represents each usage provider. */
const PROVIDER_HARNESS: Record<UsageProviderId, string> = {
  claude: "claude-code",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
};

interface UsageLimitPillProps {
  usage: UsageLimitsSnapshot;
  /** Party members currently driving each provider (Claude/Codex account). */
  membersByProvider: Partial<Record<UsageProviderId, number>>;
  onOpenSettings: () => void;
  onRefresh: () => void;
  refreshing?: boolean;
}

/**
 * Titlebar indicator for ACCOUNT/provider-scoped rate limits — a pill with one
 * mini donut per provider (5-hour usage), opening a popover with 5-hour + weekly
 * bars and reset countdowns. Purely presentational: all data comes from the
 * merged {@link UsageLimitsSnapshot} pushed by main; the view is built by the
 * shared {@link buildUsageView} so QA renders the identical output. See
 * docs/디자인 핸드오프/design_handoff_usage_limits.
 */
export function UsageLimitPill({ usage, membersByProvider, onOpenSettings, onRefresh, refreshing }: UsageLimitPillProps) {
  const [open, setOpen] = useState(false);
  // Re-tick so reset countdowns count down between server pushes.
  const [nowMs, setNowMs] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Consume it: a popover inside a dialog must not close the dialog too.
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const view = useMemo(() => buildUsageView(usage, membersByProvider, nowMs), [usage, membersByProvider, nowMs]);

  // Nothing to show yet (no provider has data or active members): stay out of the
  // titlebar rather than render an empty, meaningless pill.
  if (view.pills.length === 0) {
    return null;
  }

  const triggerBorder = view.anyHigh ? "var(--live)" : open ? "var(--accent-bd)" : "var(--border)";

  return (
    <div className="usage-wrap" ref={ref}>
      <button
        type="button"
        className="usage-pill"
        title={localized("STR-2277")}
        style={{ borderColor: triggerBorder }}
        onClick={() => setOpen((v) => !v)}
      >
        {view.pills.map((p) => (
          <span key={p.key} className="usage-seg">
            <HarnessIcon harness={PROVIDER_HARNESS[p.key]} size={12} style={{ color: p.brand }} />
            <span className="usage-ring" style={{ background: p.ring }}>
              <span className="usage-ring-hole" style={{ background: p.holeBg }} />
            </span>
            <span className="usage-seg-label" style={{ color: p.labelCol }}>{p.label}</span>
            <span className="usage-seg-pct wb-mono" style={{ color: p.pctCol }}>{p.pctLabel}</span>
          </span>
        ))}
        <ChevronDown size={11} className="usage-chevron" />
      </button>

      {open && (
        <div className="usage-pop" role="dialog" aria-label={localized("STR-2278")}>
          <div className="usage-pop-header">
            <span className="usage-pop-title"><LocalizedText id="STR-2279" /></span>
            <span className="usage-pop-scope wb-mono"><LocalizedText id="STR-2280" /></span>
          </div>
          {view.rows.map((row, index) => (
            <div key={row.key} className={"usage-row" + (index > 0 ? " divided" : "")}>
              <div className="usage-row-header">
                <HarnessIcon harness={PROVIDER_HARNESS[row.key]} size={13} style={{ color: row.brand }} />
                <span className="usage-row-name">{row.label}</span>
                <span className="usage-row-sub wb-mono">{row.sub}</span>
              </div>
              {row.meters.map((m) => (
                <div key={m.kind} className="usage-meter">
                  <div className="usage-meter-head">
                    <span className="usage-meter-name">{m.name}</span>
                    <span className="usage-meter-right wb-mono">{m.right}</span>
                  </div>
                  <div className="usage-bar">
                    <div className="usage-bar-fill" style={{ width: m.pctWidth, background: m.col }} />
                  </div>
                </div>
              ))}
            </div>
          ))}
          <div className="usage-pop-actions">
            <button type="button" className="usage-settings-btn" onClick={onRefresh} disabled={refreshing}>
              <RefreshCw size={12} />
              {refreshing ? "새로고침 중" : "새로고침"}
            </button>
            <button type="button" className="usage-settings-btn" onClick={() => { setOpen(false); onOpenSettings(); }}>
              <Settings size={12} />

              <LocalizedText id="STR-2283" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
