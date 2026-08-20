/** Tabs exposed by the Agent and Settings screens. Shared with the automation API. */
export const AGENT_TAB_IDS = ["general", "defaults", "primer", "gate", "discord"] as const;
export const SETTINGS_TAB_IDS = ["general", "environment", "workspace", "mobile", "versions", "diagnostics", "automation"] as const;

export type AgentTabId = (typeof AGENT_TAB_IDS)[number];
export type SettingsTabId = (typeof SETTINGS_TAB_IDS)[number];

export function isAgentTabId(value: string): value is AgentTabId {
  return (AGENT_TAB_IDS as readonly string[]).includes(value);
}

export function isSettingsTabId(value: string): value is SettingsTabId {
  return (SETTINGS_TAB_IDS as readonly string[]).includes(value);
}

/** Tabs accepted by the deprecated `runtime` navigation alias. */
export const LEGACY_RUNTIME_TAB_IDS = ["general", "harness", "environment", "workspace", "primer", "gate", "discord", "mobile", "versions", "diagnostics"] as const;
export type RuntimeTabId = (typeof LEGACY_RUNTIME_TAB_IDS)[number];
export const RUNTIME_TAB_IDS = LEGACY_RUNTIME_TAB_IDS;
export function isRuntimeTabId(value: string): value is RuntimeTabId {
  return (LEGACY_RUNTIME_TAB_IDS as readonly string[]).includes(value);
}
