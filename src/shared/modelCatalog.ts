/**
 * Typed access to the model catalog (src/shared/modelCatalog.json) — the single
 * source of truth for routing, leaderboard metrics and per-model reasoning
 * control. Both the main process (model registry, router) and the renderer
 * (Runtime modal) read the same data, so adding a model means adding one JSON
 * entry. No per-model logic lives in code.
 */
import catalog from "./modelCatalog.json";

export type CatalogProvider = "anthropic" | "openai" | "openrouter";

/** Effort levels transportable to the harness (SDK `effort`). */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
/** Thinking modes transportable to the harness (SDK `thinking.type`). */
export type ThinkingMode = "adaptive" | "enabled" | "disabled";

export interface ReasoningEffortSpec {
  options: EffortLevel[];
  default: EffortLevel;
}

export interface ReasoningThinkingSpec {
  /** Selectable modes; presence of "disabled" means the user can turn reasoning off. */
  modes: ThinkingMode[];
  default: ThinkingMode;
}

export interface ReasoningBudgetSpec {
  default: number;
  min?: number;
  max?: number;
}

/** Per-model reasoning control. Omitted/null = the model has no reasoning control. */
export interface ReasoningSpec {
  effort?: ReasoningEffortSpec;
  thinking?: ReasoningThinkingSpec;
  budget?: ReasoningBudgetSpec;
}

export interface CatalogModel {
  id: string;
  label: string;
  provider: CatalogProvider;
  /** Model id sent to the harness; for OpenRouter models this is the `claude-*` alias. */
  runtimeModel?: string;
  /** Concrete OpenRouter model id the router forwards to. */
  orModelId?: string;
  subscription: boolean;
  description?: string;
  context?: string;
  /** Leaderboard '칸' performance tier, 0-5. */
  perf?: number;
  /** Leaderboard '비용' cost tier, 1-5. */
  costTier?: number;
  inPerM?: number;
  outPerM?: number;
  ioPerM?: number;
  reasoning?: ReasoningSpec | null;
}

const MODELS: CatalogModel[] = (catalog as { models: CatalogModel[] }).models;

export function modelCatalog(): CatalogModel[] {
  return MODELS;
}

export function catalogModelById(id: string): CatalogModel | undefined {
  const lower = id.toLowerCase();
  return MODELS.find((m) => m.id.toLowerCase() === lower);
}

export function catalogModelByRuntime(runtimeModel: string): CatalogModel | undefined {
  const lower = runtimeModel.toLowerCase();
  return MODELS.find((m) => (m.runtimeModel || m.id).toLowerCase() === lower);
}

/** Finds a catalog entry by its concrete OpenRouter model id (`orModelId`). */
export function catalogModelByOrModelId(orModelId: string): CatalogModel | undefined {
  const lower = orModelId.toLowerCase();
  return MODELS.find((m) => (m.orModelId || "").toLowerCase() === lower);
}

/** OpenRouter models only (provider openrouter with a concrete OR id). */
export function openRouterModels(): CatalogModel[] {
  return MODELS.filter((m) => m.provider === "openrouter" && Boolean(m.orModelId));
}

/** runtimeModel/id -> OpenRouter model id, for the embedded router. */
export function openRouterAliasMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of openRouterModels()) {
    if (m.orModelId) {
      map[(m.runtimeModel || m.id).toLowerCase()] = m.orModelId;
      map[m.id.toLowerCase()] = m.orModelId;
    }
  }
  return map;
}

/** Whether a thinking spec lets the user turn reasoning off. */
export function thinkingCanDisable(spec: ReasoningThinkingSpec | undefined): boolean {
  return Boolean(spec?.modes.includes("disabled"));
}
