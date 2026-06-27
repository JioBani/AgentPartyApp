export type HarnessId = "claude-code" | "codex";
export type ModelProviderId = "anthropic" | "openrouter" | "openai" | "custom";

export interface HarnessDescriptor {
  id: HarnessId;
  label: string;
  enabled: boolean;
  description?: string;
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
  enabled: boolean;
}

export interface ModelPricing {
  billing: "subscription" | "token" | "free" | "unknown";
  inputUsdPerM?: number;
  outputUsdPerM?: number;
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

export interface ThinkingCapability {
  supported: boolean;
  mutableDuringSession: boolean;
  defaultEnabled?: boolean;
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

const manualClaudeCodeModels: Array<Record<string, unknown>> = [
  {
    value: "default",
    displayName: "Default (recommended)",
    description: "Claude Code default model. Uses the account/default routing selected by Claude Code.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "opus[1m]",
    displayName: "Opus",
    description: "Opus with 1M context. Best for complex work.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    displayName: "Sonnet",
    description: "Sonnet. Efficient default for routine coding tasks.",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    displayName: "Haiku",
    description: "Haiku. Fastest for quick answers.",
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsAdaptiveThinking: false,
  },
];

const documentedClaudeCodeRoutes: ModelRoute[] = [
  route("claude-code", "openai", "GPT-5.5", "claude-gpt-5.5", "GPT-5.5", "Routes through the AgentParty Codex backend.", {
    billing: "subscription",
    directPrice: "ChatGPT/Codex subscription",
    note: "Subscription route. No separate token price is shown for this local Codex bridge.",
  }),
  route("claude-code", "openai", "GPT-5.4", "claude-gpt-5.4", "GPT-5.4", "Routes through the AgentParty Codex backend.", {
    billing: "subscription",
    directPrice: "ChatGPT/Codex subscription",
    note: "Subscription route. No separate token price is shown for this local Codex bridge.",
  }),
  route("claude-code", "openai", "GPT-5.4 mini", "claude-gpt-5.4-mini", "GPT-5.4 mini", "Routes through the AgentParty Codex backend.", {
    billing: "subscription",
    directPrice: "ChatGPT/Codex subscription",
    note: "Subscription route. No separate token price is shown for this local Codex bridge.",
  }),
  route("claude-code", "openrouter", "GLM-5.2", "claude-glm", "GLM-5.2", "AgentParty router alias for z-ai/glm-5.2.", {
    billing: "token",
    inputUsdPerM: 0.98,
    outputUsdPerM: 3.08,
    directPrice: "$1.40 in / $0.26 cached in / $4.40 out",
    context: "1M",
    performance: "A+ / frontier candidate",
  }),
  route("claude-code", "openrouter", "MiniMax M3", "claude-minimax", "MiniMax M3", "AgentParty router alias for minimax/minimax-m3.", {
    billing: "token",
    inputUsdPerM: 0.30,
    outputUsdPerM: 1.20,
    directPrice: "$0.30 in / $1.20 out; higher tiers can apply past provider thresholds",
    context: "1M",
    performance: "A+ / frontier candidate",
  }),
  route("claude-code", "openrouter", "Qwen3.7-Max", "claude-qwen", "Qwen3.7-Max", "AgentParty router alias for qwen/qwen3.7-max.", {
    billing: "token",
    inputUsdPerM: 1.25,
    outputUsdPerM: 3.75,
    directPrice: "Alibaba/OpenRouter original may be $2.50 in / $7.50 out",
    context: "1M",
    performance: "A+ / frontier candidate",
  }),
  route("claude-code", "openrouter", "Qwen3 Coder", "claude-coder", "Qwen3 Coder", "AgentParty router alias for qwen/qwen3-coder.", {
    billing: "token",
    inputUsdPerM: 0.22,
    outputUsdPerM: 1.80,
    context: "1M",
    performance: "A / coding worker",
    note: "Existing AgentParty alias. The comparison file also lists Qwen3 Coder Plus separately.",
  }),
  route("claude-code", "openrouter", "Qwen3.7-Max (OpenRouter)", "claude-qwen", "Qwen3.7-Max (OpenRouter)", "OpenRouter model id from the comparison file.", {
    billing: "token",
    inputUsdPerM: 1.25,
    outputUsdPerM: 3.75,
    directPrice: "Alibaba/OpenRouter original may be $2.50 in / $7.50 out",
    context: "1M",
    performance: "A+ / frontier candidate",
  }),
  route("claude-code", "openrouter", "Kimi K2.7 Code", undefined, "Kimi K2.7 Code", "OpenRouter model id from the comparison file.", {
    billing: "token",
    inputUsdPerM: 0.68,
    outputUsdPerM: 3.41,
    directPrice: "$0.95 cache-miss in / $0.19 cached in / $4.00 out",
    context: "262K",
    performance: "A / Claude Code-compatible candidate",
    note: "Thinking/reasoning_content handling depends on the router/proxy.",
  }),
  route("claude-code", "openrouter", "Qwen3 Coder Plus", undefined, "Qwen3 Coder Plus", "OpenRouter model id verified from model listings.", {
    billing: "token",
    inputUsdPerM: 0.65,
    outputUsdPerM: 3.25,
    directPrice: "Some listings show $1 in / $5 out and $0.10 cached in; verify active provider.",
    context: "128K-1M",
    performance: "A / coding worker",
    note: "May need router config support before use.",
  }),
  route("claude-code", "openrouter", "GLM-5.2 (OpenRouter)", "claude-glm", "GLM-5.2 (OpenRouter)", "OpenRouter model id from the comparison file.", {
    billing: "token",
    inputUsdPerM: 0.98,
    outputUsdPerM: 3.08,
    directPrice: "$1.40 in / $0.26 cached in / $4.40 out",
    context: "1M",
    performance: "A+ / frontier candidate",
  }),
  route("claude-code", "openrouter", "Qwen3.7 Plus", undefined, "Qwen3.7 Plus", "OpenRouter model id from the comparison file.", {
    billing: "token",
    inputUsdPerM: 0.32,
    outputUsdPerM: 1.28,
    context: "1M",
    performance: "A / value long-context candidate",
    note: "May need router config support before use.",
  }),
  route("claude-code", "openrouter", "MiniMax M3 (OpenRouter)", "claude-minimax", "MiniMax M3 (OpenRouter)", "OpenRouter model id from the comparison file.", {
    billing: "token",
    inputUsdPerM: 0.30,
    outputUsdPerM: 1.20,
    directPrice: "$0.30 in / $1.20 out; higher tiers can apply past provider thresholds",
    context: "1M",
    performance: "A+ / frontier candidate",
  }),
  route("claude-code", "openrouter", "MiniMax M2.7", undefined, "MiniMax M2.7", "OpenRouter model id verified from current listings.", {
    billing: "token",
    inputUsdPerM: 0.30,
    outputUsdPerM: 1.20,
    context: "205K",
    performance: "A / build-edit worker",
    note: "May need router config support before use.",
  }),
  route("claude-code", "openrouter", "Qwen3 Coder 480B A35B Free", undefined, "Qwen3 Coder 480B A35B Free", "OpenRouter free endpoint model id.", {
    billing: "free",
    inputUsdPerM: 0,
    outputUsdPerM: 0,
    context: "1M",
    performance: "B / cheap background worker",
    note: "Free endpoints can have rate limits, provider variability, and weaker SLA.",
  }),
];

const backendModelAliases: Record<string, string> = {
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 mini",
  "z-ai/glm-5.2": "GLM-5.2",
  "minimax/minimax-m3": "MiniMax M3",
  "qwen/qwen3.7-max": "Qwen3.7-Max",
  "qwen/qwen3-coder": "Qwen3 Coder",
};

export function buildModelRoutes(currentModel: string, claudeModels: unknown[], customRoutes: ModelRouteConfig[] = []): ModelRoute[] {
  const routes: ModelRoute[] = [];
  const seen = new Set<string>();

  for (const model of claudeModels) {
    const route = normalizeClaudeModel(model);
    if (!route) {
      continue;
    }
    addRoute(routes, seen, route);
  }

  for (const model of manualClaudeCodeModels) {
    const route = normalizeClaudeModel(model);
    if (route) {
      addRoute(routes, seen, route);
    }
  }

  addRoute(routes, seen, {
    harnessId: "claude-code",
    providerId: inferModelProvider(currentModel, customRoutes),
    model: currentModel,
    label: currentModel,
    runtimeModel: runtimeModelFor(currentModel),
    pricing: pricingForModel(currentModel),
    capabilities: claudeCodeCapabilities(undefined),
    enabled: true,
  });

  for (const route of documentedClaudeCodeRoutes) {
    addRoute(routes, seen, route);
  }

  for (const route of customRoutes) {
    addRoute(routes, seen, normalizeCustomRoute(route));
  }

  addRoute(routes, seen, {
    harnessId: "claude-code",
    providerId: "openrouter",
    model: "openrouter/<provider>/<model>",
    label: "OpenRouter via Claude Code",
    description: "Configure agentpartyNative.models.customRoutes with your concrete router model id.",
    pricing: { billing: "unknown", note: "Pricing depends on the configured OpenRouter model." },
    capabilities: claudeCodeCapabilities(undefined),
    enabled: false,
  });

  addRoute(routes, seen, {
    harnessId: "codex",
    providerId: "openai",
    model: "gpt-5.5",
    label: "GPT via Codex",
    description: "Codex harness routing placeholder.",
    pricing: { billing: "subscription", directPrice: "ChatGPT/Codex subscription" },
    capabilities: disabledCapabilities(),
    enabled: false,
  });

  return routes;
}

export function inferModelProvider(model: string, customRoutes: ModelRouteConfig[] = []): ModelProviderId {
  const configured = customRoutes.find((route) => (route.harnessId || "claude-code") === "claude-code" && route.model === model);
  if (configured?.providerId) {
    return configured.providerId;
  }
  // Check known model name patterns before pricing — sonnet/opus/haiku have billing:"subscription"
  // for Claude Code credits, which would otherwise be misread as "openai".
  const fromPattern = inferClaudeCodeProvider(model);
  if (fromPattern !== "custom") {
    return fromPattern;
  }
  if (model.toLowerCase() === "minimax/minimax-m3") {
    return "openrouter";
  }
  const pricing = pricingForModel(model);
  if (pricing?.billing === "subscription") {
    return "openai";
  }
  if (pricing?.billing === "token" || pricing?.billing === "free") {
    return "openrouter";
  }
  return "custom";
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

function normalizeClaudeModel(value: unknown): ModelRoute | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const model = value as Record<string, unknown>;
  const id = stringValue(model.value) || stringValue(model.id) || stringValue(model.name);
  if (!id) {
    return undefined;
  }
  const displayName = stringValue(model.displayName) || stringValue(model.label) || id;
  return {
    harnessId: "claude-code",
    providerId: inferModelProvider(id),
    model: id,
    label: displayName,
    description: stringValue(model.description),
    pricing: pricingForModel(id),
    supportsEffort: booleanValue(model.supportsEffort),
    effortLevels: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.map(String) : undefined,
    capabilities: claudeCodeCapabilities(model),
    enabled: true,
  };
}

function normalizeCustomRoute(route: ModelRouteConfig): ModelRoute {
  const baseCapabilities = route.harnessId === "codex" ? disabledCapabilities() : claudeCodeCapabilities(undefined);
  return {
    harnessId: route.harnessId || "claude-code",
    providerId: route.providerId || inferModelProvider(route.model),
    model: route.model,
    runtimeModel: route.runtimeModel,
    label: route.label || route.model,
    description: route.description,
    pricing: route.pricing || pricingForModel(route.model),
    capabilities: mergeCapabilities(baseCapabilities, route.capabilities),
    enabled: route.enabled ?? true,
  };
}

function route(harnessId: HarnessId, providerId: ModelProviderId, model: string, runtimeModel: string | undefined, label: string, description: string, pricing: ModelPricing): ModelRoute {
  return {
    harnessId,
    providerId,
    model,
    runtimeModel,
    label,
    description,
    pricing,
    capabilities: harnessId === "codex" ? disabledCapabilities() : claudeCodeCapabilities(undefined),
    enabled: true,
  };
}

function pricingForModel(model: string): ModelPricing | undefined {
  const lower = canonicalModelName(model).toLowerCase();
  const matched = documentedClaudeCodeRoutes.find((route) => route.model.toLowerCase() === lower || route.runtimeModel?.toLowerCase() === lower);
  if (matched) {
    return matched.pricing;
  }
  if (lower === "sonnet" || lower === "sonnet[1m]" || lower.startsWith("claude-sonnet")) {
    return {
      billing: "subscription",
      inputUsdPerM: 3,
      outputUsdPerM: 15,
      directPrice: "$3 in / $15 out",
      context: lower.includes("1m") ? "1M" : undefined,
      performance: "S / baseline",
      note: "Claude Code may use subscription or usage credits; API token pricing is shown for comparison.",
    };
  }
  return undefined;
}

export function runtimeModelFor(model: string, customRoutes: ModelRouteConfig[] = []): string {
  const lower = canonicalModelName(model).toLowerCase();
  const configured = customRoutes.find((route) => (route.harnessId || "claude-code") === "claude-code" && route.model.toLowerCase() === lower);
  if (configured?.runtimeModel) {
    return configured.runtimeModel;
  }
  const documented = documentedClaudeCodeRoutes.find((route) => route.model.toLowerCase() === lower || route.runtimeModel?.toLowerCase() === lower);
  return documented?.runtimeModel || model;
}

export function displayModelFor(model: string): string {
  const canonical = canonicalModelName(model);
  const lower = canonical.toLowerCase();
  const documented = documentedClaudeCodeRoutes.find((route) => route.model.toLowerCase() === lower || route.runtimeModel?.toLowerCase() === lower);
  return documented?.label || canonical;
}

function canonicalModelName(model: string): string {
  return backendModelAliases[model.toLowerCase()] || model;
}

function claudeCodeCapabilities(model: Record<string, unknown> | undefined): ModelCapabilities {
  const supportedEffortLevels = Array.isArray(model?.supportedEffortLevels) ? model.supportedEffortLevels.map(String) : undefined;
  const effortLevels = supportedEffortLevels && supportedEffortLevels.length > 0 ? supportedEffortLevels : ["low", "medium", "high", "xhigh", "max"];
  const supportsEffort = model?.supportsEffort === false ? false : true;
  return {
    effort: {
      supported: supportsEffort,
      mutableDuringSession: true,
      defaultValue: "medium",
      options: supportsEffort ? effortLevels.map((level) => ({ id: level, label: effortLabel(level) })) : [],
    },
    thinking: {
      supported: false,
      mutableDuringSession: false,
      defaultEnabled: false,
    },
    permission: {
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
    },
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
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra high",
    max: "Max",
  };
  return labels[level] || level;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
