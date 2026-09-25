/** Provider-neutral Decisions contract exposed by AgentParty. */
export const JEV_MODEL = "typesafe/jev-1.13";
export const JEV_PROVIDER_IDS = ["openrouter"] as const;
export type JevProviderId = (typeof JEV_PROVIDER_IDS)[number];
export const JEV_PROVIDER_LABELS: Record<JevProviderId, string> = { openrouter: "OpenRouter" };

export interface JevDecisionRequest {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, {
    type: "choice" | "noul" | "score";
    instructions: string;
    criteria: Record<string, string> | string[];
  }>;
  /** Omitted = the app's current default. Never falls back after a provider error. */
  provider?: JevProviderId;
}

export interface JevDecisionResult {
  provider: JevProviderId;
  model: string;
  id?: string;
  answers: Record<string, unknown>;
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

export function isJevProviderId(value: unknown): value is JevProviderId {
  return typeof value === "string" && (JEV_PROVIDER_IDS as readonly string[]).includes(value);
}
