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

/**
 * Per-model multimodal input support. `image: false` = text-only (attaching an
 * image is refused with a visible error, never silently dropped). Omitted =
 * unknown (treated optimistically — attach allowed, model surfaces any error).
 */
export interface VisionSpec {
  image: boolean;
  video?: boolean;
  /** Max images per turn this model accepts (advisory; UI caps to it). */
  maxImages?: number;
  /** Max bytes per image (advisory; UI caps to it). */
  maxBytesPerImage?: number;
}

export interface CatalogModel {
  id: string;
  label: string;
  provider: CatalogProvider;
  /** Model id sent to the harness; for OpenRouter models this is the `claude-*` alias. */
  runtimeModel?: string;
  /** Codex account slug sent to thread/turn (e.g. "gpt-5.6-sol"). Presence = the model runs on the codex harness. */
  codexModel?: string;
  /** Claude OAuth model id exposed by local CLIProxyAPI for Codex-harness cross-routing. */
  claudeSubscriptionModel?: string;
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
  /** Multimodal input support. Omitted = unknown. */
  vision?: VisionSpec;
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
  return MODELS.find(
    (m) =>
      (m.runtimeModel || m.id).toLowerCase() === lower ||
      m.codexModel?.toLowerCase() === lower ||
      m.claudeSubscriptionModel?.toLowerCase() === lower,
  );
}

export function catalogModelByClaudeSubscriptionModel(model: string): CatalogModel | undefined {
  const lower = model.toLowerCase();
  return MODELS.find((m) => m.claudeSubscriptionModel?.toLowerCase() === lower);
}

/** Finds a catalog entry by its concrete OpenRouter model id (`orModelId`). */
export function catalogModelByOrModelId(orModelId: string): CatalogModel | undefined {
  const lower = orModelId.toLowerCase();
  return MODELS.find((m) => (m.orModelId || "").toLowerCase() === lower);
}

/**
 * Canonical comparison key for one spelling of a model id: lowercase, the
 * optional "<provider>/" prefix and "[1m]" long-context suffix stripped, and
 * separator characters removed — so "claude-opus-4-8[1m]" (the id the Claude
 * harness reports at session init), "claude-opus-4.8" (version-dot spelling)
 * and "anthropic/claude-opus-4.8" (OpenRouter id) all collapse to one key.
 */
function canonicalModelKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/^[a-z0-9-]+\//, "")
    .replace(/\[1m\]$/, "")
    .replace(/[\s._-]+/g, "");
}

/**
 * Resolves ANY spelling of a model to its catalog entry: catalog id, runtime
 * alias, codex slug, concrete OpenRouter id, display label, or the harness's
 * canonical id ("claude-opus-4-8[1m]" → opus[1m]). One resolver so a live
 * session's self-reported model always finds its way back to the entry that
 * carries capabilities (reasoning/vision), pricing, and leaderboard meta —
 * a session echoing "claude-opus-4-8[1m]" used to resolve to NO entry, which
 * silently dropped the Runtime modal's thinking (Adaptive) control.
 */
export function resolveCatalogModel(model: string): CatalogModel | undefined {
  if (!model) {
    return undefined;
  }
  const direct = catalogModelById(model) || catalogModelByRuntime(model) || catalogModelByOrModelId(model);
  if (direct) {
    return direct;
  }
  const lower = model.toLowerCase();
  const byLabel = MODELS.find((m) => m.label.toLowerCase() === lower);
  if (byLabel) {
    return byLabel;
  }
  const key = canonicalModelKey(model);
  return MODELS.find(
    (m) =>
      canonicalModelKey(m.id) === key ||
      (m.orModelId ? canonicalModelKey(m.orModelId) === key : false) ||
      (m.runtimeModel ? canonicalModelKey(m.runtimeModel) === key : false) ||
      (m.codexModel ? canonicalModelKey(m.codexModel) === key : false) ||
      (m.claudeSubscriptionModel ? canonicalModelKey(m.claudeSubscriptionModel) === key : false),
  );
}

/**
 * Parses a catalog `context` display string ("1M", "200K", "1.05M") into an
 * absolute token count for the context-capacity meter. Returns undefined for
 * the unknown placeholder ("—") or anything unparseable — the meter then shows
 * used tokens without a ratio rather than inventing a wrong denominator (no
 * silent fallback to a made-up window size).
 */
export function parseContextTokens(text: string | undefined): number | undefined {
  if (!text) {
    return undefined;
  }
  const match = /^\s*([\d.]+)\s*([KMB]?)\s*$/i.exec(text);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  const scale = { "": 1, K: 1e3, M: 1e6, B: 1e9 }[match[2].toUpperCase()] ?? 1;
  return Math.round(value * scale);
}

/** OpenRouter models only (provider openrouter with a concrete OR id). */
export function openRouterModels(): CatalogModel[] {
  return MODELS.filter((m) => m.provider === "openrouter" && Boolean(m.orModelId));
}

/** Codex account models (provider openai with a codex slug) — run on the codex harness. */
export function codexAccountModels(): CatalogModel[] {
  return MODELS.filter((m) => m.provider === "openai" && Boolean(m.codexModel));
}

/** Anthropic subscription models exposed to the Codex harness via CLIProxyAPI. */
export function claudeSubscriptionModels(): CatalogModel[] {
  return MODELS.filter((m) => m.provider === "anthropic" && Boolean(m.claudeSubscriptionModel));
}

/**
 * Every model with a concrete OpenRouter id, ANY provider — the set the codex
 * harness routes through its OpenRouter custom provider. Superset of
 * openRouterModels(): anthropic entries with an orModelId (Opus/Sonnet/Haiku)
 * are OpenRouter-routable on codex while staying native on claude-code.
 */
export function orRoutedModels(): CatalogModel[] {
  return openRouterModels();
}

/** runtimeModel/id -> OpenRouter model id, for the embedded router. */
export function openRouterAliasMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of openRouterModels()) {
    if (m.runtimeModel && m.orModelId) {
      map[(m.runtimeModel || m.id).toLowerCase()] = m.orModelId;
      map[m.id.toLowerCase()] = m.orModelId;
    }
  }
  return map;
}

export type RouterTarget =
  | { kind: "codex-subscription"; model: string }
  | { kind: "openrouter"; model: string };

/** Exact provider target for one Claude-Code router alias. */
export function routerTargetForModel(model: string): RouterTarget | undefined {
  const entry = catalogModelByRuntime(model) || catalogModelById(model);
  if (!entry?.runtimeModel) {
    return undefined;
  }
  if (entry.provider === "openai" && entry.codexModel) {
    return { kind: "codex-subscription", model: entry.codexModel };
  }
  if (entry.provider === "openrouter" && entry.orModelId) {
    return { kind: "openrouter", model: entry.orModelId };
  }
  return undefined;
}

/** Whether a thinking spec lets the user turn reasoning off. */
export function thinkingCanDisable(spec: ReasoningThinkingSpec | undefined): boolean {
  return Boolean(spec?.modes.includes("disabled"));
}
