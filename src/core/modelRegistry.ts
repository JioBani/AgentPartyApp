import {
  catalogModelById,
  catalogModelByRuntime,
  claudeSubscriptionModels,
  codexAccountModels,
  modelCatalog,
  orRoutedModels,
  resolveCatalogModel,
  type CatalogModel,
  type ReasoningThinkingSpec,
} from "../shared/modelCatalog";
import type { CodexModelInfo } from "../shared/codexModels";
import { CODEX_CLAUDE_SUBSCRIPTION_PROVIDER, CODEX_OPENROUTER_PROVIDER } from "../shared/codexProviders";

export type HarnessId = "claude-code" | "codex" | "cursor";
export type ModelProviderId = "anthropic" | "openrouter" | "openai" | "cursor" | "custom";

export interface HarnessDescriptor {
  id: HarnessId;
  label: string;
  enabled: boolean;
  description?: string;
}

/** Leaderboard metrics surfaced to the Runtime UI. */
export interface ModelLeaderboardMeta {
  /** Performance tier 0-5 (leaderboard '칸'). */
  perf?: number;
  /** Cost tier 1-5 (leaderboard '비용'). */
  costTier?: number;
  inPerM?: number;
  outPerM?: number;
  ioPerM?: number;
  context?: string;
}

export interface ModelRoute {
  harnessId: HarnessId;
  providerId: ModelProviderId;
  model: string;
  runtimeModel?: string;
  /** Codex custom provider id (e.g. "openrouter"); absent = built-in account. */
  modelProvider?: string;
  label: string;
  description?: string;
  pricing?: ModelPricing;
  supportsEffort?: boolean;
  effortLevels?: string[];
  capabilities: ModelCapabilities;
  meta?: ModelLeaderboardMeta;
  enabled: boolean;
  /** Visible explanation when a catalog combination cannot be executed. */
  unavailableReason?: string;
}

export interface ModelPricing {
  billing: "subscription" | "token" | "free" | "unknown";
  inputUsdPerM?: number;
  outputUsdPerM?: number;
  ioUsdPerM?: number;
  directPrice?: string;
  context?: string;
  performance?: string;
  note?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
}

export interface EffortCapability {
  supported: boolean;
  mutableDuringSession: boolean;
  defaultValue?: string;
  options: ModelOption[];
}

export interface ThinkingBudgetCapability {
  default: number;
  min?: number;
  max?: number;
}

export interface ThinkingCapability {
  supported: boolean;
  mutableDuringSession: boolean;
  defaultEnabled?: boolean;
  /** Default mode id (adaptive/enabled/disabled) when modes are present. */
  defaultValue?: string;
  /** Selectable thinking modes; presence of "disabled" means reasoning can be turned off. */
  modes?: ModelOption[];
  /** Optional thinking-token budget slider. */
  budget?: ThinkingBudgetCapability;
  options?: ModelOption[];
}

export interface PermissionCapability {
  supported: boolean;
  mutableDuringSession: boolean;
  defaultValue?: string;
  options: ModelOption[];
}

/**
 * Multimodal input support of the effective model. `image` is tri-state:
 * true = accepts images, false = text-only (attaching is refused with a visible
 * error, never silently dropped), undefined = unknown (attach allowed).
 */
export interface VisionCapability {
  image?: boolean;
  video?: boolean;
  maxImages?: number;
  maxBytesPerImage?: number;
}

export interface ModelCapabilities {
  effort: EffortCapability;
  thinking: ThinkingCapability;
  /** Optional provider serving tier such as Cursor Grok Standard/Fast. */
  serviceTier?: EffortCapability;
  permission: PermissionCapability;
  vision: VisionCapability;
}

export interface ModelRouteConfig {
  harnessId?: HarnessId;
  providerId?: ModelProviderId;
  model: string;
  runtimeModel?: string;
  label?: string;
  description?: string;
  pricing?: ModelPricing;
  capabilities?: PartialModelCapabilities;
  enabled?: boolean;
}

