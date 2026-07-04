import {
  catalogModelById,
  catalogModelByRuntime,
  catalogModelByOrModelId,
  modelCatalog,
  openRouterModels,
  type CatalogModel,
  type ReasoningThinkingSpec,
} from "../shared/modelCatalog";
import type { CodexModelInfo } from "../shared/codexModels";
import { CODEX_OPENROUTER_PROVIDER } from "../shared/codexProviders";

export type HarnessId = "claude-code" | "codex";
export type ModelProviderId = "anthropic" | "openrouter" | "openai" | "custom";

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
];

export function buildModelRoutes(currentModel: string, _claudeModels: unknown[] = [], customRoutes: ModelRouteConfig[] = [], codexModels?: CodexModelInfo[]): ModelRoute[] {
  const routes: ModelRoute[] = [];
  const seen = new Set<string>();

  // The catalog is authoritative for the exposed model list (leaderboard-aligned).
  for (const model of modelCatalog()) {
    addRoute(routes, seen, routeFromCatalog(model));
  }
  // Codex harness: the live account catalog (model/list) when discovered; the
  // static default keeps the harness usable before/without discovery.
  for (const model of codexModels || []) {
    addRoute(routes, seen, codexRouteFromModel(model));
  }
  if (!codexModels?.length) {
    addRoute(routes, seen, codexDefaultRoute());
  }
  // Codex harness (Phase 2): every OpenRouter catalog model, routed through the
  // OpenRouter custom provider. These extend the account catalog so a Codex
  // member can run non-OpenAI models (docs/codex-ux-research/07-model-routing.md).
  for (const model of openRouterModels()) {
    addRoute(routes, seen, codexOpenRouterRoute(model));
  }

  // Keep the currently selected model visible even if it is not catalogued
  // (e.g. a user-configured custom route), so it never silently disappears.
  if (currentModel && !catalogModelById(currentModel) && !catalogModelByRuntime(currentModel)) {
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
  const catalogTwin = catalogMetaForCodexModel(model.model);
  return {
    harnessId: "codex",
    providerId: "openai",
    model: model.model,
    runtimeModel: model.model,
    label: model.displayName,
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
 * Finds the shared-catalog entry describing the same underlying model as a
 * Codex slug, tolerating spelling variants ("gpt-5.4-mini" vs "GPT-5.4 mini")
 * by comparing ids with separators stripped.
 */
function catalogMetaForCodexModel(slug: string): CatalogModel | undefined {
  const wanted = comparableModelId(slug);
  return modelCatalog().find((model) => comparableModelId(model.id) === wanted);
}

function comparableModelId(id: string): string {
  return id.toLowerCase().replace(/[\s._-]+/g, "");
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
    providerId: "openrouter",
    model: model.orModelId || model.id,
    runtimeModel: model.orModelId || model.id,
    modelProvider: CODEX_OPENROUTER_PROVIDER.id,
    label: model.label,
    description: `${model.description || ""} Runs on the Codex harness via OpenRouter (billed to your OpenRouter key).`.trim(),
    pricing: pricingFromCatalog(model),
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

function codexDefaultRoute(): ModelRoute {
  const capabilities = { ...disabledCapabilities(), vision: visionForModel("gpt-5.4") };
  return {
    harnessId: "codex",
    providerId: "openai",
    model: "gpt-5.4",
    runtimeModel: "gpt-5.4",
    label: "GPT-5.4 (Codex)",
    description: "Default Codex app-server model route.",
    pricing: { billing: "subscription", directPrice: "Codex subscription" },
    capabilities,
    enabled: true,
  };
}

function routeFromCatalog(model: CatalogModel): ModelRoute {
  return {
    harnessId: "claude-code",
    providerId: model.provider,
    model: model.id,
    runtimeModel: model.runtimeModel,
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
    enabled: true,
  };
}

export function inferModelProvider(model: string, customRoutes: ModelRouteConfig[] = []): ModelProviderId {
  const configured = customRoutes.find((route) => (route.harnessId || "claude-code") === "claude-code" && route.model === model);
  if (configured?.providerId) {
    return configured.providerId;
  }
  const catalogued = catalogModelById(model) || catalogModelByRuntime(model);
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
  const catalogued = catalogModelById(model) || catalogModelByRuntime(model) || catalogModelByOrModelId(model);
  return catalogued ? pricingFromCatalog(catalogued) : undefined;
}

export function runtimeModelFor(model: string, customRoutes: ModelRouteConfig[] = []): string {
  const lower = model.toLowerCase();
  const configured = customRoutes.find((route) => (route.harnessId || "claude-code") === "claude-code" && route.model.toLowerCase() === lower);
  if (configured?.runtimeModel) {
    return configured.runtimeModel;
  }
  const catalogued = catalogModelById(model);
  return catalogued?.runtimeModel || model;
}

export function displayModelFor(model: string): string {
  const catalogued = catalogModelById(model) || catalogModelByRuntime(model);
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
          mutableDuringSession: true,
          defaultValue: effort.default,
          options: effort.options.map((level) => ({ id: level, label: effortLabel(level) })),
        }
      : { supported: false, mutableDuringSession: true, options: [] },
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
 * Codex account slug spelling variants). Empty = unknown. Used by the adapters
 * as a text-only safety net and by the UI to gate/annotate attachments.
 */
export function visionForModel(model: string): VisionCapability {
  const found =
    catalogModelById(model) ||
    catalogModelByRuntime(model) ||
    catalogModelByOrModelId(model) ||
    catalogMetaForCodexModel(model);
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

function inferClaudeCodeProvider(model: string): ModelProviderId {
  const lower = model.toLowerCase();
  if (lower.startsWith("openrouter/") || lower.startsWith("openrouter:")) {
    return "openrouter";
  }
  if (lower.startsWith("gpt-") || lower.startsWith("o")) {
    return "openai";
  }
  if (
    lower === "default" ||
    lower.startsWith("sonnet") ||
    lower.startsWith("opus") ||
    lower.startsWith("haiku") ||
    lower.startsWith("claude-sonnet") ||
    lower.startsWith("claude-opus") ||
    lower.startsWith("claude-haiku")
  ) {
    return "anthropic";
  }
  return "custom";
}

/** Whether the user can turn reasoning off for this thinking spec. */
export function reasoningCanDisable(spec: ReasoningThinkingSpec | undefined): boolean {
  return Boolean(spec?.modes.includes("disabled"));
}
