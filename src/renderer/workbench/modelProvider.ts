/**
 * Which company's model a member is actually running.
 *
 * The member list, the tabs and the panel header all used to show the HARNESS
 * mark, which answers a different question: a Codex-harness member running Opus
 * was badged OpenAI, and a Claude Code member routed to DeepSeek was badged
 * Anthropic. The icon beside a member's name is read as "whose model is this",
 * so it has to be resolved from the model, not from the process running it.
 *
 * Resolution prefers the live route (it knows about Codex custom providers and
 * live-discovered slugs) and falls back to the static catalog, so a member shows
 * the right mark before its first route list arrives. When neither can answer —
 * a brand-new model id, a harness reporting a slug we have never seen — the
 * answer is `undefined`, never a guess: `ProviderIcon` has one neutral mark for
 * exactly this case.
 */

import { resolveCatalogModel, type CatalogProvider } from "../../shared/modelCatalog";
import { findRoute, type RouteLike } from "./routes";

/** The provider vocabulary is the catalog's own — one list, not a second one. */
export type ModelProvider = CatalogProvider;

const KNOWN: readonly string[] = ["anthropic", "openai", "openrouter", "cursor", "deepseek", "xai"];

/**
 * The provider behind a model string, or undefined when nothing can say.
 *
 * `routes` is optional so surfaces that never receive the route list (the guide,
 * fixtures, a preview page) still resolve everything the catalog knows.
 */
export function providerForModel(model: string | undefined, routes?: RouteLike[]): ModelProvider | undefined {
  if (!model) {
    return undefined;
  }
  const route = routes?.length ? findRoute(model, routes) : undefined;
  // A Codex custom provider ("openrouter", "deepseek") is the more specific
  // truth when it is set: the route's own providerId stays "openai" for models
  // reached through the Codex account, and reporting that for a DeepSeek model
  // would name the wrong company again.
  const fromRoute = normalize(route?.modelProvider) || normalize(route?.providerId);
  if (fromRoute) {
    return fromRoute;
  }
  return normalize(resolveCatalogModel(model)?.provider);
}

/**
 * Display name for tooltips and accessible labels; never blank.
 *
 * The COMPANY, not the product line: `MODEL_PROVIDERS` labels the same ids
 * "Claude"/"Codex"/"Grok" because those name the subscription a user buys, but
 * this icon answers "whose model is answering" and the honest answer there is
 * Anthropic, OpenAI, xAI.
 */
export function providerLabel(provider: ModelProvider | undefined): string {
  return provider ? PROVIDER_LABEL[provider] : "Unknown provider";
}

const PROVIDER_LABEL: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  xai: "xAI",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  cursor: "Cursor",
};

function normalize(value: string | undefined): ModelProvider | undefined {
  const id = String(value || "").toLowerCase();
  return KNOWN.includes(id) ? (id as ModelProvider) : undefined;
}
