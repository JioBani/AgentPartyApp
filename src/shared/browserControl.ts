/** One browser belongs to one party member. The browser profile is ephemeral in the MVP. */
export type BrowserActionName =
  | "state" | "tab" | "show" | "hide" | "open" | "back" | "forward" | "reload"
  | "snapshot" | "screenshot" | "click" | "type" | "scroll" | "close";

export interface BrowserActionInput {
  action: BrowserActionName;
  url?: string;
  x?: number;
  y?: number;
  text?: string;
  deltaY?: number;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface BrowserState {
  partyId: string;
  member: string;
  url: string;
  title: string;
  loading: boolean;
  visible: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserActionResult {
  ok: true;
  state: BrowserState;
  snapshot?: string;
  scroll?: { requestedY: number; appliedY: number };
  image?: { mimeType: "image/png"; dataBase64: string };
}

/** Electron-free port used by AppController and by the member tool bridge. */
export interface BrowserControlPort {
  action(partyId: string, member: string, input: BrowserActionInput, windowId?: string): Promise<BrowserActionResult>;
  dispose(): void;
}
