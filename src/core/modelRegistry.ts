import {
  catalogModelById,
  catalogModelByRuntime,
  modelCatalog,
  type CatalogModel,
  type ReasoningThinkingSpec,
} from "../shared/modelCatalog";

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

export interface ModelCapabilities {
  effort: EffortCapability;
  thinking: ThinkingCapability;
  permission: PermissionCapability;
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
    enabled: false,
    description: "Reserved for Codex app-server harness.",
  },
];

export function buildModelRoutes(currentModel: string, _claudeModels: unknown[] = [], customRoutes: ModelRouteConfig[] = []): ModelRoute[] {
  const routes: ModelRoute[] = [];
  const seen = new Set<string>();

  // The catalog is authoritative for the exposed model list (leaderboard-aligned).
  for (const model of modelCatalog()) {
    addRoute(routes, seen, routeFromCatalog(model));
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
  const catalogued = catalogModelById(model) || catalogModelByRuntime(model);
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
  };
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
  };
}

function disabledCapabilities(): ModelCapabilities {
  return {
    effort: { supported: false, mutableDuringSession: false, options: [] },
    thinking: { supported: false, mutableDuringSession: false },
    permission: { supported: false, mutableDuringSession: false, options: [] },
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
