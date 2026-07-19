/**
 * Model identity + transport routing as DATA, not string inference.
 *
 * The catalog (modelCatalog.json) is a closed, declared set of routable models.
 * Historically the "native vs router" and "which provider" decisions were made
 * by hardcoded string-prefix lists scattered across the adapters and registry
 * (e.g. `isNativeClaudeModel`, `inferClaudeCodeProvider`). Every new catalog
 * entry then had to be mirrored into those lists by hand, and a miss routed the
 * model to the wrong backend (the recurring "selected Opus, got rejected/fell
 * back" class of bug).
 *
 * This module is the single place that turns a (model, harness) pair into a
 * deterministic {@link Backend}. All routing decisions derive from the catalog
 * entry's own fields — add a model = add one catalog entry, nothing else. Raw
 * strings are converted to this typed data at the narrowest possible boundary;
 * downstream code branches on `Backend.kind`, never on the model spelling.
 */
import { resolveCatalogModel } from "./modelCatalog";

export type HarnessId = "claude-code" | "codex";
export type ProviderId = "anthropic" | "openrouter" | "openai" | "custom";

/**
 * A model id known to resolve to a catalog entry (or a live-discovered Codex
 * slug). Branded so it cannot be fabricated from an arbitrary string — the only
 * way in is {@link parseModelId}, which fails loudly on an unknown spelling
 * instead of letting it flow downstream to be silently mis-routed.
 */
export type ModelId = string & { readonly __brand: "ModelId" };

/**
 * The transport a (model, harness) pair resolves to. The embedded slug is the
 * exact id handed to the harness/router — callers read it from here instead of
 * re-deriving a string.
 */
export type Backend =
  | { kind: "claude-native"; id: string } // native Anthropic model on the claude-code harness
  | { kind: "claude-router"; alias: string } // claude-* alias translated by the AgentParty router backend
  | { kind: "codex-account"; slug: string } // Codex built-in account model
  | { kind: "codex-claude-subscription"; model: string } // Codex app-server through local Claude OAuth
  | { kind: "codex-openrouter"; orModelId: string }; // Codex routed through the OpenRouter custom provider

/** A typed handle to a model on a specific harness — the app-internal reference. */
export interface RouteRef {
  modelId: ModelId;
  harnessId: HarnessId;
}

/**
 * Resolves any spelling to a catalog id, or undefined when the model is not in
 * the closed set (no silent guess — the caller surfaces the failure). Note this
 * only recognises catalogued models; live-discovered Codex slugs that are not in
 * the static catalog are branded at their discovery boundary via {@link asModelId}.
 */
export function parseModelId(raw: string | undefined): ModelId | undefined {
  const entry = raw ? resolveCatalogModel(raw) : undefined;
  return entry ? (entry.id as ModelId) : undefined;
}

/**
 * Brands a string that is known-good from a trusted source (a live Codex
 * `model/list` slug) without a catalog lookup. Use only where the origin
 * guarantees the id is real; prefer {@link parseModelId} everywhere else.
 */
export function asModelId(raw: string): ModelId {
  return raw as ModelId;
}

/**
 * The single decision function: derive the transport for (model, harness) from
 * the catalog entry's fields. Returns undefined for a model the catalog does not
 * describe (a user custom route) — the caller then falls back to explicit
 * provider metadata rather than guessing from the id.
 */
export function backendFor(model: string, harnessId: HarnessId): Backend | undefined {
  const entry = resolveCatalogModel(model);
  if (!entry) {
    return undefined;
  }
  if (harnessId === "claude-code") {
    if (entry.provider === "anthropic") {
      return { kind: "claude-native", id: entry.id };
    }
    if (entry.runtimeModel) {
      return { kind: "claude-router", alias: entry.runtimeModel };
    }
    return undefined; // catalogued but not routable on this harness
  }
  // codex harness
  if (entry.codexModel) {
    return { kind: "codex-account", slug: entry.codexModel };
  }
  if (entry.claudeSubscriptionModel) {
    return { kind: "codex-claude-subscription", model: entry.claudeSubscriptionModel };
  }
  if (entry.provider === "openrouter" && entry.orModelId) {
    return { kind: "codex-openrouter", orModelId: entry.orModelId };
  }
  return undefined;
}

/** The exact model id string this backend hands to the harness/router. */
export function backendSlug(backend: Backend): string {
  switch (backend.kind) {
    case "claude-native":
      return backend.id;
    case "claude-router":
      return backend.alias;
    case "codex-account":
      return backend.slug;
    case "codex-claude-subscription":
      return backend.model;
    case "codex-openrouter":
      return backend.orModelId;
  }
}

/** Whether a claude-code (model, ...) resolves to the native Anthropic path. */
export function isClaudeNative(backend: Backend | undefined): boolean {
  return backend?.kind === "claude-native";
}

/**
 * Concrete harness process that executes a user-selected harness/model pair.
 * Cross-routing changes the model provider/transport, never the harness: GPT on
 * Claude Code remains a Claude Code SDK process through its Anthropic gateway;
 * Claude on Codex remains a Codex app-server process through its custom provider.
 */
export function executionHarnessFor(_model: string | undefined, selectedHarness: HarnessId): HarnessId {
  return selectedHarness;
}

/** Exact model slug handed to the concrete execution harness. */
export function executionModelFor(model: string, selectedHarness: HarnessId): string {
  const executionHarness = executionHarnessFor(model, selectedHarness);
  const backend = backendFor(model, executionHarness);
  return backend ? backendSlug(backend) : model;
}
