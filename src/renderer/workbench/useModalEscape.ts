import { useEffect, useRef } from "react";

/**
 * Escape closes the topmost dismissible layer — the shared half of R-13.
 *
 * `workbenchPopups.ts` already tells Panel's turn-interrupt (R-12) to stand down
 * while an overlay is up. That only settles who *doesn't* act; nothing said who
 * does, so every dialog either hand-rolled its own `window` listener or — for
 * most of them — silently swallowed the key. This is the other half: one
 * listener, one owner per keystroke.
 *
 * A stack rather than a flag, because Escape means "the innermost thing I
 * opened" — one keystroke must never collapse two layers. Last registration
 * wins, and that is the layer on top for the reason it needs to be: dialogs are
 * siblings, React runs sibling effects in JSX order, and JSX order is also DOM
 * order, which is what decides who is painted over whom. Registration order and
 * paint order are therefore the same order and cannot disagree.
 *
 * The one way to break that is to register twice for a single visible dialog —
 * a wrapper AND the dialog it delegates to — because a parent effect runs AFTER
 * its child's, which would put the wrapper on top of the thing the user can see.
 * So: exactly one registration per visible dialog. A component that delegates its
 * rendering to another dialog (RuntimeModal, GateReviewerControl, GuideModelModal)
 * leaves Escape to the dialog it delegates to.
 *
 * Inner popovers (dropdowns, permission menus, the usage pill) listen on
 * `document`, which bubbles before `window`, and mark the key consumed with
 * `preventDefault()`. So they win over the dialog containing them for free, and
 * `defaultPrevented` is the whole protocol between the two.
 */
type EscapeHandler = () => void;

const stack: Array<{ current: EscapeHandler }> = [];

function onKeyDown(event: KeyboardEvent) {
  // `isComposing` matters here, not in the popover handlers: Escape while a
  // Hangul syllable is mid-composition cancels the composition, and the user
  // would not expect the dialog they are typing into to vanish with it.
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) {
    return;
  }
  const top = stack[stack.length - 1];
  if (!top) {
    return;
  }
  // Claim the key before Panel sees it, so closing a dialog can never also
  // interrupt the member's running turn.
  event.preventDefault();
  top.current();
}

function push(entry: { current: EscapeHandler }) {
  if (!stack.length) {
    window.addEventListener("keydown", onKeyDown);
  }
  stack.push(entry);
}

function pop(entry: { current: EscapeHandler }) {
  const at = stack.lastIndexOf(entry);
  if (at >= 0) {
    stack.splice(at, 1);
  }
  if (!stack.length) {
    window.removeEventListener("keydown", onKeyDown);
  }
}

/**
 * Register this layer as Escape's owner while it is mounted.
 *
 * @param onEscape What Escape does here — usually the same `onClose` the ✕ runs,
 *   but a layered dialog may peel one state off instead (see ModelCatalogModal).
 * @param enabled Set false while the dialog must not be dismissed (a launch in
 *   flight, say). The layer then leaves Escape to whatever is underneath it.
 */
export function useModalEscape(onEscape: EscapeHandler, enabled = true) {
  // The handler is read through a ref so a dialog whose close callback is a
  // fresh closure every render does not re-order the stack under itself.
  const handler = useRef(onEscape);
  handler.current = onEscape;

  useEffect(() => {
    if (!enabled) {
      return;
    }
    push(handler);
    return () => pop(handler);
  }, [enabled]);
}