export interface PartialModelCapabilities {
  effort?: Partial<EffortCapability> & { options?: Array<ModelOption | string> };
  thinking?: Partial<ThinkingCapability>;
  serviceTier?: Partial<EffortCapability> & { options?: Array<ModelOption | string> };
  permission?: Partial<PermissionCapability> & { options?: Array<ModelOption | string> };
  vision?: VisionCapability;
}

export const harnesses: HarnessDescriptor[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    enabled: true,
    description: "Claude Code SDK/native CLI harness. Can route Anthropic or router-backed model IDs.",
  },
  {
    id: "codex",
    label: "Codex",
    enabled: true,
    description: "Codex CLI app-server harness with persistent JSON-RPC threads.",
  },
  {
    id: "cursor",
    label: "Cursor CLI",
    enabled: true,
    description: "Cursor Agent CLI with Cursor Auto or the Grok 4.5 named model.",
  },
];

export function buildModelRoutes(currentModel: string, _claudeModels: unknown[] = [], customRoutes: ModelRouteConfig[] = [], codexModels?: CodexModelInfo[]): ModelRoute[] {
  const routes: ModelRoute[] = [];
  const seen = new Set<string>();

  // Codex harness, account models: the live catalog (model/list) wins — it
  // carries the account's real effort options (incl. levels the static catalog
  // cannot transport, e.g. GPT-5.6 "ultra"). The static catalog entries below
  // dedupe against it and only fill in models not (yet) discovered, so the
  // harness stays usable before/without discovery.
  for (const model of codexModels || []) {
    addRoute(routes, seen, codexRouteFromModel(model));
  }
  for (const model of codexAccountModels()) {
    addRoute(routes, seen, codexRouteFromCatalog(model));
  }
  // The catalog is authoritative for the claude-code model list. OpenAI models
  // retain the Claude SDK process while the embedded router forwards them to
  // the local Codex/ChatGPT subscription proxy.
  for (const model of modelCatalog()) {
    addRoute(routes, seen, routeFromCatalog(model));
  }
  // True OpenRouter catalog models stay token-billed on the OpenRouter custom
  // provider. Anthropic cross-routes are added separately through Claude OAuth.
  for (const model of orRoutedModels()) {
    addRoute(routes, seen, codexOpenRouterRoute(model));
  }
  for (const model of claudeSubscriptionModels()) {
    addRoute(routes, seen, codexClaudeSubscriptionRoute(model));
  }
  addRoute(routes, seen, cursorAutoRoute());
  for (const model of modelCatalog().filter((entry) => Boolean(entry.cursorModel))) {
    addRoute(routes, seen, cursorRouteFromCatalog(model));
  }
  // Catalog completeness is independent from executable protocol support.
  // Cursor is an agent runtime, not an Anthropic/OpenAI-compatible model
  // endpoint, so unsupported combinations remain visible with an explicit
  // reason instead of disappearing or silently switching harnesses.
  for (const model of modelCatalog().filter((entry) => !entry.cursorModel)) {
    addRoute(routes, seen, unavailableCursorHarnessRoute(model));
  }
  // The claude-code placeholder ("Cursor is an agent runtime, not an endpoint")
  // is obsolete once a bridge-backed cursor entry serves that harness — keeping
  // it would show the same model twice under the Cursor provider, one disabled.
  const cursorBridgeServesClaudeCode = modelCatalog().some((entry) => entry.provider === "cursor" && Boolean(entry.cursorAcpModelId));
  for (const model of modelCatalog().filter((entry) => Boolean(entry.cursorModel))) {
    if (!cursorBridgeServesClaudeCode) {
      addRoute(routes, seen, unavailableCursorProviderRoute("claude-code", model));
    }
    addRoute(routes, seen, unavailableCursorProviderRoute("codex", model));
  }

  // Keep the currently selected model visible even if it is not catalogued
  // (e.g. a user-configured custom route), so it never silently disappears.
  // Resolution is canonical-spelling aware: a session echoing
  // "claude-opus-5" is the claude-opus-5[1m] entry, not a new fallback route.
  if (currentModel && !resolveCatalogModel(currentModel)) {
    addRoute(routes, seen, {
      harnessId: "claude-code",
      providerId: inferModelProvider(currentModel, customRoutes),
      model: currentModel,
      label: currentModel,
      runtimeModel: runtimeModelFor(currentModel, customRoutes),
      pricing: { billing: "unknown" },
      capabilities: neutralCapabilities(),
      enabled: true,
    });
  }

  for (const route of customRoutes) {
    addRoute(routes, seen, normalizeCustomRoute(route));
  }

  return routes;
}

