import { useState } from "react";
import { createPortal } from "react-dom";
import { ShieldAlert, ShieldCheck, Trash2 } from "lucide-react";
import { useModalEscape } from "./useModalEscape";
import { LocalizedText, localized } from "../i18n/I18nProvider";

/**
 * The two stop-and-decide dialogs of the SSH feature: trusting a server's
 * fingerprint (S3) and deleting a server (§7.8).
 *
 * Kept apart from the add-server modal on purpose (§12-4): everything else in
 * that flow happens inside one container, but a fingerprint is a security
 * decision and must halt the flow in its own window. Closing is by button only —
 * a stray click outside must never answer a trust question.
 */

export function SshFingerprintDialog({ serverName, fingerprint, previous, busy, onTrust, onCancel }: {
  serverName: string;
  fingerprint: string;
  /** Present when the fingerprint CHANGED; the dialog switches to its danger form. */
  previous?: string;
  busy?: boolean;
  onTrust: () => void;
  onCancel: () => void;
}) {
  const changed = Boolean(previous);
  useModalEscape(onCancel, !busy);
  return createPortal(
    <div className="wb-modal-scrim">
      <div className={"wb-modal wb-modal-sm wb-ssh-fp" + (changed ? " is-danger" : "")} role="alertdialog" aria-modal="true" aria-label={changed ? localized("STR-4043", [serverName]) : localized("STR-4044")} data-ssh-dialog="fingerprint">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            {changed ? <ShieldAlert size={16} className="wb-ssh-danger" /> : <ShieldCheck size={16} className="wb-ssh-accent" />}
            <strong>{changed ? `${serverName} 서버 지문이 바뀌었습니다` : "서버 확인"}</strong>
          </div>
        </header>
        <div className="wb-modal-body wb-ssh-body">
          {changed ? (
            <>
              <p className="wb-ssh-fp-lead"><LocalizedText id="STR-4048" /> <b><LocalizedText id="STR-4047" /></b></p>
              <div className="wb-ssh-fp-compare">
                <span className="wb-ssh-fp-label"><LocalizedText id="STR-4049" /></span>
                <code className="wb-mono wb-ssh-fp-old">{previous}</code>
                <span className="wb-ssh-fp-label"><LocalizedText id="STR-4050" /></span>
                <code className="wb-mono wb-ssh-fp-new">{fingerprint}</code>
              </div>
            </>
          ) : (
            <>
              <p className="wb-ssh-fp-lead"><b>{serverName}</b> <LocalizedText id="STR-4051" /></p>
              <div className="wb-ssh-fp-compare">
                <span className="wb-ssh-fp-label"><LocalizedText id="STR-4052" /></span>
                <code className="wb-mono">{fingerprint}</code>
              </div>
              <p className="wb-ssh-fp-note"><LocalizedText id="STR-4053" /></p>
            </>
          )}
        </div>
        <footer className="wb-modal-foot">
          <span />
          <div className="wb-modal-actions">
            {changed ? (
              <>
                {/* The safe answer is the default (focus, emphasis); trusting is quiet. */}
                <button type="button" className="wb-btn wb-ssh-btn-quiet-danger" disabled={busy} onClick={onTrust}><LocalizedText id="STR-4054" /></button>
                <button type="button" className="wb-btn wb-btn-accent" autoFocus disabled={busy} onClick={onCancel}><LocalizedText id="STR-4055" /></button>
              </>
            ) : (
              <>
                <button type="button" className="wb-btn wb-btn-ghost" disabled={busy} onClick={onCancel}><LocalizedText id="STR-4056" /></button>
                <button type="button" className="wb-btn wb-btn-accent" disabled={busy} onClick={onTrust}><LocalizedText id="STR-4057" /></button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** How many member chips fit before "외 N명" (handoff §10 표). */
const DELETE_MEMBER_CHIPS = 6;

export function SshDeleteDialog({ serverName, memberNames, hasAutoLogin, busy, onDelete, onCancel }: {
  serverName: string;
  memberNames: string[];
  /** The "also remove the auto-login key" option exists only for such servers. */
  hasAutoLogin: boolean;
  busy?: boolean;
  onDelete: (options: { removeAutoLoginKey: boolean }) => void;
  onCancel: () => void;
}) {
  const [removeKey, setRemoveKey] = useState(false);
  useModalEscape(onCancel, !busy);
  return createPortal(
    <div className="wb-modal-scrim">
      <div className="wb-modal wb-modal-sm" role="alertdialog" aria-modal="true" aria-label={localized("STR-4058", [serverName])} data-ssh-dialog="delete">
        <header className="wb-modal-head">
          <div className="wb-modal-title"><Trash2 size={16} className="wb-ssh-danger" /><strong>{serverName} <LocalizedText id="STR-4059" /></strong></div>
        </header>
        <div className="wb-modal-body wb-ssh-body">
          <p className="wb-ssh-fp-lead"><LocalizedText id="STR-4060" /> {memberNames.length}명</p>
          {memberNames.length > 0 && (
            <div className="wb-ssh-member-chips">
              {memberNames.slice(0, DELETE_MEMBER_CHIPS).map((name) => <span key={name} className="wb-ssh-member-chip" title={name}>{name}</span>)}
              {memberNames.length > DELETE_MEMBER_CHIPS && <span className="wb-ssh-member-chip is-more"><LocalizedText id="STR-4061" /> {memberNames.length - DELETE_MEMBER_CHIPS}명</span>}
            </div>
          )}
          <p className="wb-ssh-fp-note"><LocalizedText id="STR-4062" /> <b><LocalizedText id="STR-4064" /></b> <LocalizedText id="STR-4063" /></p>
          {hasAutoLogin && (
            <label className="wb-ssh-check">
              <input type="checkbox" checked={removeKey} disabled={busy} onChange={(event) => setRemoveKey(event.target.checked)} />
              <span><LocalizedText id="STR-4065" /></span>
            </label>
          )}
        </div>
        <footer className="wb-modal-foot">
          <span />
          <div className="wb-modal-actions">
            <button type="button" className="wb-btn wb-btn-ghost" disabled={busy} onClick={onCancel}><LocalizedText id="STR-4066" /></button>
            <button type="button" className="wb-btn wb-ssh-btn-danger" disabled={busy} onClick={() => onDelete({ removeAutoLoginKey: hasAutoLogin && removeKey })}><LocalizedText id="STR-4067" /></button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
