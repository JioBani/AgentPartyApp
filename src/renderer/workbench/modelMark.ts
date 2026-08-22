import { resolveCatalogModel, type CatalogModel } from "../../shared/modelCatalog";
import type { RouteLike } from "./routes";
import type { VendorMark } from "./vendorMarks";

/**
 * A route provider answers "where is this billed/routed?"; this resolver
 * answers the separate question "whose model is it?". That distinction matters
 * most inside OpenRouter: a Gemini route must keep the OpenRouter provider mark
 * while the model itself keeps Gemini's mark.
 */

const CATALOG_PROVIDER_MARK: Partial<Record<CatalogModel["provider"], VendorMark>> = {
  anthropic: "claude",
  openai: "openai",
  deepseek: "deepseek",
  xai: "grok",
};

const MODEL_BRAND_RULES: ReadonlyArray<readonly [RegExp, VendorMark]> = [
  [/(?:^|\/)anthropic\/|\bclaude\b|\bfable\b|\bopus\b|\bsonnet\b|\bhaiku\b/i, "claude"],
  [/(?:^|\/)openai\/|\bgpt[- .]/i, "openai"],
  [/(?:^|\/)x-ai\/|\bgrok\b/i, "grok"],
  [/(?:^|\/)deepseek\/|\bdeepseek\b/i, "deepseek"],
  [/(?:^|\/)google\/|\bgemini\b/i, "gemini"],
  [/(?:^|\/)moonshotai\/|\bkimi\b/i, "kimi"],
  [/(?:^|\/)qwen\/|\bqwen/i, "qwen"],
  [/(?:^|\/)meta\/|\bmuse spark\b/i, "meta"],
  [/(?:^|\/)poolside\/|\blaguna\b/i, "poolside"],
  [/(?:^|\/)z-ai\/|\bglm[- .]/i, "zai"],
  [/(?:^|\/)minimax\/|\bminimax\b/i, "minimax"],
];

function markFromText(value: string): VendorMark | undefined {
  return MODEL_BRAND_RULES.find(([pattern]) => pattern.test(value))?.[1];
}

function catalogMakerText(entry: CatalogModel): string {
  return [
    entry.id,
    entry.label,
    entry.codexModel,
    entry.claudeSubscriptionModel,
    entry.cursorModel,
    entry.cursorAcpModelId,
    entry.orModelId,
    entry.deepseekModel,
    entry.xaiModel,
  ].filter(Boolean).join(" ");
}

export function modelMarkForModel(model: string | undefined): VendorMark | undefined {
  if (!model) {
    return undefined;
  }
  const entry = resolveCatalogModel(model);
  if (entry) {
    // Model-maker evidence in a concrete id wins over its route provider. A
    // Cursor route carrying Grok is xAI's model, not a Cursor model. The
    // `runtimeModel` transport alias is deliberately absent: router-backed
    // entries all begin with `claude-`, which says nothing about their maker.
    return markFromText(catalogMakerText(entry)) || CATALOG_PROVIDER_MARK[entry.provider];
  }
  return markFromText(model);
}

export function modelMarkForRoute(route: RouteLike | undefined): VendorMark | undefined {
  if (!route) {
    return undefined;
  }
  return modelMarkForModel(route.model)
    || modelMarkForModel(route.runtimeModel)
    || markFromText([route.label, route.modelProvider, route.providerId].filter(Boolean).join(" "));
}
