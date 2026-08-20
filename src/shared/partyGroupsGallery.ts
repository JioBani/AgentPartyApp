/**
 * Fixtures for the party-group + member-cwd screens.
 *
 * These reproduce the claude.ai/design mockup's data exactly — the same nine
 * parties in the same three groups, the same recent cwds including the broken
 * ones — so a screenshot of the app's components can be laid next to the
 * mockup's and the difference read as a difference in the UI rather than in the
 * content.
 *
 * `GALLERY_NOW` is frozen for the same reason. "2일 전" computed against the
 * real clock changes every night, and a preview whose text drifts on its own
 * cannot be used to catch a regression.
 *
 * Not test-only: the design preview page (`src/renderer/preview/`) is the way
 * these screens are reviewed WITHOUT creating members or mounting a WSL distro,
 * which is what makes the design reviewable at all.
 */

import { cwdProblem, type CwdPreferences, type MemberExecutionLocation, type MemberLocationRow } from "./memberLocation";
import { DEFAULT_PARTY_GROUP_ID, type PartyGroup, type PartySummary } from "./partyGroups";

/** 2026-08-20 12:00 KST — the instant every relative label below is measured from. */
export const GALLERY_NOW = Date.parse("2026-08-20T03:00:00.000Z");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(GALLERY_NOW - ms).toISOString();

export const GALLERY_GROUPS: PartyGroup[] = [
  { id: DEFAULT_PARTY_GROUP_ID, name: "기본 그룹", kind: "default", createdAt: ago(60 * DAY), updatedAt: ago(DAY) },
  { id: "g-payments", name: "결제 리팩터", kind: "user", createdAt: ago(30 * DAY), updatedAt: ago(DAY) },
  { id: "g-lab", name: "실험", kind: "user", createdAt: ago(20 * DAY), updatedAt: ago(3 * DAY) },
];

export const GALLERY_PARTIES: PartySummary[] = [
  { id: "p-agentparty", groupId: DEFAULT_PARTY_GROUP_ID, name: "AgentParty", memberCount: 9, runningCount: 2, windowsCount: 6, wslCount: 3, updatedAt: ago(60_000) },
  { id: "p-docs", groupId: DEFAULT_PARTY_GROUP_ID, name: "docs-cleanup", memberCount: 2, runningCount: 0, windowsCount: 0, wslCount: 0, updatedAt: ago(3 * DAY) },
  { id: "p-pay-api", groupId: "g-payments", name: "pay-api", memberCount: 4, runningCount: 1, windowsCount: 2, wslCount: 2, updatedAt: ago(2 * 60_000) },
  { id: "p-pay-worker", groupId: "g-payments", name: "pay-worker", memberCount: 2, runningCount: 0, windowsCount: 0, wslCount: 2, updatedAt: ago(30 * HOUR) },
  { id: "p-spike", groupId: "g-payments", name: "spike-idempotency", memberCount: 1, runningCount: 0, windowsCount: 1, wslCount: 0, updatedAt: ago(5 * DAY) },
  { id: "p-wsl-perf", groupId: "g-lab", name: "wsl-perf", memberCount: 2, runningCount: 0, windowsCount: 0, wslCount: 2, updatedAt: ago(30 * HOUR) },
  { id: "p-harness", groupId: "g-lab", name: "harness-codex", memberCount: 1, runningCount: 0, windowsCount: 1, wslCount: 0, updatedAt: ago(3 * DAY) },
  { id: "p-mcp", groupId: "g-lab", name: "mcp-sandbox", memberCount: 1, runningCount: 0, windowsCount: 1, wslCount: 0, updatedAt: ago(6 * DAY) },
  { id: "p-archive", groupId: "g-lab", name: "archive-2025", memberCount: 3, runningCount: 0, windowsCount: 0, wslCount: 0, updatedAt: ago(14 * DAY) },
];

