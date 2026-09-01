import { createContext, useContext, type ReactNode } from "react";

const WorkbenchOverlayTargetContext = createContext<HTMLElement | null>(null);

export function WorkbenchOverlayTargetProvider({ target, children }: { target: HTMLElement | null; children: ReactNode }) {
  return (
    <WorkbenchOverlayTargetContext.Provider value={target}>
      {children}
    </WorkbenchOverlayTargetContext.Provider>
  );
}

/**
 * Transcript previews are shared by every member panel, so the workbench gives
 * them one portal target spanning the complete tab area. Standalone transcript
 * surfaces (tests and guide fixtures) intentionally fall back to the document.
 */
export function useWorkbenchOverlayTarget(): HTMLElement | null {
  return useContext(WorkbenchOverlayTargetContext);
}
