import { Bot, Package, Plug, Sparkles, Terminal, Users } from "lucide-react";
import { groupByCategory, type PaletteBadge, type PaletteCategory, type PaletteCommand, type PaletteSource } from "./paletteModel";

interface CommandPaletteProps {
  commands: PaletteCommand[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (command: PaletteCommand) => void;
}

const CATEGORY_ICON: Record<PaletteCategory, typeof Terminal> = {
  command: Terminal,
  skill: Sparkles,
  agent: Bot,
  mcp: Plug,
  plugin: Package,
  agentparty: Users,
};

const SOURCE_LABEL: Record<PaletteSource, string> = {
  "built-in": "built-in",
  skill: "skill",
  agent: "agent",
  mcp: "MCP",
  plugin: "plugin",
  user: "user",
  project: "project",
  agentparty: "AgentParty",
};

const BADGE_LABEL: Record<PaletteBadge, string> = {
  "requires-git": "git",
  "read-only": "read-only",
  "edits-files": "edits files",
  background: "background",
  cloud: "cloud",
  "needs-auth": "needs auth",
  destructive: "destructive",
  disabled: "disabled",
};

/**
 * The composer slash-palette popover. Renders the filtered command inventory
 * grouped into category sections, with a source badge, argument signature, and
 * capability chips per row. Selection/keyboard state is owned by
 * `useCommandPalette`; this component is presentational.
 */
export function CommandPalette({ commands, activeIndex, onHover, onSelect }: CommandPaletteProps) {
  const groups = groupByCategory(commands);
  const active = commands[activeIndex];
  // Flat index across groups so hover/highlight line up with keyboard nav.
  let flatIndex = -1;

  return (
    <div className="wb-cmd-palette" role="listbox" aria-label="Commands">
      <div className="wb-cmd-list">
        {groups.map((group) => {
          const Icon = CATEGORY_ICON[group.key];
          return (
            <div className="wb-cmd-group" key={group.key}>
              <div className="wb-cmd-group-head">{group.label}</div>
              {group.items.map((command) => {
                flatIndex += 1;
                const index = flatIndex;
                const isActive = index === activeIndex;
                return (
                  <button
                    type="button"
                    key={command.id}
                    role="option"
                    aria-selected={isActive}
                    className={"wb-cmd-row" + (isActive ? " is-active" : "")}
                    onMouseEnter={() => onHover(index)}
                    onMouseDown={(e) => {
                      // Keep textarea focus; fire before blur.
                      e.preventDefault();
                      onSelect(command);
                    }}
                  >
                    <Icon size={14} className="wb-cmd-icon" />
                    <span className="wb-cmd-name">{command.trigger}</span>
                    {command.args && <span className="wb-cmd-args">{command.args}</span>}
                    <span className="wb-cmd-desc">{command.description}</span>
                    {command.source && <span className="wb-cmd-source">{SOURCE_LABEL[command.source]}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      {active && (
        <div className="wb-cmd-preview">
          <div className="wb-cmd-preview-title">
            <span className="wb-mono">{active.trigger}</span>
            {active.args && <span className="wb-cmd-args">{active.args}</span>}
          </div>
          <div className="wb-cmd-preview-desc">{active.description}</div>
          {active.badges && active.badges.length > 0 && (
            <div className="wb-cmd-badges">
              {active.badges.map((badge) => (
                <span key={badge} className={"wb-cmd-badge is-" + badge}>
                  {BADGE_LABEL[badge]}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
