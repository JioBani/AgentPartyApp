import type { MethodRoute } from "../methodRegistry";

/** Jev is a single-call decision provider, independent of member harnesses. */
export const jevRoutes: MethodRoute[] = [
  {
    name: "jev.providers",
    http: "GET /api/jev/providers",
    handler: (_p, ctx) => ctx.controller.getJevProviders(),
  },
  {
    name: "jev.defaultProvider",
    http: "POST /api/jev/providers/default",
    handler: (p, ctx) => ctx.controller.setJevDefaultProvider(p.provider),
  },
  {
    name: "jev.decide",
    http: "POST /api/jev/decisions",
    handler: (p, ctx) => ctx.controller.decideJev(ctx.workspace, p),
  },
];
