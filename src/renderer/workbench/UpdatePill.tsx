import { ArrowDownToLine, Download, History, RefreshCw, RotateCw } from "lucide-react";
import { hasActionableUpdate, updatePillLabel, type UpdateStatus } from "../../shared/appUpdate";
import { localized } from "../i18n/I18nProvider";

interface UpdatePillProps {
  status: UpdateStatus | undefined;
  onOpen: () => void;
}

/**
 * Titlebar indicator for a pending app update. Renders NOTHING while the app is
 * current — an always-present "up to date" badge is noise, and the check that
 * feeds it runs on a timer nobody asked about. It appears only when there is
 * something the user can act on (available / downloading / downloaded).
 *
 * Purely presentational: the state comes from the `update:status` push, the
 * decision of "is this actionable" from the shared {@link hasActionableUpdate},
 * so the pill and the modal can never disagree.
 */
export function UpdatePill({ status, onOpen }: UpdatePillProps) {
  if (!hasActionableUpdate(status) || !status) {
    return null;
  }
  const label = updatePillLabel(status);
  const icon = status.state === "downloaded"
    ? <RotateCw size={13} />
    : status.state === "downloading"
      ? <RefreshCw size={13} className="wb-spin" />
      : status.downgrade
        ? <History size={13} />
        : <ArrowDownToLine size={13} />;
  return (
    <button
      type="button"
      className={`wb-update-pill is-${status.state}${status.downgrade ? " is-downgrade" : ""}`}
      title={status.state === "downloaded"
        ? localized("STR-2274", [status.latestVersion || ""])
        : status.downgrade
          ? localized("STR-2275", [status.latestVersion || "", status.currentVersion])
          : localized("STR-2276", [status.latestVersion || "", status.currentVersion])}
      onClick={onOpen}
    >
      {icon}
      <span>{label}</span>
      {status.state === "downloading" && (
        <span className="wb-update-pill-track">
          <span className="wb-update-pill-fill" style={{ width: `${Math.max(2, Math.round(status.progress?.percent || 0))}%` }} />
        </span>
      )}
      {status.state === "available" && <Download size={12} className="wb-update-pill-hint" />}
    </button>
  );
}
