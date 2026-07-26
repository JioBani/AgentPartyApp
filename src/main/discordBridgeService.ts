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
import { DEFAULT_MAX_IMAGE_BYTES, type ImageAttachment } from "../shared/attachments";
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

/**
 * Attachment ceiling for a free (unboosted) Discord server. Boosted servers allow
 * more, but assuming the smaller limit turns a would-be 40x rejection from
 * Discord into a message the agent can act on before spending the upload.
 */
const DISCORD_UPLOAD_LIMIT = 10 * 1024 * 1024;

/** Receipt marks put on the user's own message (§11.14.3). */
const RECEIPT_DELIVERED = "📨";
const RECEIPT_WORKING = "⚙️";
const RECEIPT_DONE = "✅";
const RECEIPT_STALLED = "⚠️";
const RECEIPT_POLL_MS = 1500;
/**
 * How long a member may take to START on the message. Generous, because an
 * interrupted turn has to unwind first — but finite, so "the member is wedged"
 * becomes visible instead of looking like ordinary thinking.
 */
const RECEIPT_START_TIMEOUT_MS = 90_000;
/** A turn may legitimately run a long time; stop watching rather than promise ✅. */
const RECEIPT_DONE_TIMEOUT_MS = 30 * 60_000;

export interface DiscordDeliverInput {
  binding: DiscordChannelBinding;
  authorName: string;
  content: string;
  /** Images the user attached in Discord, already downloaded and decoded. */
  attachments?: ImageAttachment[];
}

