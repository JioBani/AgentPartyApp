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
  parseDiscordChannelIdentity,
  type DiscordBindingOwner,
  type DiscordBridgeSettings,
  type DiscordBridgeStatus,
  type DiscordChannelBinding,
  type DiscordConnectionState,
  type DiscordPartyChannel,
} from "../shared/discordBridge";
import { DISCORD_COMMAND_PREFIX, parseDiscordCommand, type DiscordCommandInput } from "../shared/discordCommands";
import type { DiscordControlService } from "./discordControl";
import { isProcessAlive, listLiveInstances } from "./discovery";
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
  /** Identifies THIS process run; stamped on every binding it owns. */
  instance: DiscordBindingOwner;
  /** Called whenever status changes so the UI can re-render. */
  onStatusChanged?: (status: DiscordBridgeStatus) => void;
  log?: (message: string) => void;
}

interface StoredBindings {
  bindings: DiscordChannelBinding[];
  /** Party ↔ channel registrations (§11.14). Absent in files written before it. */
  channels?: DiscordPartyChannel[];
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
  private channels: DiscordPartyChannel[] = [];
  private gateway: DiscordGateway | undefined;
  private connection: DiscordConnectionState = "off";
  private lastError: string | undefined;
  private botUser: { id: string; username: string } | undefined;
  private resolvedGuildId: string | undefined;
  private tokenInUse: string | undefined;
  private control: DiscordControlService | undefined;

  constructor(private readonly deps: DiscordBridgeDeps) {
    const stored = this.readStore();
    this.bindings = stored.bindings;
    this.channels = stored.channels;
  }