export const GALLERY_WINDOWS_DEFAULT: MemberExecutionLocation = { env: "windows", cwd: "C:\\Project\\DesktopApp" };
export const GALLERY_WSL_DEFAULT: MemberExecutionLocation = { env: "wsl", cwd: "/home/dev/service", distro: "Ubuntu-24.04" };

export const GALLERY_CWD_PREFERENCES: CwdPreferences = {
  windowsDefault: GALLERY_WINDOWS_DEFAULT,
  wslDefault: GALLERY_WSL_DEFAULT,
  windowsRecent: [
    { location: GALLERY_WINDOWS_DEFAULT, usedAt: ago(60_000) },
    { location: { env: "windows", cwd: "C:\\Project\\payments-web" }, usedAt: ago(30 * HOUR) },
    { location: { env: "windows", cwd: "C:\\Users\\Dev\\sandbox\\proto" }, usedAt: ago(4 * DAY) },
    { location: { env: "windows", cwd: "D:\\work\\spike" }, usedAt: ago(9 * DAY), problem: cwdProblem("missing") },
  ],
  wslRecent: [
    { location: GALLERY_WSL_DEFAULT, usedAt: ago(60_000) },
    { location: { env: "wsl", cwd: "/home/dev/agentparty/api", distro: "Ubuntu-24.04" }, usedAt: ago(3 * HOUR) },
    { location: { env: "wsl", cwd: "/mnt/d/work/payments", distro: "Ubuntu-24.04" }, usedAt: ago(2 * DAY + 2 * HOUR) },
    { location: { env: "wsl", cwd: "/home/dev/legacy", distro: "Ubuntu-22.04" }, usedAt: ago(11 * DAY), problem: cwdProblem("distro-unavailable") },
  ],
};

/** The distros the picker offers in the preview. */
export const GALLERY_WSL_DISTROS = ["Ubuntu-24.04", "Ubuntu-22.04", "docker-desktop"];

/** Stands in for `<userData>/workspaces` in the preview. */
export const GALLERY_APP_WORKSPACE_ROOT = "C:\Users\Dev\AppData\Roaming\AgentParty\workspaces";

/** The empty state: a fresh install has no default and nothing remembered. */
export const GALLERY_CWD_PREFERENCES_EMPTY: CwdPreferences = { windowsRecent: [], wslRecent: [] };

export const GALLERY_MEMBER_LOCATIONS: MemberLocationRow[] = [
  { member: "main", partyName: "AgentParty", location: GALLERY_WINDOWS_DEFAULT },
  { member: "impl", partyName: "AgentParty", location: GALLERY_WSL_DEFAULT },
];

/** How many members sit on each environment's default cwd, for the settings meta. */
export const GALLERY_DEFAULT_USAGE = { windows: 12, wsl: 5 } as const;

/**
 * Just enough of a model catalog for the member wizard to render.
 *
 * One route, with the reasoning axes the design's summary line shows
 * ("effort medium · thinking adaptive"). Deliberately minimal: the preview is
 * reviewing the WIZARD's layout, and a realistic catalog would only add ways
 * for the fixture to drift from the shipping one.
 */
export const GALLERY_ROUTE = {
  harnessId: "claude-code",
  providerId: "anthropic",
  model: "claude-sonnet-4-6",
  label: "Sonnet 4.6",
  enabled: true,
  capabilities: {
    effort: { supported: true, defaultValue: "medium", options: [{ id: "low", label: "low" }, { id: "medium", label: "medium" }, { id: "high", label: "high" }] },
    thinking: { supported: true, defaultValue: "adaptive", modes: [{ id: "adaptive", label: "adaptive" }, { id: "enabled", label: "enabled" }] },
  },
};

export const GALLERY_MEMBER_PROFILE = {
  harness: "claude-code" as const,
  model: "claude-sonnet-4-6",
  effort: "medium",
  reasoning: "adaptive",
};
