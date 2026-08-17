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
  return (
    <div className="wb-modal-scrim" data-guide-offer="1">
      <div className="wb-modal wb-modal-sm" role="dialog" aria-modal="true" aria-labelledby="guide-offer-title">
        <header className="wb-modal-head">
          <div className="wb-modal-title">
            <strong id="guide-offer-title">가이드를 먼저 보시겠습니까?</strong>
          </div>
        </header>
        <div className="wb-modal-body wb-modal-body-col">
          <p>앱을 움직이는 화면과, 물어볼 수 있는 채팅이 한 창에 있습니다. 지금은 한 번만 여쭤봅니다.</p>
        </div>
        <footer className="wb-modal-foot wb-modal-foot-end">
          <div className="wb-modal-actions">
            <button type="button" className="ghost-btn" onClick={onDismiss}>나중에</button>
            <button type="button" className="wb-btn wb-btn-accent" onClick={onAccept}>가이드 보기</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
