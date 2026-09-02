/**
 * Typed access to the model catalog (src/shared/modelCatalog.json) — the single
 * source of truth for routing, leaderboard metrics and per-model reasoning
 * control. Both the main process (model registry, router) and the renderer
 * (Runtime modal) read the same data, so adding a model means adding one JSON
 * entry. No per-model logic lives in code.
 *
 * The bundled JSON is only the release-time snapshot: the main process
 * overlays the remotely published catalog (see src/main/remoteModelCatalog.ts)
 * via {@link applyModelCatalog}, so new models reach users without an app
 * release. The renderer keeps its bundled copy — it consumes model data
 * through the main process's `models:list`/`models:update` payloads, and its
 * direct catalog reads are display-only fallbacks.
 */
import catalog from "./modelCatalog.json";

export type CatalogProvider = "anthropic" | "openai" | "openrouter" | "cursor" | "deepseek" | "xai";

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

export interface ServiceTierSpec {
  options: Array<"standard" | "fast">;
  default: "standard" | "fast";
}

/** Token list price for a provider-specific serving tier. */
export interface TokenPriceSpec {
  inPerM: number;
  outPerM: number;
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

export interface LongContextPriceSpec {
  thresholdTokens: number;
  inputMultiplier: number;
  outputMultiplier: number;
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
  /** Cursor Agent named-model slug. Presence opts this entry into the Cursor harness. */
  cursorModel?: string;
  /**
   * Cursor ACP modelId for CROSS-harness use (variants baked in, e.g.
   * "grok-4.5[effort=high,fast=true]"). Presence + provider "cursor" routes the
   * embedded gateway through the Cursor-subscription ACP bridge.
   */
  cursorAcpModelId?: string;
  /** Concrete OpenRouter model id the harness protocol gateway selects. */
  orModelId?: string;
  /**
   * Model id on DeepSeek's own API (e.g. "deepseek-v4-pro"). Presence + provider
   * "deepseek" routes the claude-code gateway at https://api.deepseek.com/anthropic
   * instead of OpenRouter. The entry keeps its `orModelId` so the OpenRouter route
   * stays selectable as a separate, visibly-labelled provider route.
   */
  deepseekModel?: string;
  /**
   * Whether DeepSeek serves this model on the OpenAI Responses API. The codex
   * harness only speaks `responses`, so a DeepSeek model without it cannot run
   * on codex directly. Verified 2026-07-31: flash yes, pro "early August 2026".
   * https://api-docs.deepseek.com/guides/responses_api/
   */
  deepseekResponsesApi?: boolean;
  /**
   * Model id on xAI's own API (e.g. "grok-4.5"). Presence + provider "xai"
   * routes the claude-code gateway at https://api.x.ai/v1/messages, xAI's
   * documented Anthropic-compatible surface, authenticated with the token the
   * official `grok login` already wrote — so the user's SuperGrok subscription
   * pays, not console credits.
   *
   * Measured 2026-08-10 against that surface: it accepts and then IGNORES every
   * reasoning-effort spelling and every `service_tier` value (it 200s on
   * `service_tier: "fast"`, which the OpenAI surface rejects as an invalid
   * enum). Effort/tier are therefore PINNED on xai entries rather than offered
   * as knobs that would silently do nothing. Both are real on
   * /v1/chat/completions, which is the codex harness's route, not this one.
   */
  xaiModel?: string;
  /**
   * Whether xAI gates CLIENT-SIDE TOOLS on this model behind a beta it has not
   * granted. A harness always sends its toolset, so such a model cannot run on
   * claude-code at all — measured 2026-08-10, every turn came back
   * `400 {"code":"invalid-argument","error":"Client-side tools for multi-agent
   * models require beta access"}` after the request was already billed as a
   * turn. Flagged so the route is offered as unavailable WITH that reason
   * instead of failing once the user has already picked it.
   */
  xaiClientToolsBeta?: boolean;
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
  /** Explicit cache prices; omitted values use the provider's documented multipliers. */
  cacheReadPerM?: number;
  cacheWritePerM?: number;
  /** Tier-specific prices, used when a harness reports the selected tier. */
  serviceTierPricing?: Record<string, TokenPriceSpec>;
  /** Full-request multiplier when that request's prompt exceeds the threshold. */
  longContextPricing?: LongContextPriceSpec;
  reasoning?: ReasoningSpec | null;
  /** Provider-specific serving tier, e.g. Cursor Grok Standard/Fast. */
  serviceTier?: ServiceTierSpec;
  /** Multimodal input support. Omitted = unknown. */
  vision?: VisionSpec;
}

/**
 * The catalog schema version this build understands. A remote payload with a
 * DIFFERENT major version is rejected whole (never half-parsed into broken
 * routing); additive fields within the same version are ignore-safe.
 */
export const MODEL_CATALOG_SCHEMA_VERSION = 1;

const CATALOG_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "openai", "openrouter", "cursor", "deepseek", "xai"]);