/**
 * A route for one model of the discovered Codex account catalog. Effort options
 * come from the model's own `supportedReasoningEfforts`; thinking/permission are
 * unsupported on this harness (Codex manages reasoning internally and uses the
 * two-axis sandbox/approval policy instead of Claude permission modes).
 * Leaderboard meta (perf/cost) is enriched from the shared catalog when the
 * same model exists there under a spelling variant (e.g. "GPT-5.4 mini").
 */
export function codexRouteFromModel(model: CodexModelInfo): ModelRoute {
  const catalogTwin = resolveCatalogModel(model.model);
  return {
    harnessId: "codex",
    providerId: "openai",
    model: model.model,
    runtimeModel: model.model,
    // Transport discovery may spell/case the same model differently. The
    // shared catalog owns the user-facing identity so Claude Code, Codex and
    // OpenRouter routes render one stable name; only model/runtimeModel carry
    // harness-specific slugs.
    label: catalogTwin?.label || model.displayName,
    description: model.description,
    pricing: { billing: "subscription", directPrice: "Codex subscription", context: catalogTwin?.context },
    capabilities: {
      effort:
        model.reasoningEfforts.length > 0
          ? {
              supported: true,
              mutableDuringSession: true,
              defaultValue: model.defaultReasoningEffort || model.reasoningEfforts[0].id,
              options: model.reasoningEfforts.map((effort) => ({ id: effort.id, label: effortLabel(effort.id), description: effort.description })),
            }
          : { supported: false, mutableDuringSession: false, options: [] },
      thinking: { supported: false, mutableDuringSession: false },
      permission: { supported: false, mutableDuringSession: false, options: [] },
      // A live Codex account model (e.g. "gpt-5.4") inherits vision from its
      // catalog twin; unknown when it has no catalog entry (honestly reported).
      vision: catalogTwin ? visionFromCatalog(catalogTwin) : {},
    },
    meta: catalogTwin
      ? { perf: catalogTwin.perf, costTier: catalogTwin.costTier, inPerM: catalogTwin.inPerM, outPerM: catalogTwin.outPerM, ioPerM: catalogTwin.ioPerM, context: catalogTwin.context }
      : undefined,
    enabled: true,
  };
}

/**
 * A codex-harness route for an OpenRouter catalog model (Phase 2). The model
 * slug sent to the app-server is the concrete `orModelId` (e.g. "z-ai/glm-5.2"),
 * routed through the OpenRouter custom provider. Effort options come from the
 * catalog's reasoning spec (Codex forwards the effort as the provider's
 * reasoning control); thinking/permission stay unsupported on this harness.
 * Leaderboard meta (perf/cost) is preserved from the catalog.
 */
