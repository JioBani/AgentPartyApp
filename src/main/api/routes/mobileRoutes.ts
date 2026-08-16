import type { MethodRoute } from "../methodRegistry";
import { optText, required, text } from "../methodRegistry";

/**
 * The mobile link's own control surface (04 §5): pairing, trusted phones, live
 * phone sessions, settings, and NAT diagnostics.
 *
 * Reads are offered to a paired phone so it can show its own link health.
 * Everything that changes TRUST or where the link points stays desktop-only:
 * the desktop is the trust anchor (02-보안-모델), a pairing code has to be
 * compared by a person standing at the desktop screen, and a phone that could
 * repoint `signalingUrl` could redirect the link it is talking on.
 */
export const mobileRoutes: MethodRoute[] = [
  {
    name: "mobile.status",
    http: "GET /api/mobile/status",
    handler: (_p, ctx) => ctx.controller.getMobileStatus(),
  },
  {
    name: "mobile.settings",
    http: "GET /api/mobile/settings",
    handler: (_p, ctx) => ctx.controller.getMobileSettings(),
  },
  {
    name: "mobile.updateSettings",
    http: "POST /api/mobile/settings",
    remote: false,
    handler: (p, ctx) => ctx.controller.updateMobileSettings(p),
  },
  {
    name: "mobile.diagnostics",
    http: "GET /api/mobile/diagnostics",
    handler: (_p, ctx) => ctx.controller.getMobileDiagnostics(),
  },
  {
    name: "mobile.devices",
    http: "GET /api/mobile/devices",
    handler: (_p, ctx) => ctx.controller.listMobileDevices(),
  },
  {
    // Returns the QR string to render. The confirmation code arrives later in
    // `GET /api/mobile/status` → `pairing.code`; QA polls that, then confirms.
    name: "mobile.pairOpen",
    http: "POST /api/mobile/pair/open",
    remote: false,
    handler: (_p, ctx) => ctx.controller.openMobilePairing(),
  },
  {
    name: "mobile.pairConfirm",
    http: "POST /api/mobile/pair/confirm",
    remote: false,
    handler: (_p, ctx) => ctx.controller.confirmMobilePairing(),
  },
  {
    name: "mobile.pairCancel",
    http: "POST /api/mobile/pair/cancel",
    remote: false,
    handler: (_p, ctx) => ctx.controller.cancelMobilePairing(),
  },
  {
    name: "mobile.revokeDevice",
    http: "POST /api/mobile/devices/:id/revoke",
    remote: false,
    handler: (p, ctx) => ctx.controller.revokeMobileDevice(text(p.id)),
  },
  {
    name: "mobile.renameDevice",
    http: "POST /api/mobile/devices/:id/rename",
    remote: false,
    handler: (p, ctx) => ctx.controller.renameMobileDevice(text(p.id), required(p.name, "name")),
  },
  {
    name: "mobile.disconnectSession",
    http: "POST /api/mobile/sessions/:id/disconnect",
    remote: false,
    handler: (p, ctx) => ctx.controller.disconnectMobileSession(text(p.id), optText(p.reason)),
  },
];
