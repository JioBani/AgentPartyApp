import type { WorkspaceDisplay } from "./types";

/**
 * Everything a bug report needs about the machine it came from: which build the
 * user is on, what it runs on, and where its log file is.
 *
 * Shared (not renderer-local) because the settings screen and
 * `GET /api/diagnostics` hand out the SAME report, and
 * {@link formatDiagnosticsReport} is the one text both the copy button and an
 * agent filing an issue produce — so a pasted report always reads the same.
 *
 * Deliberately free of secrets: auth appears as id/label/status only, never a
 * key, a masked key, or a token. This text is meant to be pasted in public.
 */
export interface DiagnosticsReport {
  /** App version (`package.json` `version`), or `""` with {@link versionError}. */
  version: string;
  /**
   * Why {@link version} is empty, when it is. A blank version silently reads as
   * "unknown build" to whoever triages the report — the exact thing this screen
   * exists to prevent — so the reason travels WITH the gap instead of the field
   * quietly going missing.
   */
  versionError?: string;
  /** Installed build vs. an unpackaged dev run. The two fail differently. */
  packaged: boolean;
  /** Where the RUNNING code was loaded from (see `InitialAppState.runtime`). */
  appRoot: string;
  os: { platform: string; release: string; arch: string };
  /** Host runtime versions. `electron`/`chrome` are absent off the desktop. */
  versions: { node: string; electron?: string; chrome?: string };
  /** The reporting window's workspace — `kind: "wsl"` is the WSL answer. */
  workspace: WorkspaceDisplay;
  logs: { filePath: string; folderPath: string };
  auth: Array<{ id: string; label: string; status: string }>;
}

/** `WSL(Ubuntu)` / `Windows` — the platform line a report is triaged by. */
function workspaceLabel(workspace: WorkspaceDisplay): string {
  return workspace.kind === "wsl" ? `WSL(${workspace.distro || "?"})` : "로컬";
}

/**
 * The report as pasteable plain text. Kept to one short block per fact so it
 * survives being dropped into a chat message, an issue body, or a Discord post
 * without reformatting.
 */
export function formatDiagnosticsReport(report: DiagnosticsReport): string {
  const version = report.version
    ? `v${report.version}`
    : `버전 불명 (${report.versionError || "원인 미상"})`;
  const runtime = [
    report.versions.electron ? `Electron ${report.versions.electron}` : "",
    `Node ${report.versions.node}`,
    report.versions.chrome ? `Chrome ${report.versions.chrome}` : "",
  ].filter(Boolean).join(" / ");
  const auth = report.auth.length
    ? report.auth.map((provider) => `${provider.label}=${provider.status}`).join(", ")
    : "없음";
  return [
    `AgentParty ${version}${report.packaged ? "" : " (개발 빌드)"}`,
    `OS: ${report.os.platform} ${report.os.release} (${report.os.arch})`,
    `런타임: ${runtime}`,
    `작업공간: ${workspaceLabel(report.workspace)} — ${report.workspace.path}`,
    `앱 경로: ${report.appRoot}`,
    `로그: ${report.logs.filePath}`,
    `인증: ${auth}`,
  ].join("\n");
}
