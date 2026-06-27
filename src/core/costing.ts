import { TurnCost } from "./events";
import { ModelPricing, ModelProviderId } from "./modelRegistry";

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  generationId?: string;
  costUnavailableReason?: string;
}

export interface TurnCostContext {
  providerId: ModelProviderId;
  model: string;
  runtimeModel: string;
  pricing?: ModelPricing;
  harnessCostUsd?: number;
  usage?: TurnUsage;
}

export interface TurnCostResolver {
  resolve(context: TurnCostContext): Promise<TurnCost>;
}

interface CostProvider {
  supports(context: TurnCostContext): boolean;
  resolve(context: TurnCostContext): Promise<TurnCost | undefined>;
}

export class DefaultTurnCostResolver implements TurnCostResolver {
  private readonly providers: CostProvider[];

  constructor(providers: CostProvider[] = [new OpenRouterCostProvider(), new CodexSubscriptionCostProvider(), new ClaudeCodeCostProvider()]) {
    this.providers = providers;
  }

  async resolve(context: TurnCostContext): Promise<TurnCost> {
    for (const provider of this.providers) {
      if (!provider.supports(context)) {
        continue;
      }
      const cost = await provider.resolve(context);
      if (cost) {
        return cost;
      }
    }
    if (context.pricing?.billing === "free") {
      return { amountUsd: 0, source: "estimate", basis: "free", label: "$0.0000", detail: "Free model route." };
    }
    return { source: "unknown", basis: "unavailable", label: "cost unavailable" };
  }
}

class ClaudeCodeCostProvider implements CostProvider {
  supports(context: TurnCostContext): boolean {
    return context.providerId === "anthropic" || typeof context.harnessCostUsd === "number";
  }

  async resolve(context: TurnCostContext): Promise<TurnCost | undefined> {
    if (typeof context.harnessCostUsd !== "number") {
      return undefined;
    }
    return {
      amountUsd: context.harnessCostUsd,
      source: "claude-code",
      basis: "harness-reported",
      label: formatUsd(context.harnessCostUsd),
      detail: "Reported by Claude Code SDK.",
    };
  }
}

class CodexSubscriptionCostProvider implements CostProvider {
  supports(context: TurnCostContext): boolean {
    return context.providerId === "openai" && context.pricing?.billing === "subscription";
  }

  async resolve(context: TurnCostContext): Promise<TurnCost> {
    return {
      source: "codex",
      basis: "subscription",
      label: context.pricing?.directPrice || "subscription",
      detail: "Subscription-backed route; no per-turn token bill is available from this harness.",
    };
  }
}

class OpenRouterCostProvider implements CostProvider {
  supports(context: TurnCostContext): boolean {
    return context.providerId === "openrouter";
  }

  async resolve(context: TurnCostContext): Promise<TurnCost> {
    const providerReported = directOpenRouterCost(context);
    if (providerReported) {
      return providerReported;
    }

    const generationCost = await this.resolveGenerationCost(context);
    if (generationCost) {
      return generationCost;
    }

    return {
      source: "openrouter",
      basis: "unavailable",
      label: "OpenRouter cost unavailable",
      detail: [
        "OpenRouter provider-reported cost was not available for this turn.",
        context.usage?.generationId ? `Generation id: ${context.usage.generationId}.` : "No OpenRouter generation id was exposed.",
        context.usage?.costUnavailableReason ? `Reason: ${context.usage.costUnavailableReason}` : "",
        "Claude Code harness token/cost accounting is intentionally not used for OpenRouter routes.",
      ].filter(Boolean).join(" "),
    };
  }

  private async resolveGenerationCost(context: TurnCostContext): Promise<TurnCost | undefined> {
    const generationId = context.usage?.generationId;
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!generationId || !apiKey) {
      return undefined;
    }
    try {
      const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(generationId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        return undefined;
      }
      const payload = (await response.json()) as unknown;
      const amountUsd = extractOpenRouterGenerationCost(payload);
      if (typeof amountUsd !== "number") {
        return undefined;
      }
      return {
        amountUsd,
        source: "openrouter",
        basis: "provider-reported",
        label: formatUsd(amountUsd),
        detail: `Fetched from OpenRouter generation stats (${generationId}).`,
      };
    } catch {
      return undefined;
    }
  }
}

function directOpenRouterCost(context: TurnCostContext): TurnCost | undefined {
  const amountUsd = context.usage?.costUsd;
  if (typeof amountUsd !== "number") {
    return undefined;
  }
  return {
    amountUsd,
    source: "openrouter",
    basis: "provider-reported",
    label: formatUsd(amountUsd),
    detail: "Reported by OpenRouter usage accounting.",
  };
}

function estimateTokenCost(context: TurnCostContext): TurnCost | undefined {
  const inputTokens = context.usage?.inputTokens ?? context.usage?.promptTokens;
  const outputTokens = context.usage?.outputTokens ?? context.usage?.completionTokens;
  if (
    context.pricing?.billing !== "token" ||
    typeof context.pricing.inputUsdPerM !== "number" ||
    typeof context.pricing.outputUsdPerM !== "number" ||
    typeof inputTokens !== "number" ||
    typeof outputTokens !== "number"
  ) {
    return undefined;
  }
  const amountUsd = (inputTokens / 1_000_000) * context.pricing.inputUsdPerM + (outputTokens / 1_000_000) * context.pricing.outputUsdPerM;
  return {
    amountUsd,
    source: "openrouter",
    basis: "estimated",
    label: formatUsd(amountUsd),
    detail: [
      `Estimated from configured OpenRouter pricing (${inputTokens} input, ${outputTokens} output tokens).`,
      context.usage?.costUnavailableReason ? `Provider cost unavailable: ${context.usage.costUnavailableReason}` : "",
    ].filter(Boolean).join(" "),
  };
}

function extractOpenRouterGenerationCost(payload: unknown): number | undefined {
  const root = asRecord(payload);
  const data = asRecord(root?.data) || root;
  const cost =
    numberValue(data?.total_cost) ??
    numberValue(data?.cost) ??
    numberValue(asRecord(data?.usage)?.cost) ??
    numberValue(asRecord(root?.usage)?.cost);
  return cost;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}
