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
export type HarnessId = "claude-code" | "codex" | "cursor";

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
export type PaletteAction =
  | "compact"
  | "restart"
  | "interrupt"
  | "runtime"
  | "permissions"
  | "mcp"
  | "status"
  | "usage"
  | "sessions"
  | "auto-compact"
  | "environment";

export type PaletteRun = { type: "insert" } | { type: "action"; action: PaletteAction };

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
  /** When disabled, why — shown in the palette preview (e.g. "비활성화됨"). */
  disabledReason?: string;
  run: PaletteRun;
}

/** A slash command the live harness reports for a session (SDK `SlashCommand`). */
export interface DiscoveredCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
  /** Explicit provenance from the harness ("skill" | "plugin" | "built-in" | …). */
  source?: string;
  /** Set when the harness reports the command is unavailable, with the reason. */
  disabledReason?: string;
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
const UNSUPPORTED_COMMAND = "AgentParty에서는 지원하지 않는 명령입니다.";

/**
 * Existing AgentParty capabilities that can safely replace a terminal-only
 * slash command. Keeping this mapping here makes the palette inventory and its
 * execution policy one fact: a row cannot look enabled without a real action.
 */
function appActionFor(harness: HarnessId, name: string): PaletteAction | undefined {
  switch (name) {
    case "model":
    case "effort":
      return "runtime";
    case "permissions":
    case "approvals":
      return "permissions";
    case "mcp":
      return "mcp";
    case "status":
      return "status";
    case "usage":
      return "usage";
    case "resume":
      return "sessions";
    case "new":
      return "restart";
    case "stop":
      return "interrupt";
    case "autocompact":
      return "auto-compact";
    case "doctor":
      return "environment";
    case "plan":
      return harness === "claude-code" ? "permissions" : undefined;
    default:
      return undefined;
  }
}

/** Claude Code dialect: `/` opens the palette over the full command taxonomy. */
const CLAUDE_CODE: HarnessPalette = {
  harness: "claude-code",
  prefixes: [SLASH],
  commands: [
    // Built-in control commands.
    cmd("model", "AgentParty Runtime에서 모델과 추론 설정 변경", "command", "built-in", { run: { type: "action", action: "runtime" } }),
    cmd("compact", "Compact the conversation to free context", "command", "built-in", { run: { type: "action", action: "compact" } }),
    cmd("clear", "Clear the conversation", "command", "built-in", { badges: ["destructive"] }),
    cmd("status", "AgentParty 세션 상태 표시", "command", "built-in", { badges: ["read-only"], run: { type: "action", action: "status" } }),
    cmd("context", "Show context usage breakdown", "command", "built-in", { badges: ["read-only"] }),
    cmd("usage", "AgentParty 계정 사용 한도 표시", "command", "built-in", { badges: ["read-only"], run: { type: "action", action: "usage" } }),
    cmd("permissions", "AgentParty 권한 설정 열기", "command", "built-in", { run: { type: "action", action: "permissions" } }),
    cmd("plan", "AgentParty 권한 설정에서 Plan 모드 선택", "command", "built-in", { run: { type: "action", action: "permissions" } }),
    cmd("effort", "AgentParty Runtime에서 추론 강도 변경", "command", "built-in", { run: { type: "action", action: "runtime" } }),
    cmd("autocompact", "AgentParty 자동 압축 설정 열기", "command", "built-in", { run: { type: "action", action: "auto-compact" } }),
    cmd("stop", "현재 실행 중인 턴 중단", "command", "built-in", { run: { type: "action", action: "interrupt" } }),
    cmd("doctor", "AgentParty 환경 진단 열기", "command", "built-in", { run: { type: "action", action: "environment" } }),
    cmd("theme", "Change terminal theme", "command", "built-in", { disabledReason: UNSUPPORTED_COMMAND }),
    cmd("diff", "Review uncommitted changes", "command", "built-in", { badges: ["requires-git", "read-only"], disabledReason: UNSUPPORTED_COMMAND }),
    cmd("mcp", "AgentParty MCP 서버 관리 열기", "command", "built-in", { run: { type: "action", action: "mcp" } }),
    cmd("agents", "Manage subagents", "command", "built-in", { disabledReason: UNSUPPORTED_COMMAND }),
    cmd("tasks", "Show background tasks", "command", "built-in", { badges: ["read-only"], disabledReason: UNSUPPORTED_COMMAND }),
    cmd("resume", "AgentParty 세션 기록 열기", "command", "built-in", { run: { type: "action", action: "sessions" } }),
    // Built-in skills (prompt/workflow handed to the model).
    cmd("code-review", "Review the current branch / PR", "skill", "skill", { args: "[PR#]", badges: ["requires-git", "cloud"] }),
    cmd("debug", "Investigate a failure", "skill", "skill", { args: "[topic]" }),
    cmd("deep-research", "Research a question across sources", "skill", "skill", { args: "<question>", badges: ["background"] }),
    cmd("verify", "Verify a claim or change", "skill", "skill", { args: "[claim]" }),
    cmd("loop", "Run a self-paced task loop", "skill", "skill", { args: "[task]", badges: ["background"] }),
    // AgentParty app commands (drive the local API / party surface).
    cmd("member-create", "Create a new party member", "agentparty", "agentparty", { args: "<name>", disabledReason: UNSUPPORTED_COMMAND }),
    cmd("member-open", "Open a member in a new panel", "agentparty", "agentparty", { args: "<name>", disabledReason: UNSUPPORTED_COMMAND }),
    cmd("send-to", "Send a message to another member", "agentparty", "agentparty", { args: "<member> <text>", disabledReason: UNSUPPORTED_COMMAND }),
    cmd("split-panel", "Split the current panel region", "agentparty", "agentparty", { disabledReason: UNSUPPORTED_COMMAND }),
  ],
};

