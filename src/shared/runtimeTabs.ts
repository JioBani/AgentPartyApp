/**
 * The tabs of the Settings → 런타임 screen.
 *
 * Shared (not renderer-local) so the automation API can REJECT an unknown tab
 * instead of forwarding it for the renderer to quietly drop — a navigation that
 * reports success while leaving the screen where it was is the silent no-op this
 * project keeps having to dig back out.
 */
export const RUNTIME_TAB_IDS = ["general", "harness", "environment", "gate", "discord", "versions", "diagnostics"] as const;

export type RuntimeTabId = (typeof RUNTIME_TAB_IDS)[number];

export function isRuntimeTabId(value: string): value is RuntimeTabId {
  return (RUNTIME_TAB_IDS as readonly string[]).includes(value);
}
