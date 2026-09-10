import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Bot, Package, Plug, Sparkles, Terminal, Users } from "lucide-react";
import { groupByCategory, type PaletteBadge, type PaletteCategory, type PaletteCommand, type PaletteSource } from "./paletteModel";

interface CommandPaletteProps {
  commands: PaletteCommand[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (command: PaletteCommand) => void;
  /** Composer whose inner horizontal edges and top edge anchor the palette. */
  anchor: HTMLElement | null;
}

const EDGE = 8;
const COMPOSER_INSET = 11;
const COMPOSER_OVERLAP = 4;
const MAX_HEIGHT = 340;

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
 * `useCommandPalette`; this component owns only viewport placement.
 *
 * The palette is portalled to `document.body`. Both the composer and each
 * split panel deliberately clip overflow, so leaving this popup inside either
 * container makes a high z-index irrelevant: the command list is cut off at
 * the composer's top edge. Viewport coordinates keep it above every transcript
 * while preserving the active panel's width.
 */
export function CommandPalette({ commands, activeIndex, onHover, onSelect, anchor }: CommandPaletteProps) {
  const groups = groupByCategory(commands);
  const active = commands[activeIndex];
  const [placement, setPlacement] = useState<CSSProperties>();

  const place = useCallback(() => {
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    const width = Math.max(0, Math.min(box.width - COMPOSER_INSET * 2, window.innerWidth - EDGE * 2));
    const left = Math.max(EDGE, Math.min(box.left + COMPOSER_INSET, window.innerWidth - EDGE - width));
    const paletteBottom = box.top + COMPOSER_OVERLAP;
    setPlacement({
      position: "fixed",
      left,
      bottom: window.innerHeight - paletteBottom,
      width,
      maxHeight: Math.max(0, Math.min(MAX_HEIGHT, paletteBottom - EDGE)),
    });
  }, [anchor]);

  useLayoutEffect(() => {
    setPlacement(undefined);
    place();
  }, [place, commands.length]);

  useEffect(() => {
    if (!anchor) return;
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, place]);

  // Flat index across groups so hover/highlight line up with keyboard nav.
  let flatIndex = -1;

  const palette = (
    <div
      className="wb-cmd-palette"
      role="listbox"
      aria-label="Commands"
      style={placement ?? { position: "fixed", left: 0, top: 0, visibility: "hidden" }}
    >
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
                    aria-disabled={Boolean(command.disabledReason)}
                    title={command.disabledReason}
                    className={"wb-cmd-row" + (isActive ? " is-active" : "") + (command.badges?.includes("disabled") ? " is-disabled" : "")}
                    onMouseEnter={() => onHover(index)}
                    onMouseDown={(e) => {
                      // Keep textarea focus; fire before blur.
                      e.preventDefault();
                      if (!command.disabledReason) onSelect(command);
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
          {active.disabledReason && <div className="wb-cmd-preview-disabled">{active.disabledReason}</div>}
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

  return createPortal(palette, document.body);
}
