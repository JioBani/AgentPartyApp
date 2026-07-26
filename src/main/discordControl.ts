import * as fs from "node:fs";
import * as path from "node:path";
import type { DiscordChannelBinding, DiscordPartyChannel } from "../shared/discordBridge";
import { discordCommandHelp, type DiscordCommandInput } from "../shared/discordCommands";
import { shortPartyId } from "../shared/discordBridge";
import type { DiscordBridgeService } from "./discordBridgeService";
import { getUserDataDir } from "./userDataDir";

/**
 * The Discord control panel (docs/기획 노트.md §11.14).
 *
 * Turns a typed command into an app operation and a reply. Everything here is
 * mechanical — no model is involved — so control keeps working when the member
 * itself is wedged, which is the case control exists for.
 *
 * Two problems shape this module:
 *
 * 1. SEVERAL INSTANCES SEE EVERY MESSAGE. Each AgentParty process on this machine
 *    holds its own gateway socket, so one `!상태` arrives N times. A per-message
 *    claim file makes exactly one of them answer (see claimMessage).
 * 2. THE RIGHT INSTANCE MUST ANSWER. Only the process that runs a member's
 *    session can restart it; another one would start a SECOND session. So
 *    instances bid with a delay ordered by how well they can serve the command.
 */

export interface DiscordMemberState {
  name: string;
  /** idle | opened | running | closed | missing_session */
  status: string;
  model?: string;
  runtime?: string;
  /** True while a turn is in flight. */
  busy?: boolean;
}

export interface DiscordPartySummary {
  id: string;
  name: string;
  memberCount: number;
}

/**
 * What the control panel needs from the app. Implemented in main.ts over
 * AppController so UI, HTTP and Discord all drive the same methods.
 */
export interface DiscordAppPort {
  /** Workspaces this instance currently serves (open windows). */
  workspaces(): string[];
  listParties(workspacePath: string): Promise<DiscordPartySummary[]>;
  listMembers(workspacePath: string, partyId: string): Promise<DiscordMemberState[]>;
  interruptMember(workspacePath: string, partyId: string, member: string): Promise<{ interrupted: boolean; message: string }>;
  respawnMember(workspacePath: string, partyId: string, member: string): Promise<{ message: string }>;
}

export interface DiscordControlContext {
  /** Where the reply goes — the channel or thread the command was typed in. */
  channelId: string;
  messageId: string;
  authorId: string;
  authorName: string;
  /** Set when the command was typed in a member thread. */
  binding?: DiscordChannelBinding;
  /** Set when the command was typed in a registered party channel or its thread. */
  partyChannel?: DiscordPartyChannel;
}

export interface DiscordControlDeps {
  app: DiscordAppPort;
  /** Lazy: the bridge and the control service are constructed together. */
  bridge: () => DiscordBridgeService;
  log?: (message: string) => void;
}

/** A command a non-owning instance must not race the owner for. */
const MEMBER_COMMANDS = new Set(["connect", "disconnect", "interrupt", "respawn"]);

export class DiscordControlService {
  constructor(private readonly deps: DiscordControlDeps) {}

  /**
   * Handles one command. Returns the reply text, or undefined when another
   * instance on this machine claimed the message.
   */
  async handle(command: DiscordCommandInput, context: DiscordControlContext): Promise<string | undefined> {
    if (!command.name) {
      // An unknown keyword is answered, not ignored: silence from a control panel
      // is indistinguishable from a dead bridge.
      if (!(await this.claim(command, context))) {
        return undefined;
      }
      return `알 수 없는 명령 \`${command.keyword}\` 입니다.\n\n${discordCommandHelp()}`;
    }
    if (command.name === "help") {
      return (await this.claim(command, context)) ? discordCommandHelp() : undefined;
    }
    if (command.name === "whoami") {
      // Answered by every instance? No — one reply per machine is enough, and the
      // id is the same regardless of who answers.
      return (await this.claim(command, context))
        ? `당신의 디스코드 사용자 id는 \`${context.authorId}\` 입니다. 설정 → Discord의 허용 사용자 목록에 넣으면 명령을 보낼 수 있습니다.`
        : undefined;
    }

    switch (command.name) {
      case "desktop":
        return this.desktop(command, context);
      case "parties":
        return this.parties(command, context);
      case "register":
        return this.register(command, context);
      case "status":
        return this.status(command, context);
      case "connect":
        return this.connect(command, context);
      case "disconnect":
        return this.disconnect(command, context);
      case "interrupt":
        return this.memberAction(command, context, "interrupt");
      case "respawn":
        return this.memberAction(command, context, "respawn");
      default:
        return undefined;
    }
  }

