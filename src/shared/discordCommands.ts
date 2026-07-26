/**
 * Discord control-panel command grammar (docs/기획 노트.md §11.14).
 *
 * Commands are MECHANICAL: parsed here and executed by the app directly, never
 * handed to an LLM. A member runs with the user's permissions, so "ask the agent
 * to restart itself" would make every control action depend on a model deciding
 * to cooperate — and on a permission prompt nobody can answer from a phone. A
 * fixed vocabulary keeps control working even when the member is wedged, which
 * is exactly when control is needed.
 *
 * Pure and dependency-free, so the main process and unit tests share one grammar.
 */

export const DISCORD_COMMAND_PREFIX = "!";

export type DiscordCommandName =
  | "help"
  | "desktop"
  | "parties"
  | "register"
  | "status"
  | "connect"
  | "disconnect"
  | "interrupt"
  | "respawn"
  | "whoami";

/**
 * Korean and English spellings map to the same command. The user drives this from
 * a phone in whichever language the keyboard happens to be in; making them
 * remember which one the bot speaks is a needless failure mode.
 */
const ALIASES: Record<string, DiscordCommandName> = {
  ap: "help",
  help: "help",
  h: "help",
  도움말: "help",
  명령어: "help",

  desktop: "desktop",
  desktops: "desktop",
  pc: "desktop",
  데스크톱: "desktop",
  피시: "desktop",

  parties: "parties",
  party: "parties",
  파티: "parties",
  파티목록: "parties",

  register: "register",
  reg: "register",
  등록: "register",

  status: "status",
  st: "status",
  상태: "status",

  connect: "connect",
  연결: "connect",

  disconnect: "disconnect",
  해제: "disconnect",

  interrupt: "interrupt",
  stop: "interrupt",
  중단: "interrupt",
  정지: "interrupt",

  respawn: "respawn",
  restart: "respawn",
  재시작: "respawn",

  whoami: "whoami",
  나: "whoami",
  내아이디: "whoami",
};

export interface DiscordCommandInput {
  /** Canonical command, or undefined when the keyword is not one we know. */
  name?: DiscordCommandName;
  /** What the user actually typed after the prefix, for the error message. */
  keyword: string;
  args: string[];
}

/**
 * Returns undefined for anything that is not a command, so ordinary text still
 * flows to the member. Only a leading `!` is treated as control input.
 */
export function parseDiscordCommand(content: string): DiscordCommandInput | undefined {
  const text = String(content ?? "").trim();
  if (!text.startsWith(DISCORD_COMMAND_PREFIX)) {
    return undefined;
  }
  const parts = text.slice(DISCORD_COMMAND_PREFIX.length).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return { name: "help", keyword: "", args: [] };
  }
  const keyword = parts[0].toLowerCase();
  return { name: ALIASES[keyword], keyword: parts[0], args: parts.slice(1) };
}

/** Help text. Kept here so the grammar and its documentation cannot drift apart. */
export function discordCommandHelp(): string {
  return [
    "**AgentParty 제어판**",
    "",
    "__어디서나__",
    "`!pc` — 이 서버에 연결된 데스크톱과 작업공간을 확인",
    "`!파티 [데스크톱]` — 파티 목록 (등록에 쓰는 짧은 id 포함)",
    "`!등록 <파티id> [데스크톱]` — 그 파티의 채널을 만들고 연결",
    "`!나` — 내 디스코드 사용자 id (허용 목록에 넣을 때 필요)",
    "",
    "__파티 채널 / 멤버 스레드에서__",
    "`!상태` — 멤버별 진행 상태",
    "`!연결 <멤버>` — 그 멤버의 스레드를 만들기",
    "`!중단 [멤버]` — 진행 중인 턴 중단",
    "`!재시작 [멤버]` — 멤버 세션 재시작 (대화는 이어짐)",
    "`!해제 [멤버]` — 디스코드 연결만 끊기 (스레드는 남음)",
    "",
    "멤버 스레드에서는 멤버 이름을 생략하면 그 스레드의 멤버가 대상입니다.",
    "명령이 아닌 글은 그대로 멤버에게 전달됩니다.",
  ].join("\n");
}
