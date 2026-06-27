import * as fs from "node:fs";
import * as path from "node:path";
import { getUserDataDir } from "./userDataDir";
import { AppSettings } from "../shared/types";

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
  automationApiPort: 47831,
};

export function getSettings(): AppSettings {
  return { ...defaults, ...readSettingsFile() };
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
