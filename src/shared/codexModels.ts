/**
 * Codex account model catalog — the normalized shape of `model/list` from
 * `codex app-server` (see docs/codex-ux-research/07-model-routing.md §1).
 * Crosses the engine RPC, IPC, and HTTP API boundaries, so it lives in shared.
 * Normalization is pure so QA can exercise it without a codex binary.
 */

/** One reasoning-effort option a Codex model supports. */
export interface CodexModelEffort {
  id: string;
  description?: string;
}

/** One service tier a Codex model supports (e.g. Fast = 1.5x speed). */
export interface CodexServiceTier {
  id: string;
  name: string;
  description?: string;
}

/** One model of the authenticated Codex account catalog. */
export interface CodexModelInfo {
  /** Model slug sent to thread/start · turn/start (e.g. "gpt-5.5"). */
  model: string;
  displayName: string;
  description?: string;
  isDefault: boolean;
  hidden: boolean;
  defaultReasoningEffort?: string;
  reasoningEfforts: CodexModelEffort[];
  serviceTiers: CodexServiceTier[];
}

/**
 * Discovery lifecycle for the Codex catalog. `error` keeps the static fallback
 * route usable while surfacing why the live list is unavailable — the failure
 * must reach the UI (project no-silent-fallback rule), never be swallowed.
 */
export interface CodexModelDiscoveryState {
  status: "pending" | "ready" | "error";
  models: CodexModelInfo[];
  error?: string;
  /** ISO timestamp of the last settle (ready or error). */
  at?: string;
}

export const CODEX_MODELS_PENDING: CodexModelDiscoveryState = { status: "pending", models: [] };

/**
 * Normalizes one raw `model/list` entry. Returns undefined for entries without
 * a usable slug instead of fabricating one.
 */
export function normalizeCodexModel(raw: unknown): CodexModelInfo | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const entry = raw as Record<string, unknown>;
  const model = stringOf(entry.model) || stringOf(entry.id);
  if (!model) {
    return undefined;
  }
  const efforts = Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : [];
  const tiers = Array.isArray(entry.serviceTiers) ? entry.serviceTiers : [];
  return {
    model,
    displayName: stringOf(entry.displayName) || model,
    description: stringOf(entry.description) || undefined,
    isDefault: entry.isDefault === true,
    hidden: entry.hidden === true,
    defaultReasoningEffort: stringOf(entry.defaultReasoningEffort) || undefined,
    reasoningEfforts: efforts
      .map((item): CodexModelEffort | undefined => {
        const effort = (item || {}) as Record<string, unknown>;
        const id = stringOf(effort.reasoningEffort);
        return id ? { id, description: stringOf(effort.description) || undefined } : undefined;
      })
      .filter((item): item is CodexModelEffort => Boolean(item)),
    serviceTiers: tiers
      .map((item): CodexServiceTier | undefined => {
        const tier = (item || {}) as Record<string, unknown>;
        const id = stringOf(tier.id);
        return id ? { id, name: stringOf(tier.name) || id, description: stringOf(tier.description) || undefined } : undefined;
      })
      .filter((item): item is CodexServiceTier => Boolean(item)),
  };
}

/**
 * Normalizes a full `model/list` page list: drops hidden/unusable entries and
 * puts the account default first (the wizard preselects the first entry).
 */
export function normalizeCodexModels(rawModels: unknown[]): CodexModelInfo[] {
  const models = rawModels
    .map((raw) => normalizeCodexModel(raw))
    .filter((model): model is CodexModelInfo => Boolean(model) && !(model as CodexModelInfo).hidden);
  return [...models.filter((model) => model.isDefault), ...models.filter((model) => !model.isDefault)];
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
