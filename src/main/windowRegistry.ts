import type { BrowserWindow, WebContents } from "electron";
import type { WindowInfo } from "../shared/types";
import { countEvent } from "../shared/perfCounters";
import { workspaceKey } from "../shared/workspaceLocation";

export type { WindowInfo } from "../shared/types";

export interface WindowEntry {
  id: string;
  window: BrowserWindow;
  workspacePath: string;
}

function normalize(workspacePath: string): string {
  return workspaceKey(workspacePath || process.cwd());
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
    countSends(window);
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


/**
 * Counts every message this window is sent, by channel.
 *
 * Wrapped HERE, on registration, because `webContents.send` is called from two
 * dozen places and an app that is slow because it is TALKING too much cannot be
 * diagnosed by instrumenting whichever of them someone happened to think of —
 * the first attempt at this counted one path and reported zero while the app
 * was streaming. One seam, every sender, no call site to keep in sync.
 *
 * The wrapper adds a map increment to a call that already serializes a payload
 * and crosses a process boundary.
 */
function countSends(window: BrowserWindow): void {
  const contents = window.webContents as unknown as { send: (channel: string, ...args: unknown[]) => void; __apCounted?: boolean };
  if (contents.__apCounted) {
    return;
  }
  const original = contents.send.bind(window.webContents);
  contents.send = (channel: string, ...args: unknown[]) => {
    countEvent("ipc.send");
    countEvent(`ipc.send.${channel}`);
    const events = (args[0] as { events?: unknown[] } | undefined)?.events;
    if (Array.isArray(events)) {
      countEvent("ipc.streamEvents", events.length);
    }
    original(channel, ...args);
  };
  contents.__apCounted = true;
}
