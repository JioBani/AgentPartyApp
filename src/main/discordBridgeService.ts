import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CHANNEL_TYPE_CATEGORY, CHANNEL_TYPE_TEXT, DiscordRest, DiscordRestError, type DiscordChannel } from "../core/discordRest";
import { DiscordGateway, type DiscordInboundMessage } from "../core/discordGateway";
import {
  DEFAULT_DISCORD_SETTINGS,
  DISCORD_MESSAGE_LIMIT,
  discordChannelIdentity,
  discordChannelTopic,
  discordPartyChannelNameOf,
  discordThreadNameOf,
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
  /** Overridable so the gateway lifecycle is testable without a real socket. */
  createGateway?: (token: string) => DiscordGateway;
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
      // Identifies THIS pc among several sharing one Discord server.
      desktopName: stored.desktopName || (process.env.AGENTPARTY_DESKTOP_NAME || "").trim() || os.hostname(),
      botToken: stored.botToken || envToken,
      guildId: stored.guildId || (process.env.DISCORD_GUILD_ID || "").trim(),
      allowedUserIds: stored.allowedUserIds.length ? stored.allowedUserIds : envUser ? [envUser] : [],
    };
  }

  updateSettings(patch: Partial<DiscordBridgeSettings>): DiscordBridgeStatus {
    const current = normalizeDiscordSettings(getSettings().discord || DEFAULT_DISCORD_SETTINGS);
    const next = normalizeDiscordSettings({ ...current, ...patch });
    updateSettings({ discord: next });
    // Compare VALUES, not `patch` keys: the settings form resubmits every field,
    // so `patch.guildId !== undefined` is true even when the guild id is unchanged.
    const tokenChanged = current.botToken !== next.botToken;
    const guildChanged = current.guildId !== next.guildId;
    // The guild id only feeds REST channel resolution; the bot identity derives
    // from the token. Invalidate the cached derivations of whatever actually moved.
    if (guildChanged) {
      this.resolvedGuildId = undefined;
    }
    if (tokenChanged) {
      this.botUser = undefined;
      this.resolvedGuildId = undefined;
      // The gateway socket authenticates with the token alone, so ONLY a token
      // change requires reconnecting it — a guild-id (or allowlist) edit must not
      // tear down inbound delivery. Bring a socket straight back on the new token
      // if any member is still bound, so saving settings never leaves inbound dead.
      this.stopGateway();
      if (this.bindings.length && next.botToken) {
        this.ensureGateway();
      }
    }
    return this.status();
  }

  status(): DiscordBridgeStatus {
    const settings = this.settings();
    return {
      desktopName: settings.desktopName,
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

  /**
   * Resolves (creating as needed) this member's place in Discord:
   *
   *   category "<desktop>" → channel "#<party>-<id>" → thread "<member>"
   *
   * The channel is matched by the IDENTITY stamped in its topic (desktop +
   * workspace + party id), never by name. Two PCs — or two workspaces on one PC —
   * routinely hold a party called `dev` with a member called `main`; matching by
   * name would quietly join them to one channel and deliver every instruction the
   * user typed to BOTH machines.
   */
  async connectMember(request: DiscordConnectRequest): Promise<DiscordChannelBinding & { created: boolean }> {
    const settings = this.requireSettings();
    const rest = new DiscordRest(settings.botToken);
    const guildId = await this.resolveGuild(rest, settings.guildId);

    const existing = this.bindingFor(request.workspacePath, request.party, request.member);
    if (existing) {
      this.ensureGateway();
      return { ...existing, created: false };
    }

    const partyName = request.partyLabel || request.party;
    const identityInput = { desktop: settings.desktopName, workspacePath: request.workspacePath, partyId: request.party, partyName };
    const identity = discordChannelIdentity(identityInput);
    const channels = await rest.guildChannels(guildId);

    const category = channels.find((entry) => entry.type === CHANNEL_TYPE_CATEGORY && entry.name === settings.desktopName)
      || (await rest.createCategory(guildId, settings.desktopName));

    let channel = channels.find((entry) => entry.type === CHANNEL_TYPE_TEXT && (entry.topic || "").startsWith(identity));
    const createdChannel = !channel;
    if (!channel) {
      channel = await rest.createTextChannel(guildId, discordPartyChannelNameOf(partyName, request.party), {
        topic: discordChannelTopic(identityInput),
        parentId: category.id,
      });
      await this.pinPartyHeader(rest, channel.id, identityInput);
    }

    const thread = await this.resolveThread(rest, guildId, channel.id, discordThreadNameOf(request.channelName || request.member));

    const binding: DiscordChannelBinding = {
      workspacePath: request.workspacePath,
      party: request.party,
      member: request.member,
      channelId: channel.id,
      channelName: channel.name,
      threadId: thread.id,
      threadName: thread.name,
    };
    this.bindings = [...this.bindings.filter((b) => !sameMember(b, binding)), binding];
    this.writeBindings();
    this.ensureGateway();
    this.notify();
    this.log(`Discord: member '${request.member}' bound to #${channel.name} > ${thread.name}${createdChannel ? " (channel created)" : ""}.`);
    return { ...binding, created: createdChannel };
  }

  /** Finds the member's thread, reviving an auto-archived one, else creates it. */
  private async resolveThread(rest: DiscordRest, guildId: string, channelId: string, name: string): Promise<DiscordChannel> {
    const active = (await rest.activeThreads(guildId)).find((thread) => thread.parent_id === channelId && thread.name === name);
    if (active) {
      return active;
    }
    const archived = (await rest.archivedThreads(channelId)).find((thread) => thread.name === name);
    if (archived) {
      // Archived threads still accept messages, but reviving one keeps the member
      // visible in the thread list instead of hidden behind "archived".
      await rest.unarchiveThread(archived.id);
      return archived;
    }
    return rest.createThread(channelId, name);
  }

  /**
   * Pins one header stating WHICH machine, workspace and party a channel serves.
   * Channel names repeat across PCs; this is what makes a channel self-explanatory
   * when it is read on a phone weeks later.
   */
  private async pinPartyHeader(rest: DiscordRest, channelId: string, input: { desktop: string; workspacePath: string; partyId: string; partyName: string }): Promise<void> {
    const header = [
      `📌 **AgentParty · ${input.desktop}**`,
      `파티: **${input.partyName}** (${input.partyId})`,
      `작업공간: ${input.workspacePath}`,
      "",
      "멤버마다 스레드가 하나씩 있습니다. 지시는 해당 **멤버 스레드**에 적어주세요 — 이 채널 본문에 쓴 글은 전달되지 않습니다.",
    ].join("\n");
    try {
      const message = await rest.createMessage(channelId, header);
      await rest.pinMessage(channelId, message.id);
    } catch (error) {
      // A missing Manage Messages permission must not block bridging — but it is
      // reported rather than swallowed.
      this.log(`Discord: could not pin the channel header — ${describe(error)}`);
    }
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
      throw new Error(`Member '${member}' has no Discord thread yet. Call discord-connect first.`);
    }
    await new DiscordRest(settings.botToken).createMessage(binding.threadId, text);
    return { channelName: `${binding.channelName} > ${binding.threadName}` };
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
    const gateway = (this.deps.createGateway ?? ((token) => new DiscordGateway(token)))(settings.botToken);
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
    // Only THREAD messages address a member. A message in the party channel body
    // names nobody, so it is logged and dropped — the pinned header already tells
    // the user to write in a member thread, and the bot never posts there itself.
    const binding = this.bindings.find((b) => b.threadId === message.channelId);
    if (!binding) {
      if (this.bindings.some((b) => b.channelId === message.channelId)) {
        this.log("Discord: ignored a message posted in a party channel body (instructions belong in a member thread).");
      }
      return;
    }
    const allowed = this.settings().allowedUserIds;
    if (!allowed.includes(message.authorId)) {
      // Logged, never delivered: this is the line between "my remote console" and
      // "anyone in the channel can run code on my machine".
      this.log(`Discord: dropped a message from unlisted user ${message.authorName} (${message.authorId}) in #${binding.channelName} > ${binding.threadName}.`);
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
          binding.threadId,
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
      const stored = Array.isArray(parsed?.bindings) ? parsed.bindings : [];
      // Bindings written before members moved into threads name a channel but no
      // thread. Sending to one would post to `undefined`, so they are dropped —
      // the member re-connects and gets its thread. Reported, not silent.
      const usable = stored.filter((binding) => Boolean(binding?.threadId));
      if (usable.length !== stored.length) {
        this.log(`Discord: dropped ${stored.length - usable.length} binding(s) from the pre-thread layout — those members need discord-connect again.`);
      }
      return usable;
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