let MODELS: CatalogModel[] = validateModelCatalogPayload(catalog).models;

export function modelCatalog(): CatalogModel[] {
  return MODELS;
}

/**
 * Replaces the in-memory catalog with a validated payload's models. Called by
 * the main process when the remote catalog (or its cache) loads; every reader
 * goes through the accessor functions in this module, so the swap is atomic
 * from their point of view. Callers are responsible for pushing rebuilt model
 * routes to open windows afterwards.
 */
export function applyModelCatalog(models: CatalogModel[]): void {
  MODELS = models;
}

/**
 * Validates an untrusted catalog payload (remote fetch or disk cache) and
 * returns its typed models. Throws with a specific reason on ANY structural
 * problem — the caller falls back to the previous catalog and surfaces the
 * error; a half-valid payload must never be applied.
 */
export function validateModelCatalogPayload(payload: unknown): { models: CatalogModel[] } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("catalog payload is not an object");
  }
  const record = payload as { schemaVersion?: unknown; models?: unknown };
  if (record.schemaVersion !== MODEL_CATALOG_SCHEMA_VERSION) {
    throw new Error(
      `unsupported catalog schemaVersion ${JSON.stringify(record.schemaVersion)} (this build understands ${MODEL_CATALOG_SCHEMA_VERSION})`,
    );
  }
  if (!Array.isArray(record.models) || record.models.length === 0) {
    throw new Error("catalog payload has no models array");
  }
  const seen = new Set<string>();
  for (const [index, entry] of record.models.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`models[${index}] is not an object`);
    }
    const model = entry as Partial<CatalogModel>;
    if (typeof model.id !== "string" || !model.id.trim()) {
      throw new Error(`models[${index}] is missing a string id`);
    }
    if (typeof model.label !== "string" || !model.label.trim()) {
      throw new Error(`models[${index}] (${model.id}) is missing a string label`);
    }
    if (typeof model.provider !== "string" || !CATALOG_PROVIDERS.has(model.provider)) {
      throw new Error(`models[${index}] (${model.id}) has unknown provider ${JSON.stringify(model.provider)}`);
    }
    if (typeof model.subscription !== "boolean") {
      throw new Error(`models[${index}] (${model.id}) is missing the boolean subscription flag`);
    }
    const key = model.id.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`duplicate model id ${model.id}`);
    }
    seen.add(key);
  }
  return { models: record.models as CatalogModel[] };
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
      m.cursorModel?.toLowerCase() === lower ||
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
 * Catalog ids that no longer exist and the entry they mean today. The Claude
 * CLI's short aliases track the LATEST model of a family ("opus" resolves to
 * claude-opus-5 as of CLI 2.1.220), so an alias-keyed catalog entry silently
 * changes model underneath a fixed label on every CLI update. Each Anthropic
 * generation is therefore pinned by full id, and this table keeps members that
 * were persisted under a retired alias resolvable — they heal to the id the
 * alias actually resolved to instead of dropping out of the catalog.
 */
const RETIRED_MODEL_IDS: Record<string, string> = {
  "opus[1m]": "claude-opus-5[1m]",
};

