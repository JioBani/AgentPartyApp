import * as fs from "node:fs";
import * as path from "node:path";
import { getUserDataDir } from "./userDataDir";
import { AppSettings } from "../shared/types";
import { catalogModelById, catalogModelByRuntime } from "../shared/modelCatalog";

const defaults: AppSettings = {
  workspacePath: process.cwd(),
  claudeExecutablePath: "",
  selectedHarnessId: "claude-code",
  selectedProviderId: "anthropic",
  claudeModel: "sonnet",
  claudeEffort: "medium",
  claudePermissionMode: "default",
  claudeSafeMode: false,
  debugEnabled: false,
  routerBaseUrl: "http://127.0.0.1:3455",
  routerAuthToken: "dummy",
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  automationApiPort: Number(process.env.AGENTPARTY_AUTOMATION_PORT || "") || 47831,
};

export function getSettings(): AppSettings {
  return sanitizeSettings({ ...defaults, ...readSettingsFile() });
}

/**
 * Heals a persisted `claudeModel` that no longer resolves to a catalog model —
 * e.g. a value selected before the model catalog was reworked (the legacy
 * "GLM-5.2 (OpenRouter)" id). Left untouched it injects an unroutable "current
 * model" fallback route (modelRegistry), which then becomes selectable in the UI
 * and only fails later at session start. Reset to the default model + provider.
 */
function sanitizeSettings(settings: AppSettings): AppSettings {
  const envAutomationPort = Number(process.env.AGENTPARTY_AUTOMATION_PORT || "");
  const withRuntimeOverrides = envAutomationPort > 0 ? { ...settings, automationApiPort: envAutomationPort } : settings;
  const model = withRuntimeOverrides.claudeModel;
  if (model && !catalogModelById(model) && !catalogModelByRuntime(model)) {
    return { ...withRuntimeOverrides, claudeModel: defaults.claudeModel, selectedProviderId: defaults.selectedProviderId };
  }
  return withRuntimeOverrides;
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
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), "utf8");
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