/** Codex dialect: also `/`-triggered, but a different built-in command set. */
const CODEX: HarnessPalette = {
  harness: "codex",
  prefixes: [SLASH],
  commands: [
    cmd("model", "AgentParty Runtime에서 모델 변경", "command", "built-in", { run: { type: "action", action: "runtime" } }),
    cmd("permissions", "AgentParty 권한 설정 열기", "command", "built-in", { run: { type: "action", action: "permissions" } }),
    cmd("approvals", "구식 이름 — AgentParty 권한 설정 열기", "command", "built-in", { run: { type: "action", action: "permissions" } }),
    cmd("new", "빈 대화로 하드 리스타트", "command", "built-in", { badges: ["destructive"], run: { type: "action", action: "restart" } }),
    cmd("init", "Create an AGENTS.md for this repo", "command", "built-in", { badges: ["edits-files"], disabledReason: UNSUPPORTED_COMMAND }),
    cmd("compact", "Summarize to free context", "command", "built-in", { run: { type: "action", action: "compact" } }),
    cmd("diff", "Show working-tree diff", "command", "built-in", { badges: ["requires-git", "read-only"], disabledReason: UNSUPPORTED_COMMAND }),
    cmd("mention", "Mention a file", "command", "built-in", { args: "<path>", disabledReason: UNSUPPORTED_COMMAND }),
    cmd("status", "AgentParty 세션 상태 표시", "command", "built-in", { badges: ["read-only"], run: { type: "action", action: "status" } }),
    cmd("usage", "AgentParty 계정 사용 한도 표시", "command", "built-in", { badges: ["read-only"], run: { type: "action", action: "usage" } }),
    cmd("mcp", "AgentParty MCP 서버 관리 열기", "command", "built-in", { badges: ["read-only"], run: { type: "action", action: "mcp" } }),
    cmd("resume", "AgentParty 세션 기록 열기", "command", "built-in", { run: { type: "action", action: "sessions" } }),
    cmd("stop", "현재 실행 중인 턴 중단", "command", "built-in", { run: { type: "action", action: "interrupt" } }),
    cmd("autocompact", "AgentParty 자동 압축 설정 열기", "command", "built-in", { run: { type: "action", action: "auto-compact" } }),
    cmd("doctor", "AgentParty 환경 진단 열기", "command", "built-in", { run: { type: "action", action: "environment" } }),
    cmd("theme", "Change terminal theme", "command", "built-in", { disabledReason: UNSUPPORTED_COMMAND }),
    // AgentParty commands are harness-independent.
    cmd("member-create", "Create a new party member", "agentparty", "agentparty", { args: "<name>", disabledReason: UNSUPPORTED_COMMAND }),
    cmd("send-to", "Send a message to another member", "agentparty", "agentparty", { args: "<member> <text>", disabledReason: UNSUPPORTED_COMMAND }),
  ],
};

