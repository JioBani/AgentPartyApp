import { ApiError, flag, optText, text, type MethodRoute } from "../methodRegistry";

/** Providers whose subscription login/disconnect this app can drive. */
const LOGIN_PROVIDERS = ["codex", "claude"] as const;
const DISCONNECT_PROVIDERS = ["codex", "claude", "cursor"] as const;
const NATIVE_PROVIDERS = ["claude", "codex", "cursor", "grok"] as const;
const NATIVE_HOSTS = ["windows", "wsl"] as const;

function provider<T extends string>(value: unknown, allowed: readonly T[]): T {
  const name = text(value);
  if (!(allowed as readonly string[]).includes(name)) {
    // Unknown provider is "no such endpoint", the answer this path gave before
    // the provider list moved from a route regex into an explicit check.
    throw new ApiError(404, "not_found");
  }
  return name as T;
}

/** Provider credentials: stored API keys and subscription (OAuth) sessions. */
export const authRoutes: MethodRoute[] = [
  {
    name: "auth.get",
    http: "GET /api/auth",
    handler: async (_p, ctx) => ({ providers: await ctx.controller.getAuthProviders(ctx.workspace) }),
  },
  {
    name: "auth.nativeClaude",
    http: "GET /api/auth/native/claude",
    handler: (p, ctx) => ctx.controller.getNativeClaudeAuth(ctx.workspace, flag(p.refresh)),
  },
  {
    name: "auth.testNativeCli",
    http: "POST /api/auth/native/:provider/test",
    handler: (p, ctx) => ctx.controller.testNativeCliAuth(
      provider(p.provider, NATIVE_PROVIDERS),
      provider(p.host, NATIVE_HOSTS),
      ctx.workspace,
      optText(p.distro),
    ),
  },
  {
    name: "auth.setDeepseekKey",
    http: "POST /api/auth/deepseek",
    handler: (p, ctx) => ctx.controller.setDeepseekKey(text(p.key), ctx.workspace),
  },
  {
    name: "auth.clearDeepseekKey",
    http: "DELETE /api/auth/deepseek",
    handler: (_p, ctx) => ctx.controller.clearDeepseekKey(ctx.workspace),
  },
  {
    name: "auth.testDeepseekKey",
    http: "POST /api/auth/deepseek/test",
    handler: (_p, ctx) => ctx.controller.testDeepseekKey(ctx.workspace),
  },
  {
    name: "auth.setOpenRouterKey",
    http: "POST /api/auth/openrouter",
    handler: (p, ctx) => ctx.controller.setOpenRouterKey(text(p.key), ctx.workspace),
  },
  {
    name: "auth.clearOpenRouterKey",
    http: "DELETE /api/auth/openrouter",
    handler: (_p, ctx) => ctx.controller.clearOpenRouterKey(ctx.workspace),
  },
  {
    name: "auth.testOpenRouterKey",
    http: "POST /api/auth/openrouter/test",
    handler: (_p, ctx) => ctx.controller.testOpenRouterKey(ctx.workspace),
  },
  {
    name: "auth.subscriptions",
    http: "GET /api/auth/subscriptions",
    handler: (_p, ctx) => ctx.controller.getSubscriptionAuthState(),
  },
  {
    // Hands off to a browser window on the desktop, which a phone user is not
    // in front of — the flow would stall on a screen they cannot reach.
    name: "auth.loginSubscription",
    http: "POST /api/auth/subscriptions/:provider/login",
    remote: false,
    handler: (p, ctx) => ctx.controller.loginSubscriptionProvider(provider(p.provider, LOGIN_PROVIDERS), ctx.workspace),
  },
  {
    name: "auth.disconnectSubscription",
    http: "DELETE /api/auth/subscriptions/:provider",
    handler: (p, ctx) => ctx.controller.disconnectSubscriptionProvider(provider(p.provider, DISCONNECT_PROVIDERS), ctx.workspace),
  },
];
