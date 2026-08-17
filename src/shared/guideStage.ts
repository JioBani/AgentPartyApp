/**
 * The message protocol between the guide chrome and the stage iframe.
 *
 * `postMessage` rather than reaching into `iframe.contentWindow` directly: the
 * packaged app loads both documents from `file://`, where each document gets its
 * own opaque origin and cross-document property access throws. postMessage works
 * the same in dev (http) and packaged (file), so there is only one code path.
 */
import type { GuideSnapshot } from "./guide";

/** Stage → chrome, once its React root is mounted and listening. */
export const GUIDE_STAGE_READY = "guide-stage:ready";
/** Chrome → stage: the absolute state to render next. */
export const GUIDE_STAGE_APPLY = "guide-stage:apply";
/** Stage → chrome: a slide's staging (modal/menu opening) did not happen. */
export const GUIDE_STAGE_FAILED = "guide-stage:failed";
/**
 * Stage → chrome: this slide is fully staged, and the stage wants no focus.
 *
 * The demo contains real inputs (the party name, the composer) and real modals
 * that autofocus themselves. Focus landing in the stage iframe means the arrow
 * keys go to a text box inside the picture instead of turning the page, so the
 * stage hands focus back and the chrome takes it.
 */
export const GUIDE_STAGE_STAGED = "guide-stage:staged";

export interface GuideStageReadyMessage {
  type: typeof GUIDE_STAGE_READY;
}

export interface GuideStageApplyMessage {
  type: typeof GUIDE_STAGE_APPLY;
  snapshot: GuideSnapshot;
  /** The chrome's theme, so the demo does not sit in the app in a second skin. */
  themeId: string;
  /** Bumped on every apply — the stage remounts `App` on a change so a slide is
   *  an absolute state, never the previous slide plus an edit. */
  generation: number;
}

export interface GuideStageFailedMessage {
  type: typeof GUIDE_STAGE_FAILED;
  /** The generation the failure belongs to, so a stale report cannot stick to a
   *  slide the user has already moved past. */
  generation: number;
  failures: string[];
}

export interface GuideStageStagedMessage {
  type: typeof GUIDE_STAGE_STAGED;
  generation: number;
}

export type GuideStageMessage =
  | GuideStageReadyMessage
  | GuideStageApplyMessage
  | GuideStageFailedMessage
  | GuideStageStagedMessage;