const PALETTES: Record<HarnessId, HarnessPalette> = {
  "claude-code": CLAUDE_CODE,
  codex: CODEX,
  cursor: {
    ...CLAUDE_CODE,
    harness: "cursor",
    commands: CLAUDE_CODE.commands.map((command) => {
      if (command.id === "compact") {
        return { ...command, id: "compress", trigger: "/compress", title: "compress", description: "Compress the Cursor chat context" };
      }
      if (command.run.type === "action") {
        return command;
      }
      return disable(command, UNSUPPORTED_COMMAND);
    }),
  },
};

/** Resolve a member runtime to its palette dialect. Defaults to Claude Code. */
export function getHarnessPalette(runtime: string | undefined): HarnessPalette {
  return runtime === "codex" ? PALETTES.codex : runtime === "cursor" ? PALETTES.cursor : PALETTES["claude-code"];
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
  const live = discovered.map((d) => discoveredToCommand(d, prefix, known.get(d.name), base.harness));
  // App-backed actions remain available even when the harness does not report
  // the terminal command (the reason we own these rows). Fake AgentParty rows
  // also remain visible, but disabled, until they gain a real controller path.
  const alwaysVisible = base.commands.filter((c) => c.run.type === "action" || c.source === "agentparty");
  const liveIds = new Set(live.map((command) => command.id));
  return { ...base, commands: [...live, ...alwaysVisible.filter((command) => !liveIds.has(command.id))] };
}

/** Classifies a discovered command, enriching from a matching static entry. */
function discoveredToCommand(discovered: DiscoveredCommand, prefix: string, known: PaletteCommand | undefined, harness: HarnessId): PaletteCommand {
  const name = discovered.name;
  // Explicit harness-reported source wins over name-shape inference.
  const source = explicitSource(discovered.source) ?? known?.source ?? classifySource(name);
  const category = categoryForSource(source) ?? known?.category ?? classifyCategory(name);
  const base: PaletteCommand = known
    ? { ...known }
    : { id: name, trigger: prefix + name, title: name, description: "", category, source, run: { type: "insert" } };
  const action = appActionFor(harness, name);
  // Discovery is authoritative for availability. Treat disabled reasons as a
  // blocklist: a newly registered skill/plugin is usable unless the harness or
  // an explicit static entry says otherwise. An allowlist of known names makes
  // every newly installed skill look unsupported until AgentParty ships again.
  const disabledReason = discovered.disabledReason || base.disabledReason;
  const badges = disabledReason
    ? [...(base.badges || []).filter((b) => b !== "disabled"), "disabled" as PaletteBadge]
    : (base.badges || []).filter((b) => b !== "disabled");
  return {
    ...base,
    id: name,
    trigger: prefix + name,
    title: name,
    category,
    source,
    // Live metadata wins over the static description / argument hint.
    description: discovered.description || base.description,
    args: discovered.argumentHint || base.args,
    badges,
    disabledReason,
    run: action ? { type: "action", action } : base.run,
  };
}

function disable(command: PaletteCommand, reason: string): PaletteCommand {
  return {
    ...command,
    disabledReason: command.disabledReason || reason,
    badges: [...(command.badges || []).filter((badge) => badge !== "disabled"), "disabled"],
  };
}

/** A harness-reported source string, when it names a known palette source. */
function explicitSource(source: string | undefined): PaletteSource | undefined {
  const known: PaletteSource[] = ["built-in", "skill", "agent", "mcp", "plugin", "user", "project", "agentparty"];
  return known.find((s) => s === source);
}

/** Section a source belongs in (skills group under Skills, plugins under Plugins, …). */
function categoryForSource(source: PaletteSource | undefined): PaletteCategory | undefined {
  switch (source) {
    case "skill":
      return "skill";
    case "plugin":
      return "plugin";
    case "mcp":
      return "mcp";
    case "agent":
      return "agent";
    case "agentparty":
      return "agentparty";
    case "built-in":
      return "command";
    default:
      return undefined;
  }
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
  extra: { args?: string; badges?: PaletteBadge[]; run?: PaletteRun; disabledReason?: string } = {},
): PaletteCommand {
  return {
    id,
    trigger: SLASH + id,
    title: id,
    description,
    category,
    source,
    args: extra.args,
    badges: extra.disabledReason
      ? [...(extra.badges || []).filter((badge) => badge !== "disabled"), "disabled"]
      : extra.badges,
    disabledReason: extra.disabledReason,
    run: extra.run ?? { type: "insert" },
  };
}
