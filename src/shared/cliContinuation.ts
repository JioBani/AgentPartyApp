import { resolveCatalogModel } from "./modelCatalog";
import type { CwdProblem } from "./memberLocation";
import type { MemberRuntime, PartyMember } from "./types";
import type { WorkspaceLocation } from "./workspaceLocation";

export type CliContinuationAction = "inspect" | "launch";

export interface CliContinuationTarget {
  harness: "claude-code" | "codex" | "cursor" | "grok";
  sessionId: string;
  model: string;
}

export interface CliContinuationDetails extends CliContinuationTarget {
  ok: true;
  supported: true;
  member: string;
  cwd: string;
  host: "local" | "wsl";
  distro?: string;
  command: string;
  launched: boolean;
  /** The saved member location cannot currently be used by the app. */
  locationProblem?: CwdProblem;
  /** Copyable template for resuming the same harness thread at another cwd. */
  repairCommand?: string;
  /** AgentParty deliberately does not guess a new permanent member location. */
  cwdSync: "not-automatic";
  /** Present after `launch`; useful for diagnostics and automated cleanup. */
  terminalPid?: number;
  transcriptSync: "not-automatic";
}

export interface CliContinuationUnavailable {
  ok: true;
  supported: false;
  member: string;
  reason: string;
  launched: false;
}

export type CliContinuationResult = CliContinuationDetails | CliContinuationUnavailable;

const NATIVE_PROVIDER: Record<CliContinuationTarget["harness"], string> = {
  "claude-code": "anthropic",
  codex: "openai",
  cursor: "cursor",
  grok: "xai",
};

/** Normalises the one legacy spelling still present in persisted member data. */
export function continuationHarness(runtime: MemberRuntime | undefined): CliContinuationTarget["harness"] | undefined {
  if (runtime === "claude" || runtime === "claude-code") return "claude-code";
  if (runtime === "codex" || runtime === "cursor" || runtime === "grok") return runtime;
  return undefined;
}

/**
 * Whether a member's thread can be resumed by the user's ordinary CLI.
 *
 * AgentParty can route a harness through another vendor or a local router, but
 * opening `claude --resume` / `codex resume` outside the app does not recreate
 * those private transport settings. Claiming success would resume with the
 * wrong account/model (or fail after the app session was already closed), so
 * only the harness's own provider is transferable.
 */
export function cliContinuationTarget(member: Pick<PartyMember, "runtime" | "model" | "harnessSessionId">):
  | { supported: true; target: CliContinuationTarget }
  | { supported: false; reason: string } {
  const harness = continuationHarness(member.runtime);
  if (!harness) {
    return { supported: false, reason: "이 멤버의 하네스를 확인할 수 없습니다." };
  }
  if (!member.harnessSessionId) {
    return { supported: false, reason: "아직 CLI에서 이어갈 수 있는 대화가 없습니다. 먼저 한 턴 이상 완료해 주세요." };
  }
  const model = String(member.model || "");
  const catalog = resolveCatalogModel(model);
  if (!catalog) {
    return { supported: false, reason: `모델 '${model || "알 수 없음"}'의 제공자를 확인할 수 없어 안전하게 CLI로 넘길 수 없습니다.` };
  }
  if (catalog.provider !== NATIVE_PROVIDER[harness]) {
    const crossProviders = new Set(["anthropic", "openai", "cursor", "xai"]);
    const kind = crossProviders.has(catalog.provider) ? "교차 하네스" : "외부 라우터";
    return {
      supported: false,
      reason: `${kind} 세션은 기본 CLI에서 같은 실행 경로를 복원할 수 없어 CLI로 이어가기를 지원하지 않습니다.`,
    };
  }
  return { supported: true, target: { harness, sessionId: member.harnessSessionId, model } };
}

/** Shell-neutral argv. The launcher quotes it for PowerShell/bash as needed. */
export function cliContinuationArgv(target: CliContinuationTarget, host: WorkspaceLocation["host"]): string[] {
  switch (target.harness) {
    case "claude-code":
      return ["claude", "--resume", target.sessionId];
    case "codex":
      return ["codex", "resume", target.sessionId];
    case "cursor":
      // The official Unix installer exposes `agent`; Windows also installs the
      // user-facing `cursor-agent` launcher.
      return [host.kind === "wsl" ? "agent" : "cursor-agent", "--resume", target.sessionId];
    case "grok":
      return ["grok", "--resume", target.sessionId];
  }
}

/** A copyable command. cwd is deliberately returned separately in the API/UI. */
export function formatCliContinuationCommand(argv: readonly string[], shell: "powershell" | "bash"): string {
  const quote = shell === "bash" ? quoteBash : quotePowerShell;
  return argv.map(quote).join(" ");
}

/**
 * Command template for the rare case where a member's saved cwd disappeared.
 * Claude Code uses the shell's cwd; the other CLIs expose an explicit cwd flag.
 */
export function cliCrossCwdContinuationCommand(
  target: CliContinuationTarget,
  host: WorkspaceLocation["host"],
  shell: "powershell" | "bash",
): string {
  const replacement = shell === "bash" ? "/new/project/path" : "C:\\new\\project\\path";
  if (target.harness === "claude-code") {
    const enter = shell === "bash"
      ? `cd -- ${quoteBash(replacement)}`
      : `Set-Location -LiteralPath ${quotePowerShell(replacement)}`;
    return `${enter}${shell === "bash" ? " && " : "; "}${formatCliContinuationCommand(cliContinuationArgv(target, host), shell)}`;
  }
  const argv = cliContinuationArgv(target, host);
  if (target.harness === "codex") argv.push("-C", replacement);
  if (target.harness === "cursor") argv.splice(1, 0, "--workspace", replacement);
  if (target.harness === "grok") argv.splice(1, 0, "--cwd", replacement);
  return formatCliContinuationCommand(argv, shell);
}

function quotePowerShell(value: string): string {
  return /^[a-zA-Z0-9._:\\/-]+$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}

function quoteBash(value: string): string {
  return /^[a-zA-Z0-9._:/-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}
