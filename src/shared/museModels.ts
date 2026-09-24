/** Live Muse Code provider catalog returned by MSP `model/list`. */

export interface MuseModelCost {
  input: string;
  cached: string;
  output: string;
  currency: string | null;
}

export interface MuseModelInfo {
  model: string;
  displayName: string;
  description?: string;
  isDefault: boolean;
  isActive: boolean;
  providerId: string;
  profileId?: string;
  releaseDate?: string;
  contextLimit?: number;
  outputLimit?: number;
  cost?: MuseModelCost;
}

export interface MuseModelDiscoveryState {
  status: "pending" | "ready" | "error";
  models: MuseModelInfo[];
  error?: string;
  providerId?: string;
  profileId?: string;
  source?: string;
  at?: string;
}

export const MUSE_MODELS_PENDING: MuseModelDiscoveryState = { status: "pending", models: [] };

/**
 * Last-known public Muse catalog. Some installed CLIs return
 * `{source:"bundledCatalog", models:[]}` before a host has an active profile;
 * keeping the measured public models here makes model selection available while
 * a non-empty account catalog still wins automatically.
 */
export const MUSE_BUNDLED_MODELS: MuseModelInfo[] = [
  {
    model: "muse-spark-1.3-contributor",
    displayName: "muse-spark-1.3-contributor",
    description: "Your content, including inter-session messages, may be used for product improvement.",
    isDefault: true,
    isActive: false,
    providerId: "meta",
    profileId: "tbh",
    releaseDate: "2026-09-02",
    contextLimit: 1_007_997,
    outputLimit: 128_000,
  },
  {
    model: "muse-spark-1.3",
    displayName: "muse-spark-1.3",
    isDefault: false,
    isActive: false,
    providerId: "meta",
    profileId: "tbh",
    releaseDate: "2026-09-02",
    contextLimit: 1_007_997,
    outputLimit: 128_000,
  },
  {
    model: "muse-spark-1.2",
    displayName: "muse-spark-1.2",
    isDefault: false,
    isActive: false,
    providerId: "meta",
    profileId: "tbh",
    releaseDate: "2026-08-05",
    contextLimit: 1_007_997,
    outputLimit: 128_000,
  },
  {
    model: "muse-spark-1.2-contributor",
    displayName: "muse-spark-1.2-contributor",
    description: "Your content, including inter-session messages, may be used for product improvement.",
    isDefault: false,
    isActive: false,
    providerId: "meta",
    profileId: "tbh",
    releaseDate: "2026-08-05",
    contextLimit: 1_007_997,
    outputLimit: 128_000,
  },
];

export function normalizeMuseModel(raw: unknown): MuseModelInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as Record<string, unknown>;
  const model = stringOf(entry.modelId);
  if (!model) return undefined;
  const cost = normalizeCost(entry.cost);
  return {
    model,
    displayName: stringOf(entry.displayLabel) || model,
    description: stringOf(entry.description) || undefined,
    isDefault: entry.isDefault === true,
    isActive: entry.isActive === true,
    providerId: stringOf(entry.providerId) || "meta",
    profileId: stringOf(entry.profileId) || undefined,
    releaseDate: stringOf(entry.releaseDate) || undefined,
    contextLimit: positiveNumber(entry.contextLimit),
    outputLimit: positiveNumber(entry.outputLimit),
    cost,
  };
}

export function normalizeMuseModels(rawModels: unknown[]): MuseModelInfo[] {
  const models = rawModels.map(normalizeMuseModel).filter((model): model is MuseModelInfo => Boolean(model));
  return [...models.filter((model) => model.isDefault), ...models.filter((model) => !model.isDefault)];
}

export function supersedesMuseDiscovery(
  applied: MuseModelDiscoveryState | undefined,
  incoming: MuseModelDiscoveryState | undefined,
): boolean {
  const appliedAt = applied?.at;
  if (!appliedAt) return true;
  const incomingAt = incoming?.at;
  return Boolean(incomingAt) && (incomingAt as string) >= appliedAt;
}

function normalizeCost(value: unknown): MuseModelCost | undefined {
  if (!value || typeof value !== "object") return undefined;
  const cost = value as Record<string, unknown>;
  const input = stringOf(cost.input);
  const cached = stringOf(cost.cached);
  const output = stringOf(cost.output);
  if (!input && !cached && !output) return undefined;
  return {
    input,
    cached,
    output,
    currency: typeof cost.currency === "string" ? cost.currency : null,
  };
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
