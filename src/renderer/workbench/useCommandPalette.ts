import { KeyboardEvent, useEffect, useMemo, useState } from "react";
import {
  buildPalette,
  detectTrigger,
  filterCommands,
  type DiscoveredCommand,
  type PaletteCommand,
  type PaletteRun,
} from "./paletteModel";

interface UseCommandPaletteOptions {
  /** Member runtime — selects the harness dialect (prefixes + inventory). */
  runtime: string | undefined;
  /** Live command inventory reported by the harness; overrides the static set. */
  discovered?: DiscoveredCommand[];
  draft: string;
  setDraft: (text: string) => void;
  /** Runs a command wired to a local session action (e.g. compact). */
  onAction: (action: Extract<PaletteRun, { type: "action" }>["action"]) => void;
}

export interface CommandPaletteState {
  open: boolean;
  matches: PaletteCommand[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  apply: (command: PaletteCommand) => void;
  /** Feed the composer's keydown here first; returns true if it consumed the key. */
  handleKeyDown: (event: KeyboardEvent) => boolean;
}

/**
 * Drives the composer command palette: detects the active trigger from the
 * draft, filters the harness inventory, and owns selection state + keyboard
 * navigation. Harness-agnostic — all dialect specifics come from
 * `getHarnessPalette(runtime)`.
 */
export function useCommandPalette({ runtime, discovered, draft, setDraft, onAction }: UseCommandPaletteOptions): CommandPaletteState {
  const palette = useMemo(() => buildPalette(runtime, discovered), [runtime, discovered]);
  const trigger = useMemo(() => detectTrigger(draft, palette.prefixes), [draft, palette]);
  const matches = useMemo(() => (trigger ? filterCommands(palette.commands, trigger.query) : []), [trigger, palette]);

  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  // Reset the highlight whenever the candidate set changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.query, palette]);

  // Re-arm after the trigger goes away (command sent, cleared, or args started).
  useEffect(() => {
    if (!trigger) {
      setDismissed(false);
    }
  }, [trigger]);

  const open = Boolean(trigger) && !dismissed && matches.length > 0;

  function apply(command: PaletteCommand) {
    if (command.run.type === "action") {
      onAction(command.run.action);
      setDraft("");
    } else {
      // Insert the command + a space so the user can type arguments; the
      // trailing space ends the trigger and closes the palette.
      setDraft(command.trigger + " ");
    }
    setDismissed(true);
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (!open) {
      return false;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((i) => (i + 1) % matches.length);
        return true;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
        return true;
      case "Enter":
      case "Tab":
        event.preventDefault();
        apply(matches[Math.min(activeIndex, matches.length - 1)]);
        return true;
      case "Escape":
        event.preventDefault();
        setDismissed(true);
        return true;
      default:
        return false;
    }
  }

  return { open, matches, activeIndex, setActiveIndex, apply, handleKeyDown };
}
