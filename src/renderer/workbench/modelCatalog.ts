/**
 * Static display metadata for the Runtime modal. Real model routes come from
 * the main process; this catalog supplies the human-facing detail (tier, perf,
 * cost, context, thinking support, effort options) the prototype renders.
 *
 * A model that is not in the catalog still renders with sensible neutral
 * defaults, so an unknown route never disappears from the picker.
 */

export type ProviderId = "anthropic" | "openai" | "openrouter" | "custom";

export interface ModelMeta {
  /** Matches the route model id (or a runtime model alias). */
  id: string;
  name: string;
  provider: ProviderId;
  tier: string;
  perf: 1 | 2 | 3 | 4;
  cost: 1 | 2 | 3 | 4 | 5;
  inPerM: string;
  outPerM: string;
  context: string;
  thinking: boolean;
  efforts: string[];
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  custom: "Custom",
};

export const PROVIDER_DOTS: Record<ProviderId, string> = {
  anthropic: "#e0a14e",
  openai: "#54b585",
  openrouter: "#a07bff",
  custom: "#79808d",
};

export const MODEL_CATALOG: ModelMeta[] = [
  { id: "claude-opus-4.1", name: "claude-opus-4.1", provider: "anthropic", tier: "Frontier", perf: 4, cost: 5, inPerM: "$15", outPerM: "$75", context: "200K", thinking: true, efforts: ["low", "medium", "high"] },
  { id: "claude-sonnet-4.5", name: "claude-sonnet-4.5", provider: "anthropic", tier: "Frontier", perf: 4, cost: 4, inPerM: "$3", outPerM: "$15", context: "200K", thinking: true, efforts: ["low", "medium", "high"] },
  { id: "claude-haiku-4", name: "claude-haiku-4", provider: "anthropic", tier: "Fast", perf: 2, cost: 2, inPerM: "$0.80", outPerM: "$4", context: "200K", thinking: false, efforts: ["low", "medium"] },
  { id: "gpt-5", name: "gpt-5", provider: "openai", tier: "Frontier", perf: 4, cost: 3, inPerM: "$1.25", outPerM: "$10", context: "400K", thinking: true, efforts: ["minimal", "low", "medium", "high"] },
  { id: "o4-mini", name: "o4-mini", provider: "openai", tier: "Balanced", perf: 3, cost: 2, inPerM: "$1.10", outPerM: "$4.40", context: "200K", thinking: true, efforts: ["low", "medium", "high"] },
  { id: "deepseek-v3.2", name: "deepseek-v3.2", provider: "openrouter", tier: "Balanced", perf: 3, cost: 1, inPerM: "$0.27", outPerM: "$1.10", context: "164K", thinking: false, efforts: ["low", "medium", "high"] },
];

const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function modelMeta(modelId: string, provider?: ProviderId): ModelMeta {
  const found = MODEL_CATALOG.find((meta) => meta.id === modelId);
  if (found) {
    return found;
  }
  return {
    id: modelId,
    name: modelId || "model",
    provider: provider || "anthropic",
    tier: "Custom",
    perf: 3,
    cost: 3,
    inPerM: "—",
    outPerM: "—",
    context: "—",
    thinking: false,
    efforts: DEFAULT_EFFORTS,
  };
}