export interface DiscordBridgeDeps {
  /** Injects an inbound Discord message into the member's session. */
  deliver: (input: DiscordDeliverInput) => Promise<{ delivered: boolean; error?: string }>;
  /** Identifies THIS process run; stamped on every binding it owns. */
  instance: DiscordBindingOwner;
  /**
   * Harness-derived turn state for a bound member, used for delivery receipts.
   * `turnCount` comes from the adapter and increments when a message is actually
   * submitted to the model — which is what makes the receipt a FACT rather than
   * the agent being asked to promise it replied.
   */
  memberTurn?: (binding: DiscordChannelBinding) => Promise<{ turnCount: number; turnActive: boolean }>;
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
  async connectMember(request: DiscordConnectRequest): Promise<DiscordChannelBinding & { created: boolean; threadCreated: boolean }> {
    const settings = this.requireSettings();
    const rest = new DiscordRest(settings.botToken);
    const guildId = await this.resolveGuild(rest, settings.guildId);

    const existing = this.bindingFor(request.workspacePath, request.party, request.member);
    // A binding is only reusable if what it points at STILL EXISTS. Discord is
    // edited by people: deleting a channel takes its threads with it, and the
    // stale binding then fails every send with "Unknown Channel" forever — the
    // one thing re-connecting is supposed to fix. Observed in QA after a channel
    // was deleted by hand.
    if (existing && (await this.threadIsUsable(rest, existing))) {
      // Re-connecting is also how a member is handed to THIS instance after a
      // restart: take ownership so the caller is the one that delivers.
      const owned = { ...existing, owner: this.deps.instance };
      this.mutate((store) => {
        store.bindings = [...store.bindings.filter((b) => !sameMember(b, owned)), owned];
      });
      this.ensureGateway();
      return { ...owned, created: false, threadCreated: false };
    }
    if (existing) {
      this.log(`Discord: '${request.member}' was bound to a thread that no longer exists — rebuilding it.`);
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
    return { ...binding, created: channel.created, threadCreated: thread.created };
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

  /**
   * Whether a binding's thread is still there — and still inside the party's
   * current channel. Both can change without the app knowing: someone deletes
   * the channel in Discord, or the party is registered again and gets a new one.
   */
  private async threadIsUsable(rest: DiscordRest, binding: DiscordChannelBinding): Promise<boolean> {
    const current = this.partyChannelFor(binding.workspacePath, binding.party);
    if (current && current.channelId !== binding.channelId) {
      return false;
    }
    try {
      const thread = await rest.channel(binding.threadId);
      return Boolean(thread?.id);
    } catch (error) {
      if (error instanceof DiscordRestError && error.status === 404) {
        return false;
      }
      // A network blip is not proof the thread is gone; keep the binding and let
      // the actual send report the failure rather than silently rebuilding.
      this.log(`Discord: could not verify '${binding.member}' thread — ${describe(error)}`);
      return true;
    }
  }

  /** Finds the member's thread, reviving an auto-archived one, else creates it. */
  private async resolveThread(rest: DiscordRest, guildId: string, channelId: string, name: string): Promise<DiscordChannel & { created: boolean }> {
    const active = (await rest.activeThreads(guildId)).find((thread) => thread.parent_id === channelId && thread.name === name);
    if (active) {
      return { ...active, created: false };
    }
    const archived = (await rest.archivedThreads(channelId)).find((thread) => thread.name === name);
    if (archived) {
      // Archived threads still accept messages, but reviving one keeps the member
      // visible in the thread list instead of hidden behind "archived".
      await rest.unarchiveThread(archived.id);
      return { ...archived, created: false };
    }
    return { ...(await rest.createThread(channelId, name)), created: true };
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
    await this.guardMissingThread(binding, () => new DiscordRest(settings.botToken).createMessage(binding.threadId, text));
    return { channelName: `${binding.channelName} > ${binding.threadName}` };
  }

  /**
   * Uploads one image as the member. Over-size content is REJECTED with the limit
   * stated, the same attitude as the 2000-character rule — a silently dropped
   * screenshot is worse than an error the agent can act on.
   */
  async sendImageAsMember(
    workspacePath: string,
    party: string,
    member: string,
    image: { dataBase64: string; filename: string; mediaType: string },
    caption?: string,
  ): Promise<{ channelName: string }> {
    const settings = this.requireSettings();
    const bytes = Buffer.from(image.dataBase64 || "", "base64");
    if (!bytes.length) {
      throw new Error("The image is empty.");
    }
    if (bytes.length > DISCORD_UPLOAD_LIMIT) {
      throw new Error(
        `The image is ${Math.round(bytes.length / 1024)} KB; Discord's upload limit on this server is ${Math.round(DISCORD_UPLOAD_LIMIT / 1024 / 1024)} MB. It was NOT sent — shrink or crop it.`,
      );
    }
    if ((caption || "").length > DISCORD_MESSAGE_LIMIT) {
      throw new Error(`The caption is ${caption!.length} characters; Discord's limit is ${DISCORD_MESSAGE_LIMIT}.`);
    }
    const binding = this.bindingFor(workspacePath, party, member);
    if (!binding) {
      throw new Error(`Member '${member}' has no Discord thread yet. Call discord-connect first.`);
    }
    await this.guardMissingThread(binding, () =>
      new DiscordRest(settings.botToken).createMessageWithFile(
        binding.threadId,
        { filename: image.filename || "image.png", contentType: image.mediaType || "image/png", bytes },
        caption,
      ),
    );
    return { channelName: `${binding.channelName} > ${binding.threadName}` };
  }

  /**
   * Turns "Unknown Channel" into an instruction. A thread deleted in Discord
   * would otherwise fail every send with an opaque 404 and no way out; dropping
   * the binding means the next `discord-connect` rebuilds it.
   */
  private async guardMissingThread<T>(binding: DiscordChannelBinding, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof DiscordRestError && error.status === 404) {
        this.disconnectMember(binding.workspacePath, binding.party, binding.member);
        throw new Error(
          `The Discord thread for '${binding.member}' no longer exists (it was deleted in Discord). The binding has been cleared — call discord-connect again to get a new thread. Nothing was sent.`,
        );
      }
      throw error;
    }
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
    const attachments = await this.imagesOf(binding, message);
    if (!message.content.trim() && !attachments.length) {
      return; // nothing to inject (e.g. a non-image file we already reported)
    }
    if (!this.claimForDelivery(binding)) {
      // Another instance on this machine runs that member's session. Staying
      // quiet here is what stops one typed instruction from being delivered
      // twice — and from starting a second session for the same member.
      return;
    }
    // Read the turn counter BEFORE injecting: the receipt is "a turn started that
    // was not running when I sent this", which needs the earlier value.
    const before = await this.turnCountOf(binding);
    const result = await this.deps.deliver({ binding, authorName: message.authorName, content: message.content, attachments });
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
      return;
    }
    // Not awaited: the receipt outlives this handler by design (a turn can run for
    // half an hour) and must not hold up the next inbound message.
    void this.trackReceipt(binding, message.messageId, before);
  }

  /**
   * Downloads the images a user attached in Discord so they ride along as
   * ordinary user-turn attachments — the same shape the app's own composer
   * produces, so vision support and per-model limits are already handled.
   *
   * Anything that cannot be delivered (a non-image file, an over-size image, a
   * failed download) is REPORTED in the thread. Sending a photo and having the
   * agent answer as if there were none is exactly the silent failure this
   * project forbids.
   */
  private async imagesOf(binding: DiscordChannelBinding, message: DiscordInboundMessage): Promise<ImageAttachment[]> {
    const images: ImageAttachment[] = [];
    const skipped: string[] = [];
    for (const attachment of message.attachments || []) {
      const mediaType = attachment.contentType?.split(";")[0]?.trim() || "";
      if (!mediaType.startsWith("image/")) {
        skipped.push(`${attachment.filename} (이미지가 아님)`);
        continue;
      }
      if (attachment.size > DEFAULT_MAX_IMAGE_BYTES) {
        skipped.push(`${attachment.filename} (${Math.round(attachment.size / 1024)} KB > ${Math.round(DEFAULT_MAX_IMAGE_BYTES / 1024)} KB 제한)`);
        continue;
      }
      try {
        const response = await fetch(attachment.url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        images.push({
          kind: "image",
          mediaType,
          dataBase64: Buffer.from(await response.arrayBuffer()).toString("base64"),
          name: attachment.filename,
        });
      } catch (error) {
        skipped.push(`${attachment.filename} (내려받기 실패: ${describe(error)})`);
      }
    }
    if (skipped.length) {
      await this.postQuietly(binding.threadId, `⚠️ 첨부 ${skipped.length}건은 전달하지 못했습니다: ${skipped.join(", ")}`);
    }
    return images;
  }

  // --- Delivery receipt (docs/기획 노트.md §11.14.3) -------------------------

  /**
   * Marks the user's own message with what actually happened to it:
   *
   *   📨 delivered → ⚙️ the model started a turn → ✅ that turn finished
   *   ⚠️ nothing started (the member never picked it up)
   *
   * Every step is read from the HARNESS (`turnCount` increments when a message is
   * really submitted to the model, `turnActive` while it runs), not from the agent
   * being asked to confirm. An agent can forget, misread the instruction, or die
   * mid-turn — and those are exactly the cases a receipt has to catch.
   */
  private async trackReceipt(binding: DiscordChannelBinding, messageId: string, before: number): Promise<void> {
    if (!this.deps.memberTurn) {
      return; // no turn source in this process (headless engine): no receipt
    }
    const react = async (emoji: string): Promise<boolean> => {
      try {
        await new DiscordRest(this.requireSettings().botToken).addReaction(binding.threadId, messageId, emoji);
        return true;
      } catch (error) {
        // Usually a missing "Add Reactions" permission. Say so once, in the
        // thread, rather than leaving the user waiting for a mark that can
        // never appear.
        this.log(`Discord: could not add the '${emoji}' receipt — ${describe(error)}`);
        return false;
      }
    };
    if (!(await react(RECEIPT_DELIVERED))) {
      await this.postQuietly(binding.threadId, "ℹ️ 수신 표시(리액션)를 달 수 없습니다 — 봇에 '반응 추가' 권한이 없습니다. 전달 자체는 정상입니다.");
      return;
    }
    const started = await this.waitForTurn(binding, (turn) => turn.turnCount > before, RECEIPT_START_TIMEOUT_MS);
    if (!started) {
      await react(RECEIPT_STALLED);
      await this.postQuietly(
        binding.threadId,
        `⚠️ **${binding.member}** 가 ${Math.round(RECEIPT_START_TIMEOUT_MS / 1000)}초 안에 이 메시지를 처리하기 시작하지 않았습니다. \`!상태\` 로 확인하거나 \`!재시작 ${binding.member}\` 를 쓰세요.`,
      );
      return;
    }
    await react(RECEIPT_WORKING);
    if (await this.waitForTurn(binding, (turn) => !turn.turnActive, RECEIPT_DONE_TIMEOUT_MS)) {
      await react(RECEIPT_DONE);
    }
  }

  /** Polls the member's harness state until `done`, or gives up. */
  private async waitForTurn(
    binding: DiscordChannelBinding,
    done: (turn: { turnCount: number; turnActive: boolean }) => boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await delay(RECEIPT_POLL_MS);
      const turn = await this.turnOf(binding);
      if (turn && done(turn)) {
        return true;
      }
    }
    return false;
  }

  private async turnOf(binding: DiscordChannelBinding): Promise<{ turnCount: number; turnActive: boolean } | undefined> {
    try {
      return await this.deps.memberTurn?.(binding);
    } catch (error) {
      this.log(`Discord: could not read '${binding.member}' turn state — ${describe(error)}`);
      return undefined;
    }
  }

  private async turnCountOf(binding: DiscordChannelBinding): Promise<number> {
    return (await this.turnOf(binding))?.turnCount ?? 0;
  }

  /** Posts a note whose failure must not break the caller. */
  private async postQuietly(channelId: string, content: string): Promise<void> {
    try {
      await new DiscordRest(this.requireSettings().botToken).createMessage(channelId, content);
    } catch (error) {
      this.log(`Discord: could not post a note — ${describe(error)}`);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
