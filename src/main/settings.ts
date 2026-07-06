import * as fs from "node:fs";
import * as path from "node:path";
import { getUserDataDir } from "./userDataDir";
import { AppSettings, HarnessDefaults, HarnessId, HARNESS_IDS } from "../shared/types";
import { DEFAULT_CODEX_POLICY } from "../shared/codexPolicy";
import { catalogModelById, catalogModelByRuntime } from "../shared/modelCatalog";

const HARNESS_DEFAULTS: Record<HarnessId, HarnessDefaults> = {
  "claude-code": { model: "sonnet", effort: "medium", permissionMode: "default" },
  // Matches codexDefaultRoute() so the default is selectable before account
  // discovery runs (a bare "gpt-5.5" has no codex route until model/list lands,
  // so the wizard would quietly create the member with a different model).
  codex: { model: "gpt-5.4", effort: "medium", codexPolicy: { ...DEFAULT_CODEX_POLICY } },
};

const defaults: AppSettings = {
  workspacePath: process.cwd(),
  claudeExecutablePath: "",
  claudeSafeMode: false,
  selectedHarnessId: "claude-code",
  harnessDefaults: HARNESS_DEFAULTS,
  debugEnabled: false,
  // Ports are RUNTIME, not canonical: bind ephemeral (0) by default so multiple
  // processes never collide on a fixed port, and advertise the live bound URL via
  // per-workspace discovery. A dev/QA run can still pin a port via env. (An empty
  // routerBaseUrl → preferredPort 0; consumers read the live `router.baseUrl`.)
  routerBaseUrl: "",
  routerAuthToken: "dummy",
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  automationApiPort: Number(process.env.AGENTPARTY_AUTOMATION_PORT || "") || 0,
};

export function getSettings(): AppSettings {
  const stored = migrateSettings(readSettingsFile());
  return sanitizeSettings({
    ...defaults,
    ...stored,
    // Merge per-harness defaults so a partial stored map keeps unset harnesses.
    harnessDefaults: mergeHarnessDefaults(stored.harnessDefaults),
  });
}

/**
 * Migrates a legacy settings.json (flat `claudeModel`/`claudeEffort`/
 * `claudePermissionMode`/… fields, pre per-harness defaults) into the
 * `harnessDefaults["claude-code"]` shape, so upgrading users keep their prior
 * default. Idempotent — a settings file already on the new shape is untouched.
 */
export function migrateSettings(stored: Record<string, any>): Partial<AppSettings> {
  if (!stored || stored.harnessDefaults || !("claudeModel" in stored)) {
    return stored as Partial<AppSettings>;
  }
  const { claudeModel, claudeEffort, claudeReasoning, claudeReasoningBudget, claudePermissionMode, selectedProviderId, ...rest } = stored;
  return {
    ...(rest as Partial<AppSettings>),
    harnessDefaults: {
      "claude-code": {
        model: claudeModel || HARNESS_DEFAULTS["claude-code"].model,
        effort: claudeEffort || HARNESS_DEFAULTS["claude-code"].effort,
        reasoning: claudeReasoning,
        reasoningBudget: claudeReasoningBudget,
        permissionMode: claudePermissionMode || HARNESS_DEFAULTS["claude-code"].permissionMode,
      },
      codex: { ...HARNESS_DEFAULTS.codex },
    },
  };
}

/** Fills any harness missing from a stored map with the built-in default. */
function mergeHarnessDefaults(stored: Partial<Record<HarnessId, HarnessDefaults>> | undefined): Record<HarnessId, HarnessDefaults> {
  const merged = {} as Record<HarnessId, HarnessDefaults>;
  for (const id of HARNESS_IDS) {
    merged[id] = { ...HARNESS_DEFAULTS[id], ...(stored?.[id] || {}) };
  }
  return merged;
}

/**
 * Heals a per-harness default model that no longer resolves to a catalog model —
 * e.g. a value selected before the catalog was reworked (the legacy "GLM-5.2
 * (OpenRouter)" id). Left untouched it injects an unroutable "current model"
 * fallback route (modelRegistry) that then becomes selectable and only fails at
 * session start. Reset that harness's model to its built-in default.
 */
function sanitizeSettings(settings: AppSettings): AppSettings {
  const envAutomationPort = Number(process.env.AGENTPARTY_AUTOMATION_PORT || "");
  const withRuntimeOverrides = envAutomationPort > 0 ? { ...settings, automationApiPort: envAutomationPort } : settings;
  const harnessDefaults = { ...withRuntimeOverrides.harnessDefaults };
  for (const id of HARNESS_IDS) {
    const model = harnessDefaults[id]?.model;
    if (model && !catalogModelById(model) && !catalogModelByRuntime(model)) {
      harnessDefaults[id] = { ...harnessDefaults[id], model: HARNESS_DEFAULTS[id].model };
    }
  }
  return { ...withRuntimeOverrides, harnessDefaults };
}

export function getPublicSettings(): AppSettings {
  const settings = getSettings();
  return {
    ...settings,
    openRouterApiKey: settings.openRouterApiKey ? maskSecret(settings.openRouterApiKey) || "" : "",
    routerAuthToken: settings.routerAuthToken ? "[redacted]" : "",
  };
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch };
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic write (per-process temp + rename): shared user settings can be written
  // by several processes now, so a plain overwrite could be read half-written by
  // another. A unique temp name avoids two writers colliding on one temp file.
  const tempPath = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), "utf8");
  fs.renameSync(tempPath, file);
  return next;
}

export function maskSecret(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length <= 8 ? "********" : `${"*".repeat(8)}${value.slice(-4)}`;
}

function readSettingsFile(): Partial<AppSettings> {
  try {
    const file = settingsPath();
    if (!fs.existsSync(file)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function settingsPath(): string {
  return path.join(getUserDataDir(), "settings.json");
}