  // --- Commands ------------------------------------------------------------

  private async desktop(command: DiscordCommandInput, context: DiscordControlContext): Promise<string | undefined> {
    if (!(await this.claim(command, context))) {
      return undefined;
    }
    const bridge = this.deps.bridge();
    const workspaces = this.deps.app.workspaces();
    const lines = [`🖥️ **${bridge.desktopName()}** (pid ${process.pid})`];
    if (!workspaces.length) {
      lines.push("_열려 있는 작업공간이 없습니다._");
    }
    for (const workspace of workspaces) {
      const parties = await this.deps.app.listParties(workspace).catch(() => []);
      lines.push(`• \`${workspace}\` — 파티 ${parties.length}개`);
    }
    lines.push("", "`!파티` 로 파티 목록과 등록용 id를 볼 수 있습니다.");
    return lines.join("\n");
  }

  private async parties(command: DiscordCommandInput, context: DiscordControlContext): Promise<string | undefined> {
    const target = command.args[0];
    if (target && !this.isThisDesktop(target)) {
      return undefined; // addressed to another machine
    }
    if (!(await this.claim(command, context))) {
      return undefined;
    }
    const bridge = this.deps.bridge();
    const lines = [`🖥️ **${bridge.desktopName()}**`];
    for (const workspace of this.deps.app.workspaces()) {
      const parties = await this.deps.app.listParties(workspace).catch((error) => {
        lines.push(`• \`${workspace}\` — 목록 실패: ${describeError(error)}`);
        return [] as DiscordPartySummary[];
      });
      lines.push(`**\`${workspace}\`**`);
      if (!parties.length) {
        lines.push("_파티 없음_");
      }
      for (const party of parties) {
        const registered = bridge.partyChannelFor(workspace, party.id);
        const mark = registered ? `→ #${registered.channelName}` : "미등록";
        lines.push(`• \`${shortPartyId(party.id)}\` **${party.name}** · 멤버 ${party.memberCount} · ${mark}`);
      }
    }
    lines.push("", "`!등록 <파티id>` 로 채널을 만듭니다.");
    return lines.join("\n");
  }

  private async register(command: DiscordCommandInput, context: DiscordControlContext): Promise<string | undefined> {
    const ref = command.args[0];
    const desktopArg = command.args[1];
    if (desktopArg && !this.isThisDesktop(desktopArg)) {
      return undefined;
    }
    if (!ref) {
      return (await this.claim(command, context)) ? "사용법: `!등록 <파티id>` — id는 `!파티` 에서 확인하세요." : undefined;
    }
    const match = await this.resolveParty(ref);
    if (!match) {
      // Silence here is correct: the party lives on a DIFFERENT machine, whose
      // instance will answer. Answering "없음" from every other desktop would
      // bury the one real reply.
      return undefined;
    }
    if (!(await this.claim(command, context))) {
      return undefined;
    }
    const result = await this.deps.bridge().registerParty({
      workspacePath: match.workspace,
      party: match.party.id,
      partyLabel: match.party.name,
    });
    return [
      `${result.created ? "✅ 채널을 만들었습니다" : "ℹ️ 이미 등록된 채널입니다"}: <#${result.channelId}>`,
      `파티 **${match.party.name}** · \`${match.workspace}\``,
      "",
      "채널에서 `!상태` 로 멤버를 보고, `!연결 <멤버>` 로 스레드를 만드세요.",
    ].join("\n");
  }

