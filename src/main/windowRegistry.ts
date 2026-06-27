import * as path from "node:path";
import type { BrowserWindow, WebContents } from "electron";
import type { WindowInfo } from "../shared/types";

export type { WindowInfo } from "../shared/types";

export interface WindowEntry {
  id: string;
  window: BrowserWindow;
  workspacePath: string;
}

function normalize(workspacePath: string): string {
  return path.resolve(workspacePath || process.cwd());
}

/**
 * Tracks the open windows and the workspace each one is viewing. One main
 * process owns many windows; this is how the rest of main resolves "which
 * workspace does this request belong to" (by sender window) and "which windows
 * must I notify when a workspace changes" (broadcast).
 */
export class WindowRegistry {
  private entries = new Map<string, WindowEntry>();

  register(window: BrowserWindow, workspacePath: string): WindowEntry {
    const id = `win-${window.id}`;
    const entry: WindowEntry = { id, window, workspacePath: normalize(workspacePath) };
    this.entries.set(id, entry);
    window.on("closed", () => this.entries.delete(id));
    return entry;
  }

  get(id: string): WindowEntry | undefined {
    return this.entries.get(id);
  }

  byWebContents(contents: WebContents): WindowEntry | undefined {
    for (const entry of this.entries.values()) {
      if (entry.window.webContents === contents) {
        return entry;
      }
    }
    return undefined;
  }

  setWorkspace(id: string, workspacePath: string): WindowEntry | undefined {
    const entry = this.entries.get(id);
    if (entry) {
      entry.workspacePath = normalize(workspacePath);
    }
    return entry;
  }

  /** Every window currently viewing the given workspace (for broadcasts). */
  forWorkspace(workspacePath: string): WindowEntry[] {
    const key = normalize(workspacePath);
    return [...this.entries.values()].filter((entry) => normalize(entry.workspacePath) === key);
  }

  all(): WindowEntry[] {
    return [...this.entries.values()];
  }

  /** Resolves a target window: explicit id → that window; else the focused one. */
  resolve(id?: string): WindowEntry | undefined {
    if (id) {
      return this.entries.get(id);
    }
    const entries = [...this.entries.values()];
    return entries.find((entry) => entry.window.isFocused()) || entries[0];
  }

  list(): WindowInfo[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.id,
      workspacePath: entry.workspacePath,
      focused: entry.window.isFocused(),
    }));
  }
}
