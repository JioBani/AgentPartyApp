import type { BrowserActionInput } from "../../../shared/browserControl";
import { text, type MethodRoute } from "../methodRegistry";

/** The UI and local automation call the same AppController method as member MCP. */
export const browserRoutes: MethodRoute[] = [{
  name: "browser.action",
  http: "POST /api/browser/action",
  remote: false,
  handler: (p, ctx) => ctx.controller.browserAction(
    ctx.workspace, text(p.partyId), text(p.member), p as BrowserActionInput, ctx.windowId,
  ),
}];
