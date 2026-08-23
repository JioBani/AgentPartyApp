/**
 * Codex command/skill/plugin discovery normalization (Item 4). Pure, testable
 * helpers that flatten the app-server's `skills/list` and `plugin/installed`
 * responses into palette commands tagged by source, with a disabled reason when
 * a skill/plugin is unavailable. Field names verified against `codex app-server
 * generate-ts` (SkillsListEntry/SkillSummary, PluginInstalledResponse/PluginSummary).
 *
 * The returned shape is structurally compatible with both HarnessCommand (core)
 * and DiscoveredCommand (renderer), so the adapter reports it directly.
 */

export interface CodexDiscoveredCommand {
  name: string;
  description?: string;
  source: "skill" | "plugin";
  disabledReason?: string;
}

export const CODEX_IN_APP_BROWSER_SKILL = "browser:control-in-app-browser";
export const CODEX_IN_APP_BROWSER_PLUGIN = "browser@openai-bundled";

export interface CodexSkillConfigOverride {
  path: string;
  enabled: false;
}

/**
 * AgentParty does not host Codex's in-app browser. Disable only that skill for
 * this thread, leaving the user's global config and every other plugin intact.
 */
export function unsupportedHostSkillOverrides(response: any): CodexSkillConfigOverride[] {
  const entries: any[] = Array.isArray(response?.data) ? response.data : [];
  const paths = new Set<string>();
  for (const entry of entries) {
    for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
      if (String(skill?.name ?? "") !== CODEX_IN_APP_BROWSER_SKILL) {
        continue;
      }
      const skillPath = String(skill?.path ?? "").trim();
      if (skillPath) {
        paths.add(skillPath);
      }
    }
  }
  return [...paths].map((skillPath) => ({ path: skillPath, enabled: false as const }));
}

/** Flattens a skills/list response ({ data: SkillsListEntry[] }) into palette commands. */
export function skillCommands(response: any, excludedNames: ReadonlySet<string> = new Set()): CodexDiscoveredCommand[] {
  const entries: any[] = Array.isArray(response?.data) ? response.data : [];
  const out: CodexDiscoveredCommand[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
      const name = String(skill?.name ?? "");
      if (!name || excludedNames.has(name) || seen.has(name)) {
        continue;
      }
      seen.add(name);
      out.push({
        name,
        description: String(skill?.shortDescription || skill?.description || ""),
        source: "skill",
        disabledReason: skill?.enabled === false ? "비활성화된 skill" : undefined,
      });
    }
  }
  return out;
}

/** Flattens a plugin/installed response (marketplaces → plugins) into palette commands. */
export function pluginCommands(response: any, excludedIds: ReadonlySet<string> = new Set()): CodexDiscoveredCommand[] {
  const marketplaces: any[] = Array.isArray(response?.marketplaces) ? response.marketplaces : [];
  const out: CodexDiscoveredCommand[] = [];
  const seen = new Set<string>();
  for (const marketplace of marketplaces) {
    for (const plugin of collectPluginSummaries(marketplace)) {
      const id = String(plugin?.id ?? "");
      const name = String(plugin?.name ?? plugin?.id ?? "");
      if (!name || excludedIds.has(id) || !plugin?.installed || seen.has(name)) {
        continue;
      }
      seen.add(name);
      const unavailable = plugin?.availability && plugin.availability !== "AVAILABLE";
      out.push({
        name,
        description: String(plugin?.interface?.shortDescription || (plugin?.keywords || []).join(", ") || ""),
        source: "plugin",
        disabledReason: plugin?.enabled === false ? "비활성화된 plugin" : unavailable ? "관리자가 비활성화함" : undefined,
      });
    }
  }
  return out;
}

/** A marketplace entry may carry plugins under a few shapes; gather any PluginSummary. */
export function collectPluginSummaries(marketplace: any): any[] {
  const buckets = [marketplace?.plugins, marketplace?.entries, marketplace?.installed].filter(Array.isArray);
  const summaries: any[] = [];
  for (const bucket of buckets) {
    for (const item of bucket) {
      summaries.push(item?.summary ?? item);
    }
  }
  return summaries;
}
