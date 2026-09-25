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

/** Flattens a skills/list response ({ data: SkillsListEntry[] }) into palette commands. */
export function skillCommands(response: any): CodexDiscoveredCommand[] {
  const entries: any[] = Array.isArray(response?.data) ? response.data : [];
  const out: CodexDiscoveredCommand[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
      const name = String(skill?.name ?? "");
      if (!name || seen.has(name)) {
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
export function pluginCommands(response: any): CodexDiscoveredCommand[] {
  const marketplaces: any[] = Array.isArray(response?.marketplaces) ? response.marketplaces : [];
  const out: CodexDiscoveredCommand[] = [];
  const seen = new Set<string>();
  for (const marketplace of marketplaces) {
    for (const plugin of collectPluginSummaries(marketplace)) {
      const name = String(plugin?.name ?? plugin?.id ?? "");
      if (!name || !plugin?.installed || seen.has(name)) {
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
