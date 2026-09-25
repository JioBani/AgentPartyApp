import { getSettings } from "./settings";
import { isJevProviderId, JEV_MODEL, JEV_PROVIDER_LABELS, type JevDecisionRequest, type JevDecisionResult, type JevProviderId } from "../shared/jev";

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

type Settings = ReturnType<typeof getSettings>;
interface JevAdapter {
  model: string;
  configured(settings: Settings): boolean;
  submit(request: JevDecisionRequest, settings: Settings): Promise<Record<string, unknown>>;
}

/** Adding a provider extends this registry and the shared provider id/label. */
const PROVIDERS: Record<JevProviderId, JevAdapter> = {
  openrouter: {
    model: JEV_MODEL,
    configured: (settings) => Boolean(settings.openRouterApiKey),
    async submit(request, settings) {
      const response = await fetch(OPENROUTER_DECISIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.openRouterApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: JEV_MODEL, state: request.state, questions: request.questions }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenRouter Jev failed (${response.status}): ${body.slice(0, 500)}`);
      }
      return await response.json() as Record<string, unknown>;
    },
  },
};

export function jevProviders() {
  const settings = getSettings();
  return {
    defaultProvider: settings.jevDefaultProvider,
    providers: (Object.entries(PROVIDERS) as Array<[JevProviderId, JevAdapter]>).map(([id, adapter]) => {
      const configured = adapter.configured(settings);
      return { id, label: JEV_PROVIDER_LABELS[id], configured, available: configured, model: adapter.model };
    }),
  };
}

function validateRequest(value: unknown): JevDecisionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Jev request must be an object.");
  const input = value as Record<string, unknown>;
  if (!(typeof input.state === "string" || (input.state !== null && typeof input.state === "object"))) {
    throw new Error("Jev state must be a string, object, or array.");
  }
  if (!input.questions || typeof input.questions !== "object" || Array.isArray(input.questions) || !Object.keys(input.questions).length) {
    throw new Error("Jev questions must be a non-empty object.");
  }
  for (const [id, raw] of Object.entries(input.questions as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Jev question '${id}' must be an object.`);
    const question = raw as Record<string, unknown>;
    if (!["choice", "noul", "score"].includes(String(question.type)) || typeof question.instructions !== "string" || !question.instructions.trim()) {
      throw new Error(`Jev question '${id}' needs type (choice, noul, score) and non-empty instructions.`);
    }
    if (!question.criteria || typeof question.criteria !== "object" || !Object.keys(question.criteria).length) {
      throw new Error(`Jev question '${id}' needs non-empty criteria.`);
    }
    const criteria = question.criteria;
    if (question.type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error(`Jev score question '${id}' needs at least two string criteria in order.`);
      }
    } else {
      if (Array.isArray(criteria) || Object.values(criteria as Record<string, unknown>).some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error(`Jev ${question.type} question '${id}' needs string criteria in an object.`);
      }
      const keys = Object.keys(criteria);
      if (question.type === "choice" && keys.length < 2) throw new Error(`Jev choice question '${id}' needs at least two options.`);
      if (question.type === "noul" && (keys.length !== 2 || !keys.includes("true") || !keys.includes("false"))) {
        throw new Error(`Jev noul question '${id}' needs true and false criteria.`);
      }
    }
  }
  if (input.provider !== undefined && !isJevProviderId(input.provider)) throw new Error(`Unknown Jev provider '${String(input.provider)}'.`);
  return input as unknown as JevDecisionRequest;
}

/** One paid provider request. The response remains unclassified: callers own thresholds. */
export async function decideJev(value: unknown): Promise<JevDecisionResult> {
  const request = validateRequest(value);
  const settings = getSettings();
  const provider = request.provider || settings.jevDefaultProvider;
  if (!isJevProviderId(provider)) throw new Error(`Jev provider '${provider}' is not supported by this build.`);
  const adapter = PROVIDERS[provider];
  if (!adapter.configured(settings)) throw new Error(`${JEV_PROVIDER_LABELS[provider]} is not configured for Jev.`);
  const raw = await adapter.submit(request, settings);
  if (!raw.answers || typeof raw.answers !== "object" || Array.isArray(raw.answers)) {
    throw new Error(`${JEV_PROVIDER_LABELS[provider]} Jev returned no answers object.`);
  }
  const usage = raw.usage && typeof raw.usage === "object" ? raw.usage as Record<string, unknown> : {};
  const finite = (number: unknown) => typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : undefined;
  return {
    provider,
    model: typeof raw.model === "string" ? raw.model : adapter.model,
    id: typeof raw.id === "string" ? raw.id : undefined,
    answers: raw.answers as Record<string, unknown>,
    usage: { inputTokens: finite(usage.input_tokens), outputTokens: finite(usage.output_tokens), costUsd: finite(usage.cost) },
  };
}
