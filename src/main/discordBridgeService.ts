import * as fs from "node:fs";
import * as path from "node:path";
import { DiscordRest, DiscordRestError } from "../core/discordRest";
import { DiscordGateway, type DiscordInboundMessage } from "../core/discordGateway";
import {
  DEFAULT_DISCORD_SETTINGS,
  DISCORD_MESSAGE_LIMIT,
  discordChannelNameOf,
  normalizeDiscordSettings,
  type DiscordBridgeSettings,
  type DiscordBridgeStatus,
  type DiscordChannelBinding,
  type DiscordConnectionState,
} from "../shared/discordBridge";
import { getSettings, maskSecret, updateSettings } from "./settings";
import { getUserDataDir } from "./userDataDir";

/**
 * The Discord bridge (docs/기획 노트.md §11).
 *
 * A member calls `connect` (via the party MCP tools) to get its own channel, then
 * `send` to report. What the user types back in that channel is injected into the
 * member's session through the ordinary party-message path, so an idle member is
 * woken and a busy one queues it — no separate delivery rules.
 *
 * Scope choices that are deliberate, not omissions:
 * - No throttling/queueing here. A 429 is returned to the caller (the agent) with
 *   Discord's own wait, and the agent retries. See §11.4.
 * - No interactive components (buttons/menus). §11.5.
 * - Inbound is whitelist-only. An unfiltered channel would let anyone drive an
 *   agent that edits files and runs shell commands on this machine. §11.6.
 */

export interface DiscordDeliverInput {
  binding: DiscordChannelBinding;
  authorName: string;
  content: string;
}

export interface DiscordBridgeDeps {
  /** Injects an inbound Discord message into the member's session. */
  deliver: (input: DiscordDeliverInput) => Promise<{ delivered: boolean; error?: string }>;
  /** Called whenever status changes so the UI can re-render. */
  onStatusChanged?: (status: DiscordBridgeStatus) => void;
  log?: (message: string) => void;
}

interface StoredBindings {
  bindings: DiscordChannelBinding[];
}

export interface DiscordConnectRequest {
  workspacePath: string;
  party: string;
  /** Human-readable party name for the channel name; falls back to the party id. */
  partyLabel?: string;
  member: string;
  /** Override the channel name entirely. */
  channelName?: string;
}

export class DiscordBridgeService {
  private bindings: DiscordChannelBinding[] = [];
  private gateway: DiscordGateway | undefined;
  private connection: DiscordConnectionState = "off";
  private lastError: string | undefined;
  private botUser: { id: string; username: string } | undefined;
  private resolvedGuildId: string | undefined;
  private tokenInUse: string | undefined;

  constructor(private readonly deps: DiscordBridgeDeps) {
    this.bindings = this.readBindings();
  }

  // --- Settings ------------------------------------------------------------

  /**
   * Effective settings: stored values win, environment fills the gaps.
   * The env path exists for development/QA (`.env` is loaded at startup) and is
   * reported in the log so the source of a token is never a mystery.
   */
  settings(): DiscordBridgeSettings {
    const stored = normalizeDiscordSettings(getSettings().discord || DEFAULT_DISCORD_SETTINGS);
    const envToken = (process.env.DISCORD_BOT_TOKEN || "").trim();
    const envUser = (process.env.DISCORD_USER_ID || "").trim();
    return {
      botToken: stored.botToken || envToken,
      guildId: stored.guildId || (process.env.DISCORD_GUILD_ID || "").trim(),
      allowedUserIds: stored.allowedUserIds.length ? stored.allowedUserIds : envUser ? [envUser] : [],
    };
  }

  updateSettings(patch: Partial<DiscordBridgeSettings>): DiscordBridgeStatus {
    const current = normalizeDiscordSettings(getSettings().discord || DEFAULT_DISCORD_SETTINGS);
    const next = normalizeDiscordSettings({ ...current, ...patch });
    updateSettings({ discord: next });
    // A token change invalidates everything derived from the old one.
    if (patch.botToken !== undefined || patch.guildId !== undefined) {
      this.botUser = undefined;
      this.resolvedGuildId = undefined;
      this.stopGateway();
    }
    return this.status();
  }

  status(): DiscordBridgeStatus {
    const settings = this.settings();
    return {
      configured: Boolean(settings.botToken),
      connection: this.connection,
      error: this.lastError,
      botUser: this.botUser,
      guildId: this.resolvedGuildId || settings.guildId || undefined,
      tokenMask: settings.botToken ? maskSecret(settings.botToken) : undefined,
      allowedUserIds: settings.allowedUserIds,
      bindings: [...this.bindings],
    };
  }

