/**
 * Command / skill palette model — harness-abstracted.
 *
 * A "palette" is the discovery surface opened from the composer (Claude Code's
 * `/` slash menu, Codex's `/` menu, etc.). The trigger prefix(es) and the
 * available command inventory differ per harness, so everything here is keyed by
 * a `HarnessPalette`. The renderer asks `getHarnessPalette(runtime)` and never
 * hardcodes `/` or a Claude-Code-only command list.
 *
 * This module is pure (no React, no DOM): detection, filtering, and the static
 * inventories live here so they can be unit-tested headlessly and reused by any
 * UI surface.
 */

/** Member runtimes map onto one of these palette dialects. */
export type HarnessId = "claude-code" | "codex";

/** Where a command comes from — drives the source badge. */
export type PaletteSource = "built-in" | "skill" | "agent" | "mcp" | "plugin" | "user" | "project" | "agentparty";

/** Category sections shown in the palette, in display order. */
export type PaletteCategory = "command" | "skill" | "agent" | "mcp" | "plugin" | "agentparty";

/** Capability/condition hints shown as small chips on a command row. */
export type PaletteBadge =
  | "requires-git"
  | "read-only"
  | "edits-files"
  | "background"
  | "cloud"
  | "needs-auth"
  | "destructive"
  | "disabled";

/**
 * How selecting a command resolves. `insert` drops the command (plus a trailing
 * space) into the composer for the user to add arguments and send — the safe
 * default. `action` invokes a locally-wired session action with no round-trip
 * through the model. The composer maps `action` ids to its `WorkbenchActions`.
 */
export type PaletteRun = { type: "insert" } | { type: "action"; action: "compact" | "restart" | "interrupt" };

export interface PaletteCommand {
  /** Stable id within a harness, e.g. "model". */
  id: string;
  /** The full token typed into the composer, e.g. "/model". Prefix included. */
  trigger: string;
  /** Display name (usually the trigger without prefix). */
  title: string;
  description: string;
  category: PaletteCategory;
  /** Omitted when the source/scope is unknown (e.g. a discovered command we can't classify). */
  source?: PaletteSource;
  /** Argument signature shown after the name, e.g. "<member>" or "[topic]". */
  args?: string;
  badges?: PaletteBadge[];
  run: PaletteRun;
}

/** A slash command the live harness reports for a session (SDK `SlashCommand`). */
export interface DiscoveredCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
}

export interface HarnessPalette {
  harness: HarnessId;
  /** Prefixes that open the palette when typed at the start of the composer. */
  prefixes: string[];
  commands: PaletteCommand[];
}

/** Display order + labels for category section headers. */
export const CATEGORY_ORDER: { key: PaletteCategory; label: string }[] = [
  { key: "command", label: "Commands" },
  { key: "skill", label: "Skills" },
  { key: "agent", label: "Agents" },
  { key: "mcp", label: "MCP prompts" },
  { key: "plugin", label: "Plugins" },
  { key: "agentparty", label: "AgentParty" },
];

const SLASH = "/";

/** Claude Code dialect: `/` opens the palette over the full command taxonomy. */
const CLAUDE_CODE: HarnessPalette = {
  harness: "claude-code",
  prefixes: [SLASH],
  commands: [
    // Built-in control commands.
    cmd("model", "Switch session model / effort", "command", "built-in", { args: "[model]" }),
    cmd("compact", "Compact the conversation to free context", "command", "built-in", { run: { type: "action", action: "compact" } }),
    cmd("clear", "Clear the conversation", "command", "built-in", { badges: ["destructive"] }),
    cmd("status", "Show session status", "command", "built-in", { badges: ["read-only"] }),
    cmd("context", "Show context usage breakdown", "command", "built-in", { badges: ["read-only"] }),
    cmd("permissions", "Manage allow / ask / deny rules", "command", "built-in"),
    cmd("diff", "Review uncommitted changes", "command", "built-in", { badges: ["requires-git", "read-only"] }),
    cmd("mcp", "Manage MCP servers", "command", "built-in"),
    cmd("agents", "Manage subagents", "command", "built-in"),
    cmd("tasks", "Show background tasks", "command", "built-in", { badges: ["read-only"] }),
    cmd("resume", "Resume a previous session", "command", "built-in"),
    // Built-in skills (prompt/workflow handed to the model).
    cmd("code-review", "Review the current branch / PR", "skill", "skill", { args: "[PR#]", badges: ["requires-git", "cloud"] }),
    cmd("debug", "Investigate a failure", "skill", "skill", { args: "[topic]" }),
    cmd("deep-research", "Research a question across sources", "skill", "skill", { args: "<question>", badges: ["background"] }),
    cmd("verify", "Verify a claim or change", "skill", "skill", { args: "[claim]" }),
    cmd("loop", "Run a self-paced task loop", "skill", "skill", { args: "[task]", badges: ["background"] }),
    // AgentParty app commands (drive the local API / party surface).
    cmd("member-create", "Create a new party member", "agentparty", "agentparty", { args: "<name>" }),
    cmd("member-open", "Open a member in a new panel", "agentparty", "agentparty", { args: "<name>" }),
    cmd("send-to", "Send a message to another member", "agentparty", "agentparty", { args: "<member> <text>" }),
    cmd("split-panel", "Split the current panel region", "agentparty", "agentparty"),
  ],
};

