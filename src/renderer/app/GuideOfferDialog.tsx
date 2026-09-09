
import { LocalizedText } from "../i18n/I18nProvider";
import { useModalEscape } from "../workbench/useModalEscape";
/**
 * First-install popup (§8). "Shown" is recorded by the caller the moment this
 * mounts — we do not track whether they finished the guide.
 */
export function GuideOfferDialog({
  onAccept,
  onDismiss,
}: {
  onAccept: () => void;
  onDismiss: () => void;
}) {
  // Escape declines: the offer is optional, so dismissing it is the safe default.
  useModalEscape(onDismiss);
  return (
    <div className="wb-modal-scrim" data-guide-offer="1">
      <div className="wb-modal wb-modal-sm" role="dialog" aria-modal="true" aria-labelledby="guide-offer-title">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <strong id="guide-offer-title"><LocalizedText id="STR-0859" /></strong>
          </div>
        </header>
        <div className="wb-modal-body wb-modal-body-col">
          <p><LocalizedText id="STR-0860" /></p>
        </div>
        <footer className="wb-modal-foot wb-modal-foot-end">
          <div className="wb-modal-actions">
            <button type="button" className="ghost-btn" onClick={onDismiss}><LocalizedText id="STR-0861" /></button>
            <button type="button" className="wb-btn wb-btn-accent" onClick={onAccept}><LocalizedText id="STR-0862" /></button>
          </div>
        </footer>
      </div>
    </div>
  );
}
