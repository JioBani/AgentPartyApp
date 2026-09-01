/**
 * Disabled startup guide offer (§8 compatibility state).
 *
 * The guide remains available from F1, the navigation rail and the automation
 * API, but startup must never redirect to authentication or open a popup. Old
 * pending records are migrated to `shown: true` so they cannot reappear after
 * an update or a later renderer change.
 */

export interface GuideOfferRecord {
  /** True once the popup has been presented (or suppressed as an upgrade). */
  shown: boolean;
}

export interface GuideOfferView {
  pending: boolean;
  shown: boolean;
}

export function resolveGuideOffer(record: GuideOfferRecord | null): { view: GuideOfferView; write?: GuideOfferRecord } {
  if (record?.shown) {
    return { view: { pending: false, shown: true } };
  }
  return { view: { pending: false, shown: true }, write: { shown: true } };
}