/** Codex dialect: also `/`-triggered, but a different built-in command set. */
const CODEX: HarnessPalette = {
  harness: "codex",
  prefixes: [SLASH],
  commands: [
    cmd("model", "Switch model", "command", "built-in", { args: "[model]" }),
    cmd("approvals", "Change approval mode", "command", "built-in"),
    cmd("new", "Start a new conversation", "command", "built-in", { badges: ["destructive"] }),
    cmd("init", "Create an AGENTS.md for this repo", "command", "built-in", { badges: ["edits-files"] }),
    cmd("compact", "Summarize to free context", "command", "built-in", { run: { type: "action", action: "compact" } }),
    cmd("diff", "Show working-tree diff", "command", "built-in", { badges: ["requires-git", "read-only"] }),
    cmd("mention", "Mention a file", "command", "built-in", { args: "<path>" }),
    cmd("status", "Show session status", "command", "built-in", { badges: ["read-only"] }),
    cmd("mcp", "List MCP servers", "command", "built-in", { badges: ["read-only"] }),
    // AgentParty commands are harness-independent.
    cmd("member-create", "Create a new party member", "agentparty", "agentparty", { args: "<name>" }),
    cmd("send-to", "Send a message to another member", "agentparty", "agentparty", { args: "<member> <text>" }),
  ],
};

const PALETTES: Record<HarnessId, HarnessPalette> = {
  "claude-code": CLAUDE_CODE,
  codex: CODEX,
};

/** Resolve a member runtime to its palette dialect. Defaults to Claude Code. */
export function getHarnessPalette(runtime: string | undefined): HarnessPalette {
  return runtime === "codex" ? PALETTES.codex : PALETTES["claude-code"];
}

/**
 * Builds the palette for a session. When the live harness has reported its
 * actual command inventory (`discovered`), that is authoritative for *what
 * exists* — plugin commands, skills, MCP prompts, and custom commands all show
 * up here — enriched (category/badges/run) from the static dialect where a name
 * matches a known built-in. AgentParty app commands are always appended since
 * they are not harness slash commands. With no discovery yet (member not
 * started), falls back to the static built-in inventory.
 */
export function buildPalette(runtime: string | undefined, discovered?: DiscoveredCommand[]): HarnessPalette {
  const base = getHarnessPalette(runtime);
  if (!discovered || discovered.length === 0) {
    return base;
  }
  const prefix = base.prefixes[0] ?? SLASH;
  const known = new Map(base.commands.map((c) => [c.id, c]));
  const live = discovered.map((d) => discoveredToCommand(d, prefix, known.get(d.name)));
  const appParty = base.commands.filter((c) => c.source === "agentparty");
  return { ...base, commands: [...live, ...appParty] };
}

/** Classifies a discovered command, enriching from a matching static entry. */
function discoveredToCommand(discovered: DiscoveredCommand, prefix: string, known: PaletteCommand | undefined): PaletteCommand {
  const name = discovered.name;
  const base: PaletteCommand = known
    ? { ...known }
    : { id: name, trigger: prefix + name, title: name, description: "", category: classifyCategory(name), source: classifySource(name), run: { type: "insert" } };
  return {
    ...base,
    id: name,
    trigger: prefix + name,
    title: name,
    // Live metadata wins over the static description / argument hint.
    description: discovered.description || base.description,
    args: discovered.argumentHint || base.args,
  };
}

/** MCP prompts and plugin-namespaced commands are recognizable by name shape. */
function classifyCategory(name: string): PaletteCategory {
  if (name.startsWith("mcp__")) {
    return "mcp";
  }
  if (name.includes(":")) {
    return "plugin";
  }
  return "command";
}

function classifySource(name: string): PaletteSource | undefined {
  if (name.startsWith("mcp__")) {
    return "mcp";
  }
  if (name.includes(":")) {
    return "plugin";
  }
  return undefined;
}

/**
 * The active trigger if the composer text is composing a command — i.e. it
 * starts with a known prefix and no whitespace has been typed yet (commands are
 * recognized only at the start of a message, before arguments begin).
 */
export interface PaletteTrigger {
  prefix: string;
  /** Text typed after the prefix (the partial command name). */
  query: string;
}

export function detectTrigger(text: string, prefixes: string[]): PaletteTrigger | null {
  // A space anywhere means the user has moved on to arguments — palette closes.
  if (/\s/.test(text)) {
    return null;
  }
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      return { prefix, query: text.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * Filters + ranks commands for a query (the text after the prefix). Empty query
 * returns the full inventory unranked (display order). Ranking favors a name
 * prefix match, then a name substring, then a description substring.
 */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return commands;
  }
  const scored: { c: PaletteCommand; score: number }[] = [];
  for (const c of commands) {
    const name = c.id.toLowerCase();
    let score = 0;
    if (name.startsWith(q)) {
      score = 100 - name.length;
    } else if (name.includes(q)) {
      score = 60 - name.indexOf(q);
    } else if (c.description.toLowerCase().includes(q)) {
      score = 20;
    }
    if (score > 0) {
      scored.push({ c, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.c);
}

/** Groups commands into category sections, preserving CATEGORY_ORDER. */
export function groupByCategory(commands: PaletteCommand[]): { key: PaletteCategory; label: string; items: PaletteCommand[] }[] {
  return CATEGORY_ORDER.map(({ key, label }) => ({ key, label, items: commands.filter((c) => c.category === key) })).filter(
    (g) => g.items.length > 0,
  );
}

/** Compact constructor so the inventories above read as data, not boilerplate. */
function cmd(
  id: string,
  description: string,
  category: PaletteCategory,
  source: PaletteSource,
  extra: { args?: string; badges?: PaletteBadge[]; run?: PaletteRun } = {},
): PaletteCommand {
  return {
    id,
    trigger: SLASH + id,
    title: id,
    description,
    category,
    source,
    args: extra.args,
    badges: extra.badges,
    run: extra.run ?? { type: "insert" },
  };
}