export function codexOpenRouterRoute(model: CatalogModel): ModelRoute {
  const effort = model.reasoning?.effort;
  return {
    harnessId: "codex",
    // Grouped under the model's HOME provider (Opus under Anthropic, GLM under
    // OpenRouter); the transport/billing identity is `modelProvider` below —
    // the UI billing note and the codex adapter's cost path key off that, not
    // off this display grouping.
    providerId: model.provider,
    model: model.orModelId || model.id,
    runtimeModel: model.orModelId || model.id,
    modelProvider: CODEX_OPENROUTER_PROVIDER.id,
    label: model.label,
    description: `${model.description || ""} Runs on the Codex harness via OpenRouter (billed to your OpenRouter key).`.trim(),
    // Always token-billed: this route pays the OpenRouter key even when the
    // model's native home is a subscription (e.g. Opus on the codex harness).
    pricing: { ...pricingFromCatalog(model), billing: "token" },
    capabilities: {
      effort: effort
        ? {
            supported: true,
            mutableDuringSession: true,
            defaultValue: effort.default,
            options: effort.options.map((level) => ({ id: level, label: effortLabel(level) })),
          }
        : { supported: false, mutableDuringSession: false, options: [] },
      thinking: { supported: false, mutableDuringSession: false },
      permission: { supported: false, mutableDuringSession: false, options: [] },
      vision: visionFromCatalog(model),
    },
    meta: {
      perf: model.perf,
      costTier: model.costTier,
      inPerM: model.inPerM,
      outPerM: model.outPerM,
      ioPerM: model.ioPerM,
      context: model.context,
    },
    enabled: true,
  };
}

/** Cursor's plan-compatible automatic model selector. The chosen model is opaque. */
export function cursorAutoRoute(): ModelRoute {
  return {
    harnessId: "cursor",
    providerId: "cursor",
    model: "Auto",
    runtimeModel: "auto",
    label: "Auto",
    description: "Lets Cursor select the model. The underlying model is not reported by Cursor CLI.",
    pricing: { billing: "subscription", directPrice: "Cursor subscription" },
    capabilities: {
      effort: { supported: false, mutableDuringSession: false, options: [] },
      thinking: { supported: false, mutableDuringSession: false },
      permission: standardPermissionCapability(),
      vision: { image: false },
    },
    enabled: true,
  };
}

/** The named-model Cursor surface: catalog entries with cursorModel. */
export function cursorRouteFromCatalog(model: CatalogModel): ModelRoute {
  const effort = model.reasoning?.effort;
  const serviceTier = model.serviceTier;
  return {
    harnessId: "cursor",
    providerId: "cursor",
    model: model.id,
    runtimeModel: model.cursorModel,
    label: model.label,
    description: `${model.description || ""} Runs through the signed-in Cursor Agent CLI.`.trim(),
    pricing: { billing: "subscription", directPrice: "Cursor subscription", context: model.context },
    capabilities: {
      effort: effort
        ? {
            supported: true,
            mutableDuringSession: true,
            defaultValue: effort.default,
            options: effort.options.map((level) => ({ id: level, label: effortLabel(level) })),
          }
        : { supported: false, mutableDuringSession: false, options: [] },
      thinking: { supported: false, mutableDuringSession: false },
      serviceTier: serviceTier
        ? {
            supported: true,
            mutableDuringSession: true,
            defaultValue: serviceTier.default,
            options: serviceTier.options.map((tier) => ({ id: tier, label: tier === "fast" ? "Fast" : "Standard" })),
          }
        : undefined,
      permission: standardPermissionCapability(),
      vision: { image: false },
    },
    meta: {
      perf: model.perf,
      costTier: model.costTier,
      inPerM: model.inPerM,
      outPerM: model.outPerM,
      ioPerM: model.ioPerM,
      context: model.context,
    },
    enabled: true,
  };
}

function unavailableCursorHarnessRoute(model: CatalogModel): ModelRoute {
  return {
    harnessId: "cursor",
    providerId: model.provider,
    model: model.id,
    runtimeModel: model.id,
    label: model.label,
    description: model.description,
    pricing: pricingFromCatalog(model),
    capabilities: capabilitiesFromCatalog(model),
    meta: {
      perf: model.perf,
      costTier: model.costTier,
      inPerM: model.inPerM,
      outPerM: model.outPerM,
      ioPerM: model.ioPerM,
      context: model.context,
    },
    enabled: false,
    unavailableReason: "Cursor Agent CLI does not expose this model to the signed-in account. No fallback will be attempted.",
  };
}