  private async status(command: DiscordCommandInput, context: DiscordControlContext): Promise<string | undefined> {
    const scope = this.scopeOf(context);
    if (!scope) {
      return (await this.claim(command, context))
        ? "`!상태` 는 등록된 파티 채널이나 멤버 스레드에서 사용하세요. 채널이 없다면 `!파티` → `!등록` 먼저 진행하세요."
        : undefined;
    }
    if (!(await this.claim(command, context))) {
      return undefined;
    }
    const bridge = this.deps.bridge();
    let members: DiscordMemberState[];
    try {
      members = await this.deps.app.listMembers(scope.workspacePath, scope.party);
    } catch (error) {
      return `⚠️ 상태를 읽지 못했습니다: ${describeError(error)}`;
    }
    const lines = [`📊 **${scope.partyName}** · \`${scope.workspacePath}\` · ${bridge.desktopName()}`];
    if (!members.length) {
      lines.push("_멤버 없음_");
    }
    for (const member of members) {
      const bound = bridge.bindingFor(scope.workspacePath, scope.party, member.name);
      lines.push(
        `${statusIcon(member)} **${member.name}** · ${member.status}${member.model ? ` · ${member.model}` : ""}` +
          (bound ? ` · <#${bound.threadId}>` : " · _스레드 없음_"),
      );
    }
    lines.push("", `갱신: \`!상태\` · 연결: \`!연결 <멤버>\` · 재시작: \`!재시작 <멤버>\``);
    return lines.join("\n");
  }

  private async connect(command: DiscordCommandInput, context: DiscordControlContext): Promise<string | undefined> {
    const scope = this.scopeOf(context);
    const member = command.args[0] || context.binding?.member;
    if (!scope || !member) {
      return (await this.claim(command, context))
        ? "사용법: 등록된 파티 채널에서 `!연결 <멤버>`."
        : undefined;
    }
    if (!(await this.claim(command, context, scope, member))) {
      return undefined;
    }
    try {
      const result = await this.deps.bridge().connectMember({
        workspacePath: scope.workspacePath,
        party: scope.party,
        partyLabel: scope.partyName,
        member,
      });
      return `${result.created ? "✅" : "ℹ️"} **${member}** → <#${result.threadId}>\n이 스레드에 적은 글이 멤버에게 전달됩니다.`;
    } catch (error) {
      return `⚠️ 연결 실패: ${describeError(error)}`;
    }
  }

  private async disconnect(command: DiscordCommandInput, context: DiscordControlContext): Promise<string | undefined> {
    const scope = this.scopeOf(context);
    const member = command.args[0] || context.binding?.member;
    if (!scope || !member) {
      return (await this.claim(command, context)) ? "사용법: `!해제 <멤버>` (멤버 스레드에서는 이름 생략 가능)." : undefined;
    }
    if (!(await this.claim(command, context, scope, member))) {
      return undefined;
    }
    const result = this.deps.bridge().disconnectMember(scope.workspacePath, scope.party, member);
    return result.removed
      ? `🔌 **${member}** 의 디스코드 연결을 끊었습니다. 스레드와 기록은 남아 있습니다.`
      : `**${member}** 는 연결되어 있지 않았습니다.`;
  }

  private async memberAction(
    command: DiscordCommandInput,
    context: DiscordControlContext,
    action: "interrupt" | "respawn",
  ): Promise<string | undefined> {
    const scope = this.scopeOf(context);
    const member = command.args[0] || context.binding?.member;
    if (!scope || !member) {
      return (await this.claim(command, context))
        ? `사용법: \`!${action === "interrupt" ? "중단" : "재시작"} <멤버>\` (멤버 스레드에서는 이름 생략 가능).`
        : undefined;
    }
    if (!(await this.claim(command, context, scope, member))) {
      return undefined;
    }
    try {
      if (action === "interrupt") {
        const result = await this.deps.app.interruptMember(scope.workspacePath, scope.party, member);
        return result.interrupted ? `⏹️ **${member}** 의 턴을 중단했습니다.` : `**${member}** 는 진행 중인 턴이 없습니다.`;
      }
      const result = await this.deps.app.respawnMember(scope.workspacePath, scope.party, member);
      return `🔄 **${member}** 세션을 재시작했습니다. ${result.message}`;
    } catch (error) {
      return `⚠️ 실패: ${describeError(error)}`;
    }
  }

  // --- Resolution ----------------------------------------------------------

  private isThisDesktop(name: string): boolean {
    return this.deps.bridge().desktopName().toLowerCase() === name.toLowerCase();
  }

  /** The (workspace, party) a command in this channel targets, if any. */
  private scopeOf(context: DiscordControlContext): { workspacePath: string; party: string; partyName: string } | undefined {
    const channel = context.partyChannel;
    if (!channel) {
      return undefined;
    }
    return { workspacePath: channel.workspacePath, party: channel.party, partyName: channel.partyName };
  }

