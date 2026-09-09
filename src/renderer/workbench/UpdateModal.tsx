import { useEffect, useState } from "react";
import { useModalEscape } from "./useModalEscape";
import { AlertTriangle, ArrowDownToLine, ExternalLink, PackageCheck, RefreshCw, RotateCw, X } from "lucide-react";
import { Markdown } from "./Markdown";
import { formatBytes, releasesUrl, type UpdateStatus } from "../../shared/appUpdate";
import { LocalizedText, localized } from "../i18n/I18nProvider";

interface UpdateModalProps {
  status: UpdateStatus;
  onCheck: () => Promise<void>;
  onDownload: () => Promise<void>;
  onInstall: () => Promise<void>;
  onClose: () => void;
}

/**
 * The update dialog: which version is offered, what changed, and the one action
 * that applies right now (다운로드 → 재시작하여 설치).
 *
 * Installing quits the app, which stops every running member — so that step is
 * behind an explicit confirm inside the dialog rather than a one-click button.
 * The scrim does not dismiss, matching every other modal in the app.
 */
export function UpdateModal({ status, onCheck, onDownload, onInstall, onClose }: UpdateModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmInstall, setConfirmInstall] = useState(false);

  useModalEscape(onClose);

  // A fresh status means whatever the last action complained about is stale.
  useEffect(() => { setError(""); }, [status.state]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const progress = status.progress;
  const pct = Math.round(progress?.percent || 0);

  return (
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-update-modal" role="dialog" aria-modal="true">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <PackageCheck size={16} />
            <strong><LocalizedText id="STR-2252" /></strong>
          </div>
          <button type="button" className="wb-icon-btn" title={localized("STR-2253")} onClick={onClose}><X size={16} /></button>
        </header>

        <div className="wb-modal-body-col">
          <div className="wb-update-versions">
            <span className="wb-mono"><LocalizedText id="STR-2254" /> {status.currentVersion || "확인 중"}</span>
            {status.latestVersion && status.latestVersion !== status.currentVersion && (
              <>
                <span className="wb-update-arrow">→</span>
                <span className="wb-mono wb-update-next">{status.latestVersion}</span>
              </>
            )}
          </div>

          {status.state === "disabled" && (
            <div className="wb-update-note is-warn">
              <AlertTriangle size={13} />
              <span>{status.disabledReason || "이 빌드에서는 자동 업데이트를 사용할 수 없습니다."}</span>
            </div>
          )}
          {status.state === "up-to-date" && <div className="wb-update-note"><LocalizedText id="STR-2257" /></div>}
          {status.state === "checking" && <div className="wb-update-note"><LocalizedText id="STR-2258" /></div>}
          {status.state === "error" && (
            <div className="wb-update-note is-error">
              <AlertTriangle size={13} />
              <span><LocalizedText id="STR-2259" /> {status.error}</span>
            </div>
          )}
          {error && (
            <div className="wb-update-note is-error">
              <AlertTriangle size={13} />
              <span>{error}</span>
            </div>
          )}

          {status.state === "downloading" && (
            <div className="wb-update-progress">
              <div className="wb-update-progress-track">
                <span className="wb-update-progress-fill" style={{ width: `${Math.max(2, pct)}%` }} />
              </div>
              <div className="wb-mono wb-update-progress-text">
                {pct}% · {formatBytes(progress?.transferred || 0)} / {formatBytes(progress?.total || 0)}
                {progress?.bytesPerSecond ? ` · ${formatBytes(progress.bytesPerSecond)}/s` : ""}
              </div>
            </div>
          )}

          {status.state === "available" && status.downgrade && (
            <div className="wb-update-note is-warn">
              <AlertTriangle size={13} />
              <span>
                <strong><LocalizedText id="STR-2261" /></strong>  <LocalizedText id="STR-2260" />
              </span>
            </div>
          )}

          {status.state === "downloaded" && (
            <div className="wb-update-note is-ready">
              <PackageCheck size={13} />
              <span><LocalizedText id="STR-2262" /> <strong><LocalizedText id="STR-2264" /></strong><LocalizedText id="STR-2263" /></span>
            </div>
          )}

          {status.releaseNotes && (
            <div className="wb-update-notes">
              <div className="wb-update-notes-head"><LocalizedText id="STR-2265" />{status.releaseDate ? ` · ${status.releaseDate.slice(0, 10)}` : ""}</div>
              <div className="wb-update-notes-body"><Markdown text={status.releaseNotes} /></div>
            </div>
          )}

          {status.checkedAt && (
            <div className="wb-update-checked"><LocalizedText id="STR-2266" /> {new Date(status.checkedAt).toLocaleString()}</div>
          )}
        </div>

        {/* Secondary route on the left (the browser download), the action that
            applies right now on the right — so the primary button keeps the same
            position as the state moves 다운로드 → 설치. */}
        <footer className="wb-modal-foot">
          <button
            type="button"
            className="wb-btn"
            onClick={() => void window.agentParty.openExternal(status.releaseUrl || releasesUrl())}
          >
            <ExternalLink size={13} />  <LocalizedText id="STR-2267" />
          </button>
          <div className="wb-update-actions">
            <button type="button" className="wb-btn" disabled={busy || status.state === "checking" || status.state === "downloading"} onClick={() => void run(onCheck)}>
              <RefreshCw size={13} className={status.state === "checking" ? "wb-spin" : undefined} />  <LocalizedText id="STR-2268" />
            </button>
            {status.state === "available" && (
              <button type="button" className="wb-btn wb-btn-accent" disabled={busy} onClick={() => void run(onDownload)}>
                <ArrowDownToLine size={13} /> {status.downgrade ? "이전 버전 받기" : "새 버전 다운로드"}
              </button>
            )}
            {status.state === "downloaded" && (
              confirmInstall ? (
                <button type="button" className="wb-btn wb-btn-accent" disabled={busy} onClick={() => void run(onInstall)}>
                  <RotateCw size={13} />  <LocalizedText id="STR-2271" />
                </button>
              ) : (
                <button type="button" className="wb-btn wb-btn-accent" disabled={busy} onClick={() => setConfirmInstall(true)}>
                  <RotateCw size={13} />  <LocalizedText id="STR-2272" />
                </button>
              )
            )}
            <button type="button" className="wb-btn" onClick={onClose}><LocalizedText id="STR-2273" /></button>
          </div>
        </footer>
      </div>
    </div>
  );
}
