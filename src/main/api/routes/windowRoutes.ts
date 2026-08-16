import type { MethodRoute } from "../methodRegistry";
import { optText, text } from "../methodRegistry";

/**
 * Desktop windows, their workspaces, and the screen-measurement surfaces QA
 * drives. Most of this is deliberately desktop-only: a phone routes each call
 * with its own `workspacePath` (문서 04 §3) instead of owning a window.
 */
export const windowRoutes: MethodRoute[] = [
  {
    /**
     * The workspaces this desktop is serving. A phone lists these once and then
     * stamps the chosen `workspacePath` on every later call, which is why there
     * is no remote "open workspace" — routing is per request, not per session.
     */
    name: "workspace.list",
    http: "GET /api/workspaces",
    handler: (_p, ctx) => ctx.controller.listWorkspaces(),
  },
  {
    // Read-only, so a phone may ask. The two routes BELOW move what the person
    // at the desktop is looking at, which a phone must not do behind their back.
    name: "window.list",
    http: "GET /api/windows",
    handler: (_p, ctx) => ({ windows: ctx.controller.listWindows() }),
  },
  {
    // Defaults to the CALLING window's workspace, not the global setting: a
    // `partyId` only means anything inside one workspace, so falling back to the
    // setting opened the window on a DIFFERENT workspace where that id does not
    // exist — and it then silently showed that workspace's own party.
    name: "window.open",
    http: "POST /api/windows",
    remote: false,
    handler: (p, ctx) => ctx.controller.openWindow(text(p.workspacePath, ctx.workspace), optText(p.partyId)),
  },
  {
    name: "window.setWorkspace",
    http: "POST /api/windows/:id/workspace",
    remote: false,
    handler: (p, ctx) => ctx.controller.setWindowWorkspace(text(p.id), text(p.workspacePath)),
  },
  {
    name: "window.capture",
    http: "POST /api/capture",
    remote: false,
    handler: (p, ctx) => ctx.controller.captureWindow(ctx.windowId, p),
  },
  {
    name: "window.measure",
    http: "POST /api/measure",
    remote: false,
    handler: (p, ctx) => ctx.controller.measureWindow(ctx.windowId, p),
  },
  {
    name: "window.minimize",
    http: "POST /api/window/minimize",
    remote: false,
    handler: (_p, ctx) => ctx.controller.minimizeWindow(ctx.windowId),
  },
  {
    name: "window.maximize",
    http: "POST /api/window/maximize",
    remote: false,
    handler: (_p, ctx) => ctx.controller.toggleMaximizeWindow(ctx.windowId),
  },
  {
    name: "window.close",
    http: "POST /api/window/close",
    remote: false,
    handler: (_p, ctx) => ctx.controller.closeWindow(ctx.windowId),
  },
  {
    name: "window.navigate",
    http: "POST /api/navigation",
    remote: false,
    handler: (p, ctx) => ctx.controller.navigate(ctx.windowId, text(p.view, "workbench"), optText(p.tab), optText(p.harness)),
  },
];