  // --- Member operations (driven by the MCP tools and the HTTP API) ---------

  /** Ensures the member has a channel, creating it if needed, and starts inbound. */
  async connectMember(request: DiscordConnectRequest): Promise<DiscordChannelBinding & { created: boolean }> {
    const settings = this.requireSettings();
    const rest = new DiscordRest(settings.botToken);
    const guildId = await this.resolveGuild(rest, settings.guildId);
    const wanted = request.channelName
      ? discordChannelNameOf("", request.channelName)
      : discordChannelNameOf(request.partyLabel || request.party, request.member);

    const existing = this.bindingFor(request.workspacePath, request.party, request.member);
    if (existing) {
      this.ensureGateway();
      return { ...existing, created: false };
    }

    const channels = await rest.guildChannels(guildId);
    const match = channels.find((channel) => channel.type === 0 && channel.name === wanted);
    const channel = match || (await rest.createTextChannel(guildId, wanted, `AgentParty member '${request.member}'`));

    const binding: DiscordChannelBinding = {
      workspacePath: request.workspacePath,
      party: request.party,
      member: request.member,
      channelId: channel.id,
      channelName: channel.name,
    };
    this.bindings = [...this.bindings.filter((b) => !sameMember(b, binding)), binding];
    this.writeBindings();
    this.ensureGateway();
    this.notify();
    this.log(`Discord: member '${request.member}' bound to #${channel.name} (${match ? "existing" : "created"}).`);
    return { ...binding, created: !match };
  }

  /**
   * Sends one message as the member. Over-long content is REJECTED rather than
   * truncated — a silently cut report is worse than an error the agent can act on.
   */
  async sendAsMember(workspacePath: string, party: string, member: string, content: string): Promise<{ channelName: string }> {
    const settings = this.requireSettings();
    const text = String(content ?? "");
    if (!text.trim()) {
      throw new Error("Message content is empty.");
    }
    if (text.length > DISCORD_MESSAGE_LIMIT) {
      throw new Error(
        `Message is ${text.length} characters; Discord's limit is ${DISCORD_MESSAGE_LIMIT}. Split it into several sends — it was NOT truncated or sent.`,
      );
    }
    const binding = this.bindingFor(workspacePath, party, member);
    if (!binding) {
      throw new Error(`Member '${member}' has no Discord channel yet. Call discord-connect first.`);
    }
    await new DiscordRest(settings.botToken).createMessage(binding.channelId, text);
    return { channelName: binding.channelName };
  }

  /** Drops the binding. The channel and its history stay in Discord. */
  disconnectMember(workspacePath: string, party: string, member: string): { removed: boolean } {
    const before = this.bindings.length;
    this.bindings = this.bindings.filter((b) => !(b.workspacePath === workspacePath && b.party === party && b.member === member));
    const removed = this.bindings.length !== before;
    if (removed) {
      this.writeBindings();
      if (!this.bindings.length) {
        this.stopGateway();
      }
      this.notify();
    }
    return { removed };
  }

  /** Starts inbound if anything is bound — called at app start. */
  resume(): void {
    if (this.bindings.length && this.settings().botToken) {
      this.ensureGateway();
    }
  }

  dispose(): void {
    this.stopGateway();
  }

  // --- Internals -----------------------------------------------------------

  private requireSettings(): DiscordBridgeSettings {
    const settings = this.settings();
    if (!settings.botToken) {
      throw new Error("No Discord bot token configured. Set it in Settings → Discord (or DISCORD_BOT_TOKEN for development).");
    }
    return settings;
  }

  private async resolveGuild(rest: DiscordRest, configured: string): Promise<string> {
    if (configured) {
      this.resolvedGuildId = configured;
      return configured;
    }
    if (this.resolvedGuildId) {
      return this.resolvedGuildId;
    }
    const guilds = await rest.guilds();
    if (guilds.length === 1) {
      this.resolvedGuildId = guilds[0].id;
      this.log(`Discord: auto-detected guild '${guilds[0].name}' (${guilds[0].id}).`);
      return this.resolvedGuildId;
    }
    // Ambiguity is reported, never guessed.
    throw new Error(
      guilds.length === 0
        ? "The bot is not in any Discord server. Invite it to your server first."
        : `The bot is in ${guilds.length} servers (${guilds.map((g) => `${g.name}=${g.id}`).join(", ")}). Set the guild id in Settings → Discord.`,
    );
  }

