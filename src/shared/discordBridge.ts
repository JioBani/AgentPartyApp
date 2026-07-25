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

/**
 * Discord layout (docs/기획 노트.md §11):
 *
 *   category = this desktop        e.g. "WORK-PC"
 *     channel = one party          e.g. #dev-7bd616
 *       thread = one member        e.g. "impl"
 *
 * Names alone cannot identify anything: two PCs — or two workspaces on one PC —
 * routinely hold a party called `dev` with a member called `main`. Reusing a
 * channel by NAME would silently join two machines to one channel and deliver
 * every instruction to both. So the channel name carries a short slice of the
 * party id, and reuse is decided by the identity stamped in the channel topic,
 * never by the name.
 */
export function discordPartyChannelNameOf(partyName: string, partyId: string): string {
  const suffix = shortPartyId(partyId);
  const base = slugPart(partyName) || "party";
  return [base, suffix].filter(Boolean).join("-").slice(0, 90);
}

/** Thread name for one member — scoped by its channel, so the bare name is fine. */
export function discordThreadNameOf(member: string): string {
  return slugPart(member).slice(0, 90) || "member";
}

/** Last chunk of a party id (`party-1784…-7bd616` → `7bd616`) — short but stable. */
export function shortPartyId(partyId: string): string {
  const tail = String(partyId || "").split("-").pop() || "";
  return tail.slice(-6).toLowerCase();
}

/**
 * The identity a channel belongs to, stamped into its Discord topic so reuse is
 * decided by WHAT it is, not what it is called.
 */
export function discordChannelIdentity(input: { desktop: string; workspacePath: string; partyId: string }): string {
  return `agentparty:${input.desktop}|${input.workspacePath}|${input.partyId}`;
}

export function discordChannelTopic(input: { desktop: string; workspacePath: string; partyId: string; partyName: string }): string {
  return `${discordChannelIdentity(input)} · 파티 '${input.partyName}' · ${input.workspacePath}`.slice(0, 1024);
}

function slugPart(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}\-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface DiscordBridgeSettings {
  /**
   * This PC's name, used as the Discord category so several machines can share
   * one server without their identically-named parties colliding. Defaults to
   * the OS hostname.
   */
  desktopName: string;
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
  desktopName: "",
  botToken: "",
  guildId: "",
  allowedUserIds: [],
};

export type DiscordConnectionState = "off" | "connecting" | "connected" | "error";

/** One member ↔ thread binding, plus the party channel that holds it. */
export interface DiscordChannelBinding {
  workspacePath: string;
  party: string;
  member: string;
  /** The party's channel. */
  channelId: string;
  channelName: string;
  /** The member's thread inside that channel — where messages actually flow. */
  threadId: string;
  threadName: string;
}

/** What the UI and `GET /api/discord` report. Never includes the token. */
export interface DiscordBridgeStatus {
  /** This PC's name — the Discord category every party channel lives under. */
  desktopName: string;
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
    desktopName: typeof raw.desktopName === "string" ? raw.desktopName.trim() : "",
    botToken: typeof raw.botToken === "string" ? raw.botToken.trim() : "",
    guildId: typeof raw.guildId === "string" ? raw.guildId.trim() : "",
    allowedUserIds: Array.isArray(raw.allowedUserIds)
      ? raw.allowedUserIds.map((id) => String(id).trim()).filter(Boolean)
      : [],
  };
}

/** Gateway intents: guilds + guild messages + message content (privileged). */
export const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
