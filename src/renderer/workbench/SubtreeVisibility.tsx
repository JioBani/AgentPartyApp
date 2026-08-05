import { createContext, useContext, type ReactNode } from "react";

const SubtreeVisibleContext = createContext(true);

/**
 * Whether the surrounding subtree is currently on screen.
 *
 * `display:none` hides a subtree's own DOM, but NOT the overlays it renders
 * through a portal — those attach to the document body and keep drawing. A
 * settings screen that keeps its inactive tab panels mounted (so staged edits
 * survive a tab switch) therefore leaves a modal opened on one tab floating over
 * the next one, and a second modal opened there stacks on top of it: the user
 * sees the model list twice.
 *
 * Wrap a hideable region in {@link SubtreeVisibility} and any portalled overlay
 * inside it follows the region instead of escaping it.
 */
export function useSubtreeVisible(): boolean {
  return useContext(SubtreeVisibleContext);
}

export function SubtreeVisibility({ visible, children }: { visible: boolean; children: ReactNode }) {
  return <SubtreeVisibleContext.Provider value={visible}>{children}</SubtreeVisibleContext.Provider>;
}