  private ensureGateway(): void {
    const settings = this.settings();
    if (!settings.botToken) {
      return;
    }
    if (this.gateway && this.tokenInUse === settings.botToken) {
      return;
    }
    this.stopGateway();
    this.tokenInUse = settings.botToken;
    const gateway = new DiscordGateway(settings.botToken);
    gateway.on("state", (state: DiscordConnectionState, error?: string) => {
      this.connection = state;
      this.lastError = state === "connected" ? undefined : error || this.lastError;
      if (error) {
        this.log(error);
      }
      if (state === "connected") {
        this.captureBotUser();
      }
      this.notify();
    });
    gateway.on("message", (message: DiscordInboundMessage) => void this.onInbound(message));
    this.gateway = gateway;
    gateway.start();
  }

  private stopGateway(): void {
    this.gateway?.stop();
    this.gateway = undefined;
    this.tokenInUse = undefined;
    this.connection = "off";
  }

  private async captureBotUser(): Promise<void> {
    if (this.botUser) {
      return;
    }
    try {
      const me = await new DiscordRest(this.settings().botToken).me();
      this.botUser = { id: me.id, username: me.username };
      this.notify();
    } catch (error) {
      this.log(`Discord: could not read bot identity — ${String(error)}`);
    }
  }

  private async onInbound(message: DiscordInboundMessage): Promise<void> {
    // Ignore what WE posted (a member's own report echoes back on the gateway).
    // Scoped to this bot's id rather than "any bot" so another sender is still
    // judged by the whitelist below instead of being invisible.
    if (this.botUser ? message.authorId === this.botUser.id : message.authorIsBot) {
      return;
    }
    const binding = this.bindings.find((b) => b.channelId === message.channelId);
    if (!binding) {
      return; // a channel this app does not own
    }
    const allowed = this.settings().allowedUserIds;
    if (!allowed.includes(message.authorId)) {
      // Logged, never delivered: this is the line between "my remote console" and
      // "anyone in the channel can run code on my machine".
      this.log(`Discord: dropped a message from unlisted user ${message.authorName} (${message.authorId}) in #${binding.channelName}.`);
      return;
    }
    if (!message.content.trim()) {
      return; // attachment-only message; nothing to inject
    }
    const result = await this.deps.deliver({ binding, authorName: message.authorName, content: message.content });
    if (!result.delivered) {
      this.log(`Discord: could not deliver to member '${binding.member}' — ${result.error || "unknown error"}`);
      // Tell the user in the channel; a dropped instruction must not be silent.
      try {
        await new DiscordRest(this.settings().botToken).createMessage(
          binding.channelId,
          `⚠️ 전달 실패: ${result.error || "member is not available"}`,
        );
      } catch (error) {
        this.log(`Discord: failed to report the delivery error — ${describe(error)}`);
      }
    }
  }

  private bindingFor(workspacePath: string, party: string, member: string): DiscordChannelBinding | undefined {
    return this.bindings.find((b) => b.workspacePath === workspacePath && b.party === party && b.member === member);
  }

  private notify(): void {
    this.deps.onStatusChanged?.(this.status());
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }

  // Bindings live next to the app's other user data, not in the workspace: they
  // are (workspace, party, member) → channel and must survive a workspace move.
  private bindingsPath(): string {
    return path.join(getUserDataDir(), "discord-bindings.json");
  }

  private readBindings(): DiscordChannelBinding[] {
    try {
      const file = this.bindingsPath();
      if (!fs.existsSync(file)) {
        return [];
      }
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as StoredBindings;
      return Array.isArray(parsed?.bindings) ? parsed.bindings : [];
    } catch {
      return [];
    }
  }

  private writeBindings(): void {
    const file = this.bindingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ bindings: this.bindings } satisfies StoredBindings, null, 2), "utf8");
  }
}

function sameMember(a: DiscordChannelBinding, b: DiscordChannelBinding): boolean {
  return a.workspacePath === b.workspacePath && a.party === b.party && a.member === b.member;
}

export function describe(error: unknown): string {
  if (error instanceof DiscordRestError) {
    return error.retryAfterMs !== undefined ? `${error.message} (retry_after_ms=${error.retryAfterMs})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