  /**
   * The control panel is wired after construction: it needs the bridge and the
   * bridge routes commands to it. Without it, `!` messages are reported as
   * unavailable rather than silently delivered to a member as prose.
   */
  setControl(control: DiscordControlService): void {
    this.control = control;
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
    // A token change invalidates everything derived from the old one.
    if (patch.botToken !== undefined || patch.guildId !== undefined) {
      this.botUser = undefined;
      this.resolvedGuildId = undefined;
      this.stopGateway();
    }
    // Saving settings is also the "try again" button: a gateway that stopped on a
    // fatal close (intent off / bad token) only comes back when the user has
    // changed something — which is exactly now.
    this.ensureGateway(true);
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
      partyChannels: [...this.channels],
      instance: this.deps.instance,
    };
  }

  /** This PC's name — the Discord category every party channel lives under. */
  desktopName(): string {
    return this.settings().desktopName;
  }

  partyChannelFor(workspacePath: string, party: string): DiscordPartyChannel | undefined {
    return this.channels.find((entry) => entry.workspacePath === workspacePath && entry.party === party);
  }

  /** The registration a Discord channel id belongs to, if this desktop owns one. */
  partyChannelByChannelId(channelId: string): DiscordPartyChannel | undefined {
    return this.channels.find((entry) => entry.channelId === channelId);
  }

  bindingFor(workspacePath: string, party: string, member: string): DiscordChannelBinding | undefined {
    return this.bindings.find((b) => b.workspacePath === workspacePath && b.party === party && b.member === member);
  }

  /**
   * Whether this instance is the one that should act for a workspace when several
   * are open on this machine. Lowest live pid wins — an arbitrary but stable rule
   * that every instance computes identically from the same discovery files.
   */
  isElectedFor(workspacePath?: string): boolean {
    const workspaces = workspacePath ? [workspacePath] : this.servedWorkspaces();
    if (!workspaces.length) {
      return false;
    }
    return workspaces.every((workspace) => {
      const live = listLiveInstances(workspace);
      // No discovery file yet (the API has not bound): assume we are alone rather
      // than electing nobody, which would make the panel unanswerable.
      return !live.length || live[0].pid === this.deps.instance.pid;
    });
  }

  /** Workspaces this process has registrations or bindings for. */
  private servedWorkspaces(): string[] {
    const all = [...this.channels.map((c) => c.workspacePath), ...this.bindings.map((b) => b.workspacePath)];
    return [...new Set(all)];
  }

  /**
   * Registers a party's channel WITHOUT touching its members — the control-panel
   * `!등록`. Members get threads only when asked (`!연결`), so opening the app
   * never creates Discord noise on its own.
   */
  async registerParty(request: { workspacePath: string; party: string; partyLabel?: string }): Promise<DiscordPartyChannel & { created: boolean }> {
    const settings = this.requireSettings();
    const rest = new DiscordRest(settings.botToken);
    const guildId = await this.resolveGuild(rest, settings.guildId);
    const result = await this.ensurePartyChannel(rest, guildId, settings, request);
    this.ensureGateway();
    this.notify();
    return result;
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
      // Re-connecting is also how a member is handed to THIS instance after a
      // restart: take ownership so the caller is the one that delivers.
      const owned = { ...existing, owner: this.deps.instance };
      this.mutate((store) => {
        store.bindings = [...store.bindings.filter((b) => !sameMember(b, owned)), owned];
      });
      this.ensureGateway();
      return { ...owned, created: false };
    }

    const channel = await this.ensurePartyChannel(rest, guildId, settings, request);
    const thread = await this.resolveThread(rest, guildId, channel.channelId, discordThreadNameOf(request.channelName || request.member));

    const binding: DiscordChannelBinding = {
      workspacePath: request.workspacePath,
      party: request.party,
      member: request.member,
      channelId: channel.channelId,
      channelName: channel.channelName,
      threadId: thread.id,
      threadName: thread.name,
      owner: this.deps.instance,
    };
    this.mutate((store) => {
      store.bindings = [...store.bindings.filter((b) => !sameMember(b, binding)), binding];
    });
    this.ensureGateway();
    this.notify();
    this.log(`Discord: member '${request.member}' bound to #${channel.channelName} > ${thread.name}${channel.created ? " (channel created)" : ""}.`);
    return { ...binding, created: channel.created };
  }

  /**
   * Finds or creates the party's channel under this desktop's category.
   *
   * Reuse is decided by the IDENTITY stamped in the topic (desktop + workspace +
   * party id), never by the channel name. Two PCs — or two workspaces on one PC —
   * routinely hold a party called `dev`; matching by name would join them to one
   * channel and deliver every instruction to both machines.
   */
  private async ensurePartyChannel(
    rest: DiscordRest,
    guildId: string,
    settings: DiscordBridgeSettings,
    request: { workspacePath: string; party: string; partyLabel?: string },
  ): Promise<DiscordPartyChannel & { created: boolean }> {
    const partyName = request.partyLabel || request.party;
    const identityInput = { desktop: settings.desktopName, workspacePath: request.workspacePath, partyId: request.party, partyName };
    const identity = discordChannelIdentity(identityInput);
    const guildChannels = await rest.guildChannels(guildId);

    const category = guildChannels.find((entry) => entry.type === CHANNEL_TYPE_CATEGORY && entry.name === settings.desktopName)
      || (await rest.createCategory(guildId, settings.desktopName));

    let channel = guildChannels.find((entry) => entry.type === CHANNEL_TYPE_TEXT && (entry.topic || "").startsWith(identity));
    const created = !channel;
    if (!channel) {
      channel = await rest.createTextChannel(guildId, discordPartyChannelNameOf(partyName, request.party), {
        topic: discordChannelTopic(identityInput),
        parentId: category.id,
      });
      await this.pinPartyHeader(rest, channel.id, identityInput);
    }

    const record: DiscordPartyChannel = {
      workspacePath: request.workspacePath,
      party: request.party,
      partyName,
      channelId: channel.id,
      channelName: channel.name,
      owner: this.deps.instance,
    };
    this.mutate((store) => {
      store.channels = [...store.channels.filter((c) => !(c.workspacePath === record.workspacePath && c.party === record.party)), record];
    });
    if (created) {
      this.log(`Discord: registered party '${partyName}' as #${channel.name}.`);
    }
    return { ...record, created };
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
      "",
      "제어: `!상태` · `!연결 <멤버>` · `!중단 <멤버>` · `!재시작 <멤버>` · `!도움말`",
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
    let removed = false;
    this.mutate((store) => {
      const before = store.bindings.length;
      store.bindings = store.bindings.filter((b) => !(b.workspacePath === workspacePath && b.party === party && b.member === member));
      removed = store.bindings.length !== before;
    });
    if (removed) {
      this.notify();
    }
    return { removed };
  }

  /**
   * Opens the gateway at app start.
   *
   * A configured token is enough — bindings are NOT required. The control panel
   * is how a party gets registered in the first place (§11.14), so a desktop that
   * only listened once something was already bound could never be reached from
   * Discord after a fresh install.
   */
  resume(): void {
    if (this.settings().botToken) {
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

  private ensureGateway(restart = false): void {
    const settings = this.settings();
    if (!settings.botToken) {
      return;
    }
    if (!restart && this.gateway && this.tokenInUse === settings.botToken) {
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
    // The whitelist gates EVERYTHING, control commands included: a member runs
    // with the user's permissions, so "restart that member" is as powerful as
    // "run this shell command". Empty whitelist means nobody.
    if (!this.settings().allowedUserIds.includes(message.authorId)) {
      this.log(`Discord: dropped a message from unlisted user ${message.authorName} (${message.authorId}).`);
      return;
    }
    // Refresh from disk: a sibling instance may have registered or bound
    // something since our last write, and we would otherwise not recognise its
    // channel at all.
    this.reload();

    const binding = this.bindings.find((b) => b.threadId === message.channelId);
    const partyChannel = binding
      ? this.partyChannelFor(binding.workspacePath, binding.party)
      : this.partyChannelByChannelId(message.channelId);

    const command = parseDiscordCommand(message.content);
    if (command) {
      const scope = partyChannel || (await this.scopeFromTopic(message.channelId));
      if (scope === "foreign") {
        return; // another desktop's channel — its own app answers
      }
      await this.runCommand(command, message, binding, scope);
      return;
    }
    // Only THREAD messages address a member. A message in the party channel body
    // names nobody, so it is logged and dropped — the pinned header already tells
    // the user to write in a member thread, and the bot never posts there itself.
    if (!binding) {
      if (partyChannel) {
        this.log("Discord: ignored a message posted in a party channel body (instructions belong in a member thread).");
      }
      return;
    }
    if (!message.content.trim()) {
      return; // attachment-only message; nothing to inject
    }
    if (!this.claimForDelivery(binding)) {
      // Another instance on this machine runs that member's session. Staying
      // quiet here is what stops one typed instruction from being delivered
      // twice — and from starting a second session for the same member.
      return;
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

  /**
   * Runs a control command from outside Discord (UI / HTTP / QA).
   *
   * The SAME dispatcher the gateway uses, so there is one implementation of every
   * command — this is a second entrance, not a second code path. It exists
   * because the bot cannot type as the user (it ignores its own posts), so
   * without it the panel could only ever be tested by hand.
   */
  async runControlCommand(input: { content: string; channelId?: string; authorId?: string; post?: boolean }): Promise<{ ok: true; handled: boolean; reply?: string }> {
    const command = parseDiscordCommand(input.content);
    if (!command) {
      throw new Error(`'${input.content}' is not a control command — commands start with '${DISCORD_COMMAND_PREFIX}'.`);
    }
    if (!this.control) {
      throw new Error("The Discord control panel is not wired in this process.");
    }
    this.reload();
    const channelId = input.channelId || "";
    const binding = channelId ? this.bindings.find((b) => b.threadId === channelId) : undefined;
    const partyChannel = binding
      ? this.partyChannelFor(binding.workspacePath, binding.party)
      : channelId
        ? this.partyChannelByChannelId(channelId) || (await this.resolveScopeOrUndefined(channelId))
        : undefined;
    const reply = await this.control.handle(command, {
      channelId,
      // Unique per call so the machine-wide claim file never rejects a second
      // request as a duplicate of the first.
      messageId: `api-${this.deps.instance.pid}-${Date.now()}`,
      authorId: input.authorId || "",
      authorName: "automation",
      binding,
      partyChannel,
    });
    if (reply && input.post !== false && channelId) {
      await new DiscordRest(this.requireSettings().botToken).createMessage(channelId, reply);
    }
    return { ok: true, handled: Boolean(reply), reply };
  }

  private async resolveScopeOrUndefined(channelId: string): Promise<DiscordPartyChannel | undefined> {
    const scope = await this.scopeFromTopic(channelId);
    return scope === "foreign" ? undefined : scope;
  }

  /**
   * Works out which party a command's channel belongs to when our own store does
   * not already know, by reading the identity stamped in the channel topic.
   *
   * Every desktop in the guild receives every message. Without this, a command
   * typed in another machine's party channel would be answered by all of them —
   * or, worse, acted on. Returns `"foreign"` for a channel that names a different
   * desktop, so this instance stays quiet.
   */
  private async scopeFromTopic(channelId: string): Promise<DiscordPartyChannel | "foreign" | undefined> {
    const settings = this.settings();
    if (!settings.botToken) {
      return undefined;
    }
    const rest = new DiscordRest(settings.botToken);
    let channel;
    try {
      channel = await rest.channel(channelId);
      if (!channel?.topic && channel?.parent_id) {
        // A thread carries no topic of its own; the party identity is on its
        // parent channel.
        channel = await rest.channel(channel.parent_id);
      }
    } catch (error) {
      this.log(`Discord: could not read channel ${channelId} — ${describe(error)}`);
      return undefined;
    }
    const identity = parseDiscordChannelIdentity(channel?.topic);
    if (!identity) {
      return undefined; // an ordinary channel (e.g. #general) — anyone may answer
    }
    if (identity.desktop !== settings.desktopName) {
      return "foreign";
    }
    // Ours, but not in our store: the bindings file was lost, or a sibling
    // instance registered it. Record it so the panel works from here on.
    const record: DiscordPartyChannel = {
      workspacePath: identity.workspacePath,
      party: identity.partyId,
      partyName: partyNameFromTopic(channel?.topic) || identity.partyId,
      channelId: channel.id,
      channelName: channel.name,
      owner: this.deps.instance,
    };
    this.mutate((store) => {
      store.channels = [...store.channels.filter((c) => c.channelId !== record.channelId), record];
    });
    return record;
  }

  /** Runs one control command and posts its reply where it was typed. */
  private async runCommand(
    command: DiscordCommandInput,
    message: DiscordInboundMessage,
    binding: DiscordChannelBinding | undefined,
    partyChannel: DiscordPartyChannel | undefined,
  ): Promise<void> {
    if (!this.control) {
      this.log("Discord: a control command arrived before the control panel was wired.");
      return;
    }
    let reply: string | undefined;
    try {
      reply = await this.control.handle(command, {
        channelId: message.channelId,
        messageId: message.messageId,
        authorId: message.authorId,
        authorName: message.authorName,
        binding,
        partyChannel,
      });
    } catch (error) {
      reply = `⚠️ 명령 처리 실패: ${describe(error)}`;
    }
    if (!reply) {
      return; // another instance answered, or the command was for another desktop
    }
    try {
      await new DiscordRest(this.requireSettings().botToken).createMessage(message.channelId, reply);
    } catch (error) {
      this.log(`Discord: failed to post a control reply — ${describe(error)}`);
    }
  }

  /**
   * Whether THIS instance delivers for a binding.
   *
   * userData is shared by every AgentParty process on the machine, so all of them
   * see the same binding and all of them receive the message. Only the owner acts.
   * An owner that is gone (crash, quit, or our own previous run) leaves the
   * binding orphaned; the elected instance adopts it so a restart does not
   * silently stop delivering.
   */
  private claimForDelivery(binding: DiscordChannelBinding): boolean {
    const owner = binding.owner;
    const mine = this.deps.instance;
    if (owner && owner.pid === mine.pid && owner.startedAt === mine.startedAt) {
      return true;
    }
    const orphaned = !owner || !isProcessAlive(owner.pid) || (owner.pid === mine.pid && owner.startedAt !== mine.startedAt);
    if (!orphaned) {
      return false;
    }
    if (!this.isElectedFor(binding.workspacePath)) {
      return false;
    }
    this.mutate((store) => {
      store.bindings = store.bindings.map((b) => (sameMember(b, binding) ? { ...b, owner: mine } : b));
    });
    this.log(`Discord: adopted '${binding.member}' (previous owner pid ${owner?.pid ?? "none"} is gone).`);
    this.notify();
    return true;
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

  private readStore(): { bindings: DiscordChannelBinding[]; channels: DiscordPartyChannel[] } {
    try {
      const file = this.bindingsPath();
      if (!fs.existsSync(file)) {
        return { bindings: [], channels: [] };
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
      return { bindings: usable, channels: Array.isArray(parsed?.channels) ? parsed.channels : [] };
    } catch {
      return { bindings: [], channels: [] };
    }
  }

  /** Picks up what sibling instances wrote since our last read. */
  private reload(): void {
    const stored = this.readStore();
    this.bindings = stored.bindings;
    this.channels = stored.channels;
  }

  /**
   * Read-modify-write against the shared file.
   *
   * Several instances share one `discord-bindings.json`. Writing our in-memory
   * copy wholesale would erase a registration a sibling made a moment earlier, so
   * every mutation re-reads first and only then applies its change.
   */
  private mutate(apply: (store: { bindings: DiscordChannelBinding[]; channels: DiscordPartyChannel[] }) => void): void {
    const store = this.readStore();
    apply(store);
    this.bindings = store.bindings;
    this.channels = store.channels;
    const file = this.bindingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ bindings: this.bindings, channels: this.channels } satisfies StoredBindings, null, 2), "utf8");
  }
}

/** Pulls the display name back out of `… · 파티 'name' · …`. */
function partyNameFromTopic(topic?: string): string | undefined {
  const match = /파티 '([^']*)'/.exec(String(topic || ""));
  return match?.[1] || undefined;
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