function unavailableCursorProviderRoute(harnessId: "claude-code" | "codex", model: CatalogModel): ModelRoute {
  return {
    harnessId,
    providerId: "cursor",
    model: model.id,
    runtimeModel: model.cursorModel,
    label: model.label,
    description: `${model.description || ""} Cursor subscription route.`.trim(),
    pricing: { billing: "subscription", directPrice: "Cursor subscription", context: model.context },
    capabilities: {
      ...capabilitiesFromCatalog(model),
      serviceTier: model.serviceTier
        ? {
            supported: true,
            mutableDuringSession: false,
            defaultValue: model.serviceTier.default,
            options: model.serviceTier.options.map((tier) => ({ id: tier, label: tier === "fast" ? "Fast" : "Standard" })),
          }
        : undefined,
    },
    meta: {
      perf: model.perf,
      costTier: model.costTier,
      inPerM: model.inPerM,
      outPerM: model.outPerM,
      ioPerM: model.ioPerM,
      context: model.context,
    },
    enabled: false,
    unavailableReason: `Cursor exposes Grok through its agent CLI/SDK, not the ${harnessId === "codex" ? "OpenAI Responses" : "Anthropic Messages"} model protocol required by ${harnessId === "codex" ? "Codex" : "Claude Code"}.`,
  };
}

/** Codex app-server route backed by the user's Claude OAuth subscription. */
export function codexClaudeSubscriptionRoute(model: CatalogModel): ModelRoute {
  const effort = model.reasoning?.effort;
  return {
    harnessId: "codex",
    providerId: "anthropic",
    model: model.claudeSubscriptionModel || model.id,
    runtimeModel: model.claudeSubscriptionModel || model.id,
    modelProvider: CODEX_CLAUDE_SUBSCRIPTION_PROVIDER.id,
    label: model.label,
    description: `${model.description || ""} Runs on the Codex harness through your Claude subscription (local CLIProxyAPI).`.trim(),
    pricing: { billing: "subscription", directPrice: "Claude subscription", context: model.context },
    capabilities: {
      effort: effort
        ? {
            supported: true,
            mutableDuringSession: true,
            defaultValue: effort.default,
            options: effort.options.map((level) => ({ id: level, label: effortLabel(level) })),
          }
        : { supported: false, mutableDuringSession: false, options: [] },
      thinking: { supported: false, mutableDuringSession: false },
      permission: { supported: false, mutableDuringSession: false, options: [] },
      vision: visionFromCatalog(model),
    },
    meta: {
      perf: model.perf,
      costTier: model.costTier,
      inPerM: model.inPerM,
      outPerM: model.outPerM,
      ioPerM: model.ioPerM,
      context: model.context,
    },
    enabled: true,
  };
}

/**
 * A codex-harness route for a catalog account model (provider openai with a
 * codexModel slug) — the static fallback that keeps every known account model
 * selectable before/without live discovery. Effort options are the catalog's
 * transportable subset; a live model/list route for the same slug supersedes
 * this one (added first in buildModelRoutes) with the account's real options.
 */
export function codexRouteFromCatalog(model: CatalogModel): ModelRoute {
  const effort = model.reasoning?.effort;
  return {
    harnessId: "codex",
    providerId: "openai",
    model: model.codexModel || model.id,
    runtimeModel: model.codexModel || model.id,
    label: model.label,
    description: model.description,
    pricing: { billing: "subscription", directPrice: "Codex subscription", context: model.context },
    capabilities: {
      effort: effort
        ? {
            supported: true,
            mutableDuringSession: true,
            defaultValue: effort.default,
            options: effort.options.map((level) => ({ id: level, label: effortLabel(level) })),
          }
        : { supported: false, mutableDuringSession: false, options: [] },
      thinking: { supported: false, mutableDuringSession: false },
      permission: { supported: false, mutableDuringSession: false, options: [] },
      vision: visionFromCatalog(model),
    },
    meta: {
      perf: model.perf,
      costTier: model.costTier,
      inPerM: model.inPerM,
      outPerM: model.outPerM,
      ioPerM: model.ioPerM,
      context: model.context,
    },
    enabled: true,
  };
}

