/**
 * Discord bridge — the contract shared by the main process, the renderer and the
 * party MCP tools. See docs/기획 노트.md §11.
 *
 * The bridge exists so a member can report OUT to Discord and the user can talk
 * back IN from anywhere, without exposing the app itself to the network. It is
 * deliberately text-only: no buttons, no select menus, no modals (§11.5), so
 * there is no interaction state to keep in sync with the app.
 */

/** Discord's hard per-message limit. Longer content is REJECTED, never truncated. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/** Channel name Discord accepts: lowercase, no spaces. */
export function discordChannelNameOf(member: string): string {
  const slug = member
    .toLowerCase()
    .replace(/[^a-z0-9\-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return slug || "member";
}

export interface DiscordBridgeSettings {
  /** Bot token. Stored in settings.json (outside the repo); masked when read back. */
  botToken: string;
  /** Target guild. Empty = auto-detect, allowed only when the bot is in exactly one guild. */
  guildId: string;
  /**
   * Inbound whitelist of Discord user ids. A message from anyone else is dropped
   * and logged. EMPTY MEANS NOBODY — never "allow all": the member runs with the
   * user's permissions, so an unfiltered channel would be remote code execution.
   */
  allowedUserIds: string[];
}

export const DEFAULT_DISCORD_SETTINGS: DiscordBridgeSettings = {
  botToken: "",
  guildId: "",
  allowedUserIds: [],
};

export type DiscordConnectionState = "off" | "connecting" | "connected" | "error";

/** One member ↔ channel binding. */
export interface DiscordChannelBinding {
  workspacePath: string;
  party: string;
  member: string;
  channelId: string;
  channelName: string;
}

/** What the UI and `GET /api/discord` report. Never includes the token. */
export interface DiscordBridgeStatus {
  /** A token is present (masked value only). */
  configured: boolean;
  /** Gateway state — surfaced so a dead bridge is visible instead of silent. */
  connection: DiscordConnectionState;
  /** Last failure, kept until the next successful connect. */
  error?: string;
  botUser?: { id: string; username: string };
  guildId?: string;
  /** Masked token (e.g. ********abcd) so the UI can show that one is stored. */
  tokenMask?: string;
  allowedUserIds: string[];
  bindings: DiscordChannelBinding[];
}

export function normalizeDiscordSettings(value: unknown): DiscordBridgeSettings {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<DiscordBridgeSettings>;
  return {
    botToken: typeof raw.botToken === "string" ? raw.botToken.trim() : "",
    guildId: typeof raw.guildId === "string" ? raw.guildId.trim() : "",
    allowedUserIds: Array.isArray(raw.allowedUserIds)
      ? raw.allowedUserIds.map((id) => String(id).trim()).filter(Boolean)
      : [],
  };
}

/** Gateway intents: guilds + guild messages + message content (privileged). */
export const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
