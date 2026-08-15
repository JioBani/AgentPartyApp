import { ArrowDownToLine, Download, History, RefreshCw, RotateCw } from "lucide-react";
import { hasActionableUpdate, updatePillLabel, type UpdateStatus } from "../../shared/appUpdate";

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
        ? `버전 ${status.latestVersion || ""} 설치 준비 완료 — 눌러서 설치`
        : status.downgrade
          ? `이전 버전 ${status.latestVersion || ""} 으로 되돌릴 수 있습니다 (현재 ${status.currentVersion})`
          : `새 버전 ${status.latestVersion || ""} 사용 가능 (현재 ${status.currentVersion})`}
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