function routeFromCatalog(model: CatalogModel): ModelRoute {
  const routed = model.provider !== "anthropic";
  const subscriptionRouted = model.provider === "openai" && Boolean(model.codexModel);
  const cursorRouted = model.provider === "cursor" && Boolean(model.cursorAcpModelId);
  return {
    harnessId: "claude-code",
    providerId: model.provider,
    model: model.id,
    runtimeModel: model.runtimeModel,
    label: model.label,
    description: routed
      ? subscriptionRouted
        ? `${model.description || ""} Runs on the Claude Code harness through your Codex/ChatGPT subscription (local CLIProxyAPI).`.trim()
        : cursorRouted
          ? `${model.description || ""} Runs on the Claude Code harness through your Cursor subscription (local ACP bridge).`.trim()
          : `${model.description || ""} Runs on the Claude Code harness via OpenRouter (billed to your OpenRouter key).`.trim()
      : model.description,
    pricing: subscriptionRouted
      ? { billing: "subscription", directPrice: "Codex subscription", context: model.context }
      : cursorRouted
        ? { billing: "subscription", directPrice: "Cursor subscription", context: model.context }
        : routed
          ? { ...pricingFromCatalog(model), billing: "token" }
          : pricingFromCatalog(model),
    capabilities: capabilitiesFromCatalog(model),
    meta: {
      perf: model.perf,
      costTier: model.costTier,
      inPerM: model.inPerM,
      outPerM: model.outPerM,
      ioPerM: model.ioPerM,
      context: model.context,
    },
    enabled: true,
  };
}

export function inferModelProvider(model: string, customRoutes: ModelRouteConfig[] = []): ModelProviderId {
  const configured = customRoutes.find((route) => (route.harnessId || "claude-code") === "claude-code" && route.model === model);
  if (configured?.providerId) {
    return configured.providerId;
  }
  // Any spelling of a catalogued model (incl. the harness canonical id and the
  // OpenRouter slug) resolves to its HOME provider. Without this, a claude
  // member whose model was persisted as "anthropic/claude-opus-4.8" inferred
  // provider "custom" and silently routed through the router → OpenRouter,
  // token-billing an Anthropic subscription model.
  const catalogued = resolveCatalogModel(model);
  if (catalogued) {
    return catalogued.provider;
  }
  return inferClaudeCodeProvider(model);
}

export function routeKey(route: Pick<ModelRoute, "harnessId" | "providerId" | "model">): string {
  return `${route.harnessId}::${route.providerId}::${route.model}`;
}

function addRoute(routes: ModelRoute[], seen: Set<string>, route: ModelRoute): void {
  const key = routeKey(route);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  routes.push(route);
}

function normalizeCustomRoute(route: ModelRouteConfig): ModelRoute {
  const base = route.harnessId === "codex" ? disabledCapabilities() : neutralCapabilities();
  return {
    harnessId: route.harnessId || "claude-code",
    providerId: route.providerId || inferModelProvider(route.model),
    model: route.model,
    runtimeModel: route.runtimeModel,
    label: route.label || route.model,
    description: route.description,
    pricing: route.pricing || pricingForModel(route.model),
    capabilities: mergeCapabilities(base, route.capabilities),
    enabled: route.enabled ?? true,
  };
}