/**
 * Canonical comparison key for one spelling of a model id: lowercase, the
 * optional "<provider>/" prefix and "[1m]" long-context suffix stripped, and
 * separator characters removed — so "claude-opus-5[1m]" (the id the Claude
 * harness reports at session init), "claude-opus-5" (bare spelling) and
 * "anthropic/claude-opus-5" (OpenRouter id) all collapse to one key.
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
 * canonical id ("claude-opus-5" → claude-opus-5[1m]), or a retired catalog id
 * ("opus[1m]"). One resolver so a live session's self-reported model always
 * finds its way back to the entry that carries capabilities (reasoning/vision),
 * pricing, and leaderboard meta — a session echoing "claude-opus-4-8[1m]" used
 * to resolve to NO entry, which silently dropped the Runtime modal's thinking
 * (Adaptive) control.
 */
export function resolveCatalogModel(model: string): CatalogModel | undefined {
  if (!model) {
    return undefined;
  }
  const direct = catalogModelById(model) || catalogModelByRuntime(model) || catalogModelByOrModelId(model);
  if (direct) {
    return direct;
  }
  const retired = RETIRED_MODEL_IDS[model.toLowerCase()];
  if (retired) {
    return catalogModelById(retired);
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
      (m.cursorModel ? canonicalModelKey(m.cursorModel) === key : false) ||
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

/** Models served by DeepSeek's own API (provider deepseek with a concrete id). */
export function deepseekModels(): CatalogModel[] {
  return MODELS.filter((m) => m.provider === "deepseek" && Boolean(m.deepseekModel));
}

/**
 * The DeepSeek entry a codex model slug names, but only when DeepSeek actually
 * serves it on the Responses wire codex speaks. A DeepSeek model without
 * `deepseekResponsesApi` deliberately resolves to undefined here so it cannot be
 * spawned onto a provider that would reject every request.
 */
export function codexDirectDeepseekModel(model: string): CatalogModel | undefined {
  const lower = model.toLowerCase();
  return deepseekModels().find(
    (m) => m.deepseekResponsesApi === true && m.deepseekModel?.toLowerCase() === lower,
  );
}

/**
 * The set the codex harness routes through its OpenRouter custom provider:
 * OpenRouter-native entries plus DeepSeek entries, which keep an `orModelId` as
 * a second route while their home provider is DeepSeek's own API.
 *
 * Anthropic/OpenAI entries carry an `orModelId` too but are deliberately NOT
 * here — they reach codex through their own subscription providers instead.
 */
export function orRoutedModels(): CatalogModel[] {
  return MODELS.filter(
    (m) => Boolean(m.orModelId) && (m.provider === "openrouter" || m.provider === "deepseek"),
  );
}

/** runtimeModel/id -> OpenRouter model id, for the embedded protocol gateway. */
export function openRouterAliasMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const m of orRoutedModels()) {
    if (m.runtimeModel && m.orModelId) {
      map[(m.runtimeModel || m.id).toLowerCase()] = m.orModelId;
      map[m.id.toLowerCase()] = m.orModelId;
    }
  }
  return map;
}

export type RouterTarget =
  | { kind: "codex-subscription"; model: string }
  | { kind: "openrouter"; model: string }
  | { kind: "cursor-subscription"; model: string }
  | { kind: "deepseek"; model: string }
  | { kind: "xai-subscription"; model: string };

/** Exact provider target for one Claude Code gateway alias. */
export function routerTargetForModel(model: string): RouterTarget | undefined {
  const entry = catalogModelByRuntime(model) || catalogModelById(model);
  if (!entry?.runtimeModel) {
    return undefined;
  }
  if (entry.provider === "openai" && entry.codexModel) {
    return { kind: "codex-subscription", model: entry.codexModel };
  }
  if (entry.provider === "deepseek" && entry.deepseekModel) {
    return { kind: "deepseek", model: entry.deepseekModel };
  }
  if (entry.provider === "openrouter" && entry.orModelId) {
    return { kind: "openrouter", model: entry.orModelId };
  }
  if (entry.provider === "cursor" && entry.cursorAcpModelId) {
    return { kind: "cursor-subscription", model: entry.cursorAcpModelId };
  }
  if (entry.provider === "xai" && entry.xaiModel) {
    return { kind: "xai-subscription", model: entry.xaiModel };
  }
  return undefined;
}

/** Whether a thinking spec lets the user turn reasoning off. */
export function thinkingCanDisable(spec: ReasoningThinkingSpec | undefined): boolean {
  return Boolean(spec?.modes.includes("disabled"));
}
