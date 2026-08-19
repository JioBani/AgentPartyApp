/**
 * What this machine still needs before AgentParty can actually run a member.
 *
 * Sibling of {@link ./diagnostics}, and deliberately a SEPARATE report: that one
 * is a bug-report snapshot ("which build, which OS, where are the logs"), this
 * one is an actionable readiness check ("codex is not installed — here is the
 * command"). Mixing them would force one screen to answer two unrelated
 * questions and would make the paste-into-an-issue text carry install buttons.
 *
 * Shared (not renderer-local) because the environment screen, the in-transcript
 * blocker card, and `GET /api/environment` hand out the SAME report — an agent
 * driving the HTTP API sees exactly what the user sees.
 *
 * Deliberately free of secrets: paths and versions only, never a token or key.
 */

export type EnvironmentStatus =
  /** Ready to use. */
  | "ok"
  /** Usable, but something will bite later (version skew, missing optional tool). */
  | "warn"
  /** Not installed / not signed in. The thing this screen exists to fix. */
  | "missing"
  /** Installed but the probe itself failed — surfaced, never swallowed. */
  | "error"
  /** Not probed yet (e.g. WSL, which is only checked on request). */
  | "unknown";

/**
 * One way out of a failed check. A check usually carries several, ordered
 * cheapest-and-safest first, because "let the app install it for me" and "give
 * me the command so I can read it before running it" are both legitimate and we
 * refuse to force either.
 */
export interface EnvironmentRemedy {
  kind: "command" | "docs" | "settings" | "repair";
  label: string;
  /** `command`: the shell line to copy (and what `repair` would run). */
  command?: string;
  /** `docs`: the official install/help page. */
  url?: string;
  /** `settings`: the AppSettings field that points at an executable. */
  settingsField?: string;
  /** `repair`: allowlisted id accepted by `POST /api/environment/repair`. */
  repairId?: string;
  /**
   * `repair`: confirmation prompt. Present exactly when running the repair
   * changes the USER'S system (installing a CLI) rather than app-owned state
   * (the SDK copy inside a distro's `~/.agent_party_app`), so the UI cannot
   * accidentally make a system-wide change feel like a routine button.
   */
  confirm?: string;
}

export type EnvironmentGroup = "runtime" | "harness" | "wsl";

export type EnvironmentProbeStepStatus = "pending" | "running" | "ok" | "failed" | "skipped";

export type EnvironmentExecutionHost =
  | { kind: "windows"; label: "Windows"; workspace?: string }
  | { kind: "wsl"; label: string; distro: string; workspace?: string };

export type EnvironmentProbeFailureKind =
  | "workspace"
  | "not-found"
  | "authentication"
  | "spawn"
  | "timeout"
  | "exit"
  | "protocol";

/**
 * One observable stage of a harness readiness check. Keeping this structured
 * lets the settings UI and automation API name the exact boundary that failed
 * instead of collapsing every child-process problem into "spawn UNKNOWN".
 */
export interface EnvironmentProbeStep {
  /** Stable within one check: workspace, executable, version, auth, runtime. */
  id: string;
  label: string;
  status: EnvironmentProbeStepStatus;
  /** What was proven, or why this stage could not complete. */
  detail: string;
  durationMs?: number;
  /** The exact process invocation boundary used for this proof. */
  command?: string;
  /** Host-native cwd passed to the process (Windows or POSIX). */
  cwd?: string;
  /** Exact file or directory inspected by a non-process step. */
  path?: string;
  /** Machine-readable reason the step failed; never inferred from translated copy. */
  failureKind?: EnvironmentProbeFailureKind;
  /** OS errno, exit code, or protocol code where one exists. */
  failureCode?: string;
  /** Untranslated OS/CLI evidence. Never populated with successful auth output. */
  raw?: string;
}

export interface EnvironmentCheck {
  /** Stable id — also the de-dup key for the in-transcript blocker card. */
  id: string;
  group: EnvironmentGroup;
  label: string;
  status: EnvironmentStatus;
  /** Why it is in this state, in the user's language. Never empty. */
  detail: string;
  /** Where this check runs. Windows and each WSL distro are distinct hosts. */
  host?: EnvironmentExecutionHost;
  version?: string;
  /** Where the thing was found, so "it IS installed" disputes are resolvable. */
  path?: string;
  /**
   * The raw probe failure (English CLI output, paths tried). Kept out of
   * `detail` so the card can read like a sentence, but never dropped — it is
   * what a bug report needs.
   */
  raw?: string;
  /** Ordered execution proof; the first failed stage is the root boundary. */
  steps?: EnvironmentProbeStep[];
  remedies?: EnvironmentRemedy[];
}

export interface EnvironmentReport {
  checkedAt: string;
  /**
   * The Claude Code CLI version this build's Agent SDK is paired with. The SDK
   * pins its native binary to its OWN exact version, so a host CLI that drifts
   * from this is the single most likely cause of a Claude member misbehaving.
   */
  expectedClaudeCli?: string;
  checks: EnvironmentCheck[];
}

/** Checks that stop work outright, worst first — what a card should lead with. */
export function environmentBlockers(report: EnvironmentReport): EnvironmentCheck[] {
  return report.checks.filter((check) => check.status === "missing" || check.status === "error");
}

export function findEnvironmentCheck(report: EnvironmentReport, id: string): EnvironmentCheck | undefined {
  return report.checks.find((check) => check.id === id);
}

/**
 * The Agent SDK and the Claude Code CLI ship as one unit under two version
 * lines: SDK `0.3.N` is built against CLI `2.1.N` (verified 0.3.191 ↔ 2.1.191,
 * and the SDK pins `claude-agent-sdk-<platform>@<its own version>`). Translating
 * here means the environment screen can say "expected 2.1.191, found 2.1.229"
 * instead of showing an SDK number the user has never seen.
 */
export function claudeCliVersionForSdk(sdkVersion: string | undefined): string | undefined {
  const match = /^0\.(\d+)\.(\d+)$/.exec(String(sdkVersion || "").trim());
  if (!match) {
    return undefined;
  }
  const [, minor, patch] = match;
  return `2.${Number(minor) - 2}.${patch}`;
}

/** Same shape of "pasteable plain text" as {@link formatDiagnosticsReport}. */
export function formatEnvironmentReport(report: EnvironmentReport): string {
  const lines = report.checks.map((check) => {
    const facts = [check.version, check.path].filter(Boolean).join(" @ ");
    const host = check.host
      ? `${check.host.label}${check.host.workspace ? ` · ${check.host.workspace}` : ""}`
      : "";
    const steps = (check.steps || []).flatMap((step) => {
      const failure = [step.failureKind, step.failureCode].filter(Boolean).join(" · ");
      return [
        `    - [${step.status}] ${step.label}: ${step.detail}`,
        step.path ? `      path: ${step.path}` : "",
        step.cwd ? `      cwd: ${step.cwd}` : "",
        step.command ? `      command: ${step.command}` : "",
        failure ? `      failure: ${failure}` : "",
      ].filter(Boolean);
    });
    return [
      `[${check.status}] ${check.label}${facts ? ` — ${facts}` : ""}`,
      host ? `    host: ${host}` : "",
      `    ${check.detail}`,
      ...steps,
    ].filter(Boolean).join("\n");
  });
  return [
    `환경 점검 ${report.checkedAt}`,
    report.expectedClaudeCli ? `기대 Claude Code: ${report.expectedClaudeCli}` : "",
    ...lines,
  ].filter(Boolean).join("\n");
}