function pricingFromCatalog(model: CatalogModel): ModelPricing {
  if (model.subscription && model.inPerM == null) {
    return { billing: "subscription", directPrice: "Subscription", context: model.context, note: "Routed via subscription; token prices shown for comparison where available." };
  }
  const inP = model.inPerM;
  const outP = model.outPerM;
  const directPrice = inP != null && outP != null ? `$${inP} in / $${outP} out` : undefined;
  return {
    billing: model.subscription ? "subscription" : "token",
    inputUsdPerM: inP,
    outputUsdPerM: outP,
    ioUsdPerM: model.ioPerM,
    directPrice,
    context: model.context,
  };
}

export function pricingForModel(model: string): ModelPricing | undefined {
  const catalogued = resolveCatalogModel(model);
  return catalogued ? pricingFromCatalog(catalogued) : undefined;
}

export function runtimeModelFor(model: string, customRoutes: ModelRouteConfig[] = []): string {
  const lower = model.toLowerCase();
  const configured = customRoutes.find((route) => (route.harnessId || "claude-code") === "claude-code" && route.model.toLowerCase() === lower);
  if (configured?.runtimeModel) {
    return configured.runtimeModel;
  }
  // Resolve any spelling back to the catalog entry and send ITS harness id:
  // "anthropic/claude-opus-5" must reach the Claude harness as "claude-opus-5[1m]"
  // (native), never be forwarded verbatim into the router path.
  const catalogued = resolveCatalogModel(model);
  return catalogued ? catalogued.runtimeModel || catalogued.id : model;
}

export function displayModelFor(model: string): string {
  const catalogued = resolveCatalogModel(model);
  return catalogued?.label || model;
}

function capabilitiesFromCatalog(model: CatalogModel): ModelCapabilities {
  const reasoning = model.reasoning || undefined;
  const effort = reasoning?.effort;
  const thinking = reasoning?.thinking;
  return {
    effort: effort
      ? {
          supported: true,
          // A single-option spec is informational — the provider serves exactly
          // one configuration (e.g. Cursor's grok-4.5 is high+fast only), and
          // showing it beats hiding it, but there is nothing to switch to.
          mutableDuringSession: effort.options.length > 1,
          defaultValue: effort.default,
          options: effort.options.map((level) => ({ id: level, label: effortLabel(level) })),
        }
      : { supported: false, mutableDuringSession: true, options: [] },
    serviceTier: model.provider === "cursor" && model.serviceTier
      ? {
          supported: true,
          mutableDuringSession: model.serviceTier.options.length > 1,
          defaultValue: model.serviceTier.default,
          options: model.serviceTier.options.map((tier) => ({ id: tier, label: tier === "fast" ? "Fast" : "Standard" })),
        }
      : undefined,
    thinking: thinking
      ? {
          supported: true,
          mutableDuringSession: true,
          defaultValue: thinking.default,
          defaultEnabled: thinking.default !== "disabled",
          modes: thinking.modes.map((mode) => ({ id: mode, label: thinkingLabel(mode) })),
          budget: reasoning?.budget,
        }
      : { supported: false, mutableDuringSession: false, defaultEnabled: false },
    permission: standardPermissionCapability(),
    vision: visionFromCatalog(model),
  };
}

/** Vision capability of a catalog entry (empty = unknown). */
function visionFromCatalog(model: CatalogModel): VisionCapability {
  const v = model.vision;
  return v ? { image: v.image, video: v.video, maxImages: v.maxImages, maxBytesPerImage: v.maxBytesPerImage } : {};
}

/**
 * Resolves the multimodal support of an effective model id, tolerating every id
 * form the app uses (catalog id, runtime alias, concrete OpenRouter id, and the
 * Codex account slug spelling variants — all handled by the single
 * {@link resolveCatalogModel} resolver). Empty = unknown. Used by the adapters
 * as a text-only safety net and by the UI to gate/annotate attachments.
 */
export function visionForModel(model: string): VisionCapability {
  const found = resolveCatalogModel(model);
  return found ? visionFromCatalog(found) : {};
}

