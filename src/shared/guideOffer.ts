/**
 * First-install guide offer (§8).
 *
 * Record that the popup was *shown*, not that the user finished the guide.
 * An existing settings.json with no record is an upgrade — never offer.
 */

export interface GuideOfferRecord {
  /** True once the popup has been presented (or suppressed as an upgrade). */
  shown: boolean;
}

export interface GuideOfferView {
  pending: boolean;
  shown: boolean;
}

export function resolveGuideOffer(input: {
  record: GuideOfferRecord | null;
  settingsExistedAtBoot: boolean;
}): { view: GuideOfferView; write?: GuideOfferRecord } {
  if (input.record?.shown) {
    return { view: { pending: false, shown: true } };
  }
  if (input.record && !input.record.shown) {
    return { view: { pending: true, shown: false } };
  }
  if (input.settingsExistedAtBoot) {
    return { view: { pending: false, shown: true }, write: { shown: true } };
  }
  return { view: { pending: true, shown: false }, write: { shown: false } };
}

/** What the workbench should do with a live offer + auth state. */
export function nextGuideOfferAction(pending: boolean, connected: boolean): "idle" | "auth" | "show" {
  if (!pending) {
    return "idle";
  }
  return connected ? "show" : "auth";
}
