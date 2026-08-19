import type { MethodRoute } from "../methodRegistry";
import { flag, optText, text } from "../methodRegistry";

/**
 * App-shell capabilities: state, logs, readiness reports, self-update, and the
 * settings/appearance surfaces. Everything here is workspace- or app-global,
 * never party-scoped.
 */
export const appRoutes: MethodRoute[] = [
  {
    // Liveness for a caller that only wants to know the app answers. Same body
    // as `state.get` so a probe and a full read cannot disagree.
    name: "app.health",
    http: "GET /api/health",
    handler: (_p, ctx) => ctx.controller.getState(ctx.workspace),
  },
  {
    name: "state.get",
    http: "GET /api/state",
    handler: (_p, ctx) => ctx.controller.getState(ctx.workspace),
  },
  {
    name: "app.logs",
    http: "GET /api/logs",
    handler: (_p, ctx) => ctx.controller.getLogs(),
  },
  {
    // The two controller methods the settings 진단 card calls, so a report a
    // user pastes and a report an agent pulls are byte-identical.
    name: "app.diagnostics",
    http: "GET /api/diagnostics",
    handler: (_p, ctx) => ctx.controller.getDiagnostics(ctx.workspace),
  },
  {
    // Opens a folder in the desktop's file manager — nothing a phone can see.
    name: "app.openLogFolder",
    http: "POST /api/diagnostics/open-logs",
    remote: false,
    handler: (_p, ctx) => ctx.controller.openLogFolder(),
  },
  {
    // Readiness, not build facts — the environment tab and an agent driving QA
    // read the same report. `wsl` is opt-in because it boots distros.
    name: "environment.get",
    http: "GET /api/environment",
    handler: (p, ctx) => ctx.controller.getEnvironment({
      refresh: flag(p.refresh),
      includeWsl: flag(p.wsl),
    }),
  },
  {
    name: "environment.repair",
    http: "POST /api/environment/repair",
    handler: (p, ctx) => ctx.controller.repairEnvironment(text(p.repairId)),
  },
  {
    // App self-update. Account-global like usage, so no window/workspace scope.
    name: "update.get",
    http: "GET /api/update",
    handler: (_p, ctx) => ctx.controller.getUpdateStatus(),
  },
  {
    // Release history for the 버전 tab. `refresh` bypasses the 10-minute cache
    // that keeps us inside GitHub's anonymous rate limit.
    name: "update.versions",
    http: "GET /api/update/versions",
    handler: (p, ctx) => ctx.controller.listReleaseVersions({ refresh: flag(p.refresh) }),
  },
  {
    name: "update.check",
    http: "POST /api/update/check",
    handler: (_p, ctx) => ctx.controller.checkForUpdate(),
  },
  {
    name: "update.download",
    http: "POST /api/update/download",
    handler: (_p, ctx) => ctx.controller.downloadUpdate(),
  },
  {
    // Quits the app to hand over to the installer. Not offered to a phone: it
    // would drop the very link the caller is talking on, with no way to report
    // back whether the install then succeeded.
    name: "update.install",
    http: "POST /api/update/install",
    remote: false,
    handler: (_p, ctx) => ctx.controller.installUpdate(),
  },
  {
    name: "settings.update",
    http: "POST /api/settings",
    handler: (p, ctx) => ctx.controller.updateSettings(p),
  },
  {
    name: "locale.get",
    http: "GET /api/settings/locale",
    handler: (_p, ctx) => ctx.controller.getLocale(),
  },
  {
    name: "locale.set",
    http: "POST /api/settings/locale",
    handler: (p, ctx) => ctx.controller.setLocale(p.locale),
  },
  {
    name: "appearance.fonts",
    http: "GET /api/appearance/fonts",
    handler: (p, ctx) => ctx.controller.getFontCatalog(ctx.windowId, optText(p.q)),
  },
  {
    // Acts on the desktop's shell and clipboard — a phone caller would move
    // something on a screen they are not looking at.
    name: "shell.openPath",
    http: "POST /api/shell/open-path",
    remote: false,
    handler: (p, ctx) => ctx.controller.openLocalPath(ctx.windowId, text(p.path), { reveal: p.reveal === true }),
  },
  {
    name: "clipboard.image",
    http: "POST /api/clipboard/image",
    remote: false,
    handler: (p, ctx) => ctx.controller.writeImageToClipboard(p),
  },
];