function standardPermissionCapability(): PermissionCapability {
  return {
    supported: true,
    mutableDuringSession: true,
    defaultValue: "default",
    options: [
      { id: "default", label: "Default" },
      { id: "acceptEdits", label: "Accept edits" },
      { id: "plan", label: "Plan" },
      { id: "auto", label: "Auto" },
      { id: "dontAsk", label: "Do not ask" },
    ],
  };
}

function neutralCapabilities(): ModelCapabilities {
  return {
    effort: { supported: true, mutableDuringSession: true, defaultValue: "medium", options: ["low", "medium", "high", "xhigh", "max"].map((level) => ({ id: level, label: effortLabel(level) })) },
    thinking: { supported: false, mutableDuringSession: false, defaultEnabled: false },
    permission: standardPermissionCapability(),
    vision: {},
  };
}

function disabledCapabilities(): ModelCapabilities {
  return {
    effort: { supported: false, mutableDuringSession: false, options: [] },
    thinking: { supported: false, mutableDuringSession: false },
    permission: { supported: false, mutableDuringSession: false, options: [] },
    vision: {},
  };
}

function mergeCapabilities(base: ModelCapabilities, override: PartialModelCapabilities | undefined): ModelCapabilities {
  if (!override) {
    return base;
  }
  return {
    effort: {
      ...base.effort,
      ...override.effort,
      options: normalizeOptions(override.effort?.options) || base.effort.options,
    },
    thinking: {
      ...base.thinking,
      ...override.thinking,
    },
    serviceTier: override.serviceTier
      ? {
          ...(base.serviceTier || { supported: false, mutableDuringSession: false, options: [] }),
          ...override.serviceTier,
          options: normalizeOptions(override.serviceTier.options) || base.serviceTier?.options || [],
        }
      : base.serviceTier,
    permission: {
      ...base.permission,
      ...override.permission,
      options: normalizeOptions(override.permission?.options) || base.permission.options,
    },
    vision: { ...base.vision, ...override.vision },
  };
}

function normalizeOptions(options: Array<ModelOption | string> | undefined): ModelOption[] | undefined {
  if (!options) {
    return undefined;
  }
  return options.map((option) => (typeof option === "string" ? { id: option, label: option } : option));
}

function effortLabel(level: string): string {
  const labels: Record<string, string> = {
    none: "None",
    minimal: "Minimal",
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
  };
  return labels[level] || level;
}

function thinkingLabel(mode: string): string {
  const labels: Record<string, string> = {
    enabled: "On",
    adaptive: "Adaptive",
    disabled: "Off",
  };
  return labels[mode] || mode;
}

/** An Anthropic-family model spelling (native on the claude-code harness). */
const ANTHROPIC_FAMILY = /^(claude-(sonnet|opus|haiku|fable|mythos)|sonnet|opus|haiku|fable|mythos)/;

/**
 * Provider for a model that is NOT in the catalog — a user custom route or an
 * id not yet catalogued. The catalog owns every KNOWN model (resolved before
 * this fallback runs, see {@link inferModelProvider}); this makes only the one
 * routing-relevant distinction: native Anthropic vs router-backed. It never
 * guesses a specific token provider (openai vs custom) from the bare name —
 * both route through the router backend identically, so an "openai" guess would
 * be indistinguishable in transport yet claim knowledge the id does not carry.
 * Only "anthropic" changes the transport (to the native path), so only the
 * Anthropic family and the native `default` alias are singled out — a new
 * Anthropic model id therefore works natively before it is catalogued.
 */
function inferClaudeCodeProvider(model: string): ModelProviderId {
  const lower = model.toLowerCase();
  if (lower.startsWith("openrouter/") || lower.startsWith("openrouter:")) {
    return "openrouter";
  }
  if (lower === "default" || ANTHROPIC_FAMILY.test(lower)) {
    return "anthropic";
  }
  return "custom";
}

/** Whether the user can turn reasoning off for this thinking spec. */
export function reasoningCanDisable(spec: ReasoningThinkingSpec | undefined): boolean {
  return Boolean(spec?.modes.includes("disabled"));
}
