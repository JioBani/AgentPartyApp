/**
 * Surfaces that already own Escape (R-13). Esc must close these before it can
 * interrupt a turn (R-12) — one key, two jobs, popup wins.
 *
 * Checked against the live DOM rather than a shared React flag so every overlay
 * (modals, menus, palette, dropdowns) is covered without wiring a central store.
 */
const POPUP_SELECTORS = [
  ".wb-tool-modal", // transcript/tool "전체 보기"
  ".wb-cmd-palette", // composer "/" palette
  ".wb-modal", // catalog / wizard / gate / compact / …
  ".mcp-modal",
  ".wb-dd-menu", // open dropdown / permission menus
  ".wb-header-menu", // panel ⋯ menu
  ".usage-pop", // usage-limit popover
].join(", ");

/** True when an Escape-consuming workbench popup is currently mounted. */
export function workbenchPopupOpen(doc: ParentNode = document): boolean {
  return Boolean(doc.querySelector(POPUP_SELECTORS));
}
