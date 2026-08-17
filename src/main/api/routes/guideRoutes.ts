import type { MethodRoute } from "../methodRegistry";

/**
 * The in-app guide — a screen of an ordinary app window (`ViewId: "guide"`),
 * reached from the nav rail's 가이드 button or from `POST /api/guide/open`, both
 * through the same AppController method.
 *
 * Every route here is desktop-only: the guide teaches the person at the desk,
 * and its stage is a picture of the window in front of them. A paired phone
 * has no window to drive, so none of these reach the mobile catalog.
 */
export const guideRoutes: MethodRoute[] = [
  {
    name: "guide.offer",
    http: "GET /api/guide/offer",
    remote: false,
    handler: (_p, ctx) => ctx.controller.getGuideOffer(),
  },
  {
    name: "guide.offer.markShown",
    http: "POST /api/guide/offer",
    remote: false,
    handler: (p, ctx) => {
      if (p.shown !== true) {
        throw new Error("POST /api/guide/offer 는 { shown: true } 만 받습니다. 완료 표시는 두지 않습니다.");
      }
      return ctx.controller.markGuideOfferShown();
    },
  },
  {
    name: "guide.get",
    http: "GET /api/guide",
    remote: false,
    handler: (_p, ctx) => ctx.controller.getGuideScreen(),
  },
  {
    name: "guide.open",
    http: "POST /api/guide/open",
    remote: false,
    handler: (_p, ctx) => ctx.controller.openGuideScreen(ctx.windowId),
  },
  {
    name: "guide.close",
    http: "POST /api/guide/close",
    remote: false,
    handler: (_p, ctx) => ctx.controller.closeGuideScreen(),
  },
  {
    name: "guide.slide",
    http: "POST /api/guide/slide",
    remote: false,
    handler: (p, ctx) => ctx.controller.setGuideSlide(Number(p.index)),
  },
  {
    name: "guide.capture",
    http: "POST /api/guide/capture",
    remote: false,
    handler: (p, ctx) => ctx.controller.captureGuideScreen(typeof p.path === "string" ? p.path : undefined),
  },
  {
    name: "guide.inspect",
    http: "GET /api/guide/inspect",
    remote: false,
    handler: (_p, ctx) => ctx.controller.inspectGuideScreen(),
  },
  {
    name: "guide.ask",
    http: "POST /api/guide/ask",
    remote: false,
    handler: (p, ctx) => ctx.controller.setGuideAsk(p.open !== false),
  },
  {
    name: "guide.stage.measure",
    http: "POST /api/guide/stage/measure",
    remote: false,
    handler: (p, ctx) => ctx.controller.measureGuideStage(String(p.selector || "")),
  },
  {
    name: "guide.click",
    http: "POST /api/guide/click",
    remote: false,
    handler: (p, ctx) => ctx.controller.clickGuide(String(p.selector || "")),
  },
  {
    name: "guide.knowledge",
    http: "GET /api/guide/knowledge",
    remote: false,
    handler: (_p, ctx) => ctx.controller.guideKnowledge(),
  },
  {
    name: "guide.chat.settings.get",
    http: "GET /api/guide/chat/settings",
    remote: false,
    handler: (_p, ctx) => ctx.controller.getGuideChatSettings(),
  },
  {
    name: "guide.chat.settings.update",
    http: "POST /api/guide/chat/settings",
    remote: false,
    handler: (p, ctx) => ctx.controller.updateGuideChatSettings(p),
  },
  {
    name: "guide.chat.get",
    http: "GET /api/guide/chat",
    remote: false,
    handler: (p, ctx) => ctx.controller.getGuideChat(p.kind === "slide" ? "slide" : "chatbot"),
  },
  {
    name: "guide.chat.send",
    http: "POST /api/guide/chat",
    remote: false,
    handler: (p, ctx) => ctx.controller.sendGuideChat(p.kind === "slide" ? "slide" : "chatbot", String(p.text || ""), p.viewing),
  },
  {
    name: "guide.chat.reset",
    http: "POST /api/guide/chat/reset",
    remote: false,
    handler: (p, ctx) => ctx.controller.resetGuideChat(p.kind === "slide" ? "slide" : "chatbot"),
  },
  {
    name: "guide.chat.compact",
    http: "POST /api/guide/chat/compact",
    remote: false,
    handler: (p, ctx) => ctx.controller.compactGuideChat(p.kind === "slide" ? "slide" : "chatbot"),
  },
];