  /** Finds a party on THIS desktop by its short id, full id, or exact name. */
  private async resolveParty(ref: string): Promise<{ workspace: string; party: DiscordPartySummary } | undefined> {
    const needle = ref.toLowerCase();
    for (const workspace of this.deps.app.workspaces()) {
      const parties = await this.deps.app.listParties(workspace).catch(() => [] as DiscordPartySummary[]);
      const party = parties.find(
        (entry) => entry.id.toLowerCase() === needle || shortPartyId(entry.id) === needle || entry.name.toLowerCase() === needle,
      );
      if (party) {
        return { workspace, party };
      }
    }
    return undefined;
  }

  // --- One answer per machine ----------------------------------------------

  /**
   * Decides whether THIS instance answers a message that every instance saw.
   *
   * The bid delay orders instances by fitness: the process that actually runs the
   * target member's session goes first (only it can interrupt or respawn that
   * session — another one would start a second), then the elected instance for
   * the workspace, then anyone. The first to create the message's claim file
   * wins; `wx` makes that atomic, so no instance has to trust a timer alone.
   */
  private async claim(
    command: DiscordCommandInput,
    context: DiscordControlContext,
    scope?: { workspacePath: string; party: string },
    member?: string,
  ): Promise<boolean> {
    const delay = await this.bidDelay(command, scope, member);
    if (delay > 0) {
      await sleep(delay);
    }
    return claimMessage(context.messageId);
  }

  private async bidDelay(
    command: DiscordCommandInput,
    scope?: { workspacePath: string; party: string },
    member?: string,
  ): Promise<number> {
    if (scope && member && command.name && MEMBER_COMMANDS.has(command.name)) {
      if (await this.runsMemberSession(scope.workspacePath, scope.party, member)) {
        return 0;
      }
      // We could serve it, but starting a session the owner already has would
      // duplicate the member. Let the owner bid first.
      return 900;
    }
    return this.isElected(scope?.workspacePath) ? 0 : 500;
  }

  /**
   * Whether this instance leads the election for the relevant workspaces. With
   * nothing open there is no one else to defer to, so answering is correct —
   * electing nobody would leave the panel mute.
   */
  private isElected(workspacePath?: string): boolean {
    const workspaces = workspacePath ? [workspacePath] : this.deps.app.workspaces();
    const bridge = this.deps.bridge();
    return workspaces.length ? workspaces.every((workspace) => bridge.isElectedFor(workspace)) : true;
  }

  /** Whether this process holds the member's live session (not merely its record). */
  private async runsMemberSession(workspacePath: string, party: string, member: string): Promise<boolean> {
    try {
      const members = await this.deps.app.listMembers(workspacePath, party);
      const entry = members.find((m) => m.name === member);
      // A session started by another process is reported as closed here: the
      // party store is shared on disk but session ids are per-process.
      return Boolean(entry && entry.status !== "closed" && entry.status !== "missing_session");
    } catch {
      return false;
    }
  }
}

const CLAIM_TTL_MS = 10 * 60 * 1000;

function claimsDir(): string {
  return path.join(getUserDataDir(), "discord-claims");
}

/**
 * Exclusive per-message claim, shared by every instance on this machine through
 * userData. `wx` fails if the file exists, so exactly one writer proceeds.
 */
export function claimMessage(messageId: string): boolean {
  const dir = claimsDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sanitizeId(messageId)}.claim`), String(process.pid), { flag: "wx" });
    pruneClaims(dir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      return false; // another instance answered
    }
    // A broken claim store must not silence the panel — answer and risk a
    // duplicate rather than drop the command.
    return true;
  }
}

function pruneClaims(dir: string): void {
  try {
    const cutoff = Date.now() - CLAIM_TTL_MS;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.rmSync(file, { force: true });
      }
    }
  } catch {
    // Housekeeping only.
  }
}

function sanitizeId(value: string): string {
  return String(value || "unknown").replace(/[^A-Za-z0-9_-]/g, "");
}

function statusIcon(member: DiscordMemberState): string {
  if (member.busy || member.status === "running") {
    return "⚙️";
  }
  if (member.status === "closed" || member.status === "missing_session") {
    return "⚪";
  }
  return "🟢";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
