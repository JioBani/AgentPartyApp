import * as fs from "node:fs";
import * as path from "node:path";
import { getUserDataDir } from "./userDataDir";
import { AppSettings, HarnessDefaults, HarnessId, HARNESS_IDS } from "../shared/types";
import { DEFAULT_CODEX_POLICY } from "../shared/codexPolicy";
import { DEFAULT_CURSOR_POLICY, cursorPolicyOf } from "../shared/cursorPolicy";
import { DEFAULT_AUTO_COMPACT, normalizeAutoCompact } from "../shared/autoCompact";
import { DEFAULT_IDLE_SLEEP, sanitizeIdleSleep } from "../shared/idleSleep";
import { DEEPSEEK_API_KEY_ENV } from "../shared/deepseekDefaults";
import { catalogModelById, catalogModelByRuntime } from "../shared/modelCatalog";
import { normalizeGateReviewer, type GateReviewer } from "../shared/messageGate";
import { DEFAULT_DISCORD_SETTINGS, normalizeDiscordSettings } from "../shared/discordBridge";
import { DEFAULT_COMPOSER_SETTINGS, normalizeComposerSettings } from "../shared/composerSettings";
import { DEFAULT_FONT_SETTINGS, normalizeFontSettings } from "../shared/appFonts";
import { DEFAULT_FAVORITE_MODELS, normalizeFavoriteModels } from "../shared/favoriteModels";
import { DEFAULT_MEMBER_MESSAGING_SETTINGS, normalizeMemberMessagingSettings } from "../shared/memberMessaging";
import { MOBILE_SETTINGS_DEFAULTS, type MobileSettings } from "../shared/mobileProtocol";
import { normalizePartyPrimerSettings } from "../shared/partyPrimer";
import { DEFAULT_UPDATE_CHANNEL, normalizeUpdateChannel } from "../shared/appUpdate";
import { DEFAULT_APP_LOCALE, normalizeAppLocale } from "../shared/appLocale";
import { DEFAULT_SIDEBAR_DRAWERS, normalizeSidebarDrawers } from "../shared/sidebarDrawers";

/**
 * Built-in Message Gate reviewer default. Headless (no harness), and low effort
 * because the gate can run on every member-to-member message.
 *
 * Chosen on measurement, not price: over 114 live reviews (including Korean
 * carrying English identifiers, code blocks and file paths — the shapes real
 * dev messages take) GPT-5.6 Terra made no misjudgement, while haiku scored
 * ~97% and Luna repeatedly rejected plainly-Korean messages as "not Korean".
 * Terra was also faster (2.4s vs 3.0s median).
 *
 * This model needs the Codex subscription. If it is not connected the review
 * fails and the gate falls open — which is why that failure is reported on the
 * send result and as a transcript badge rather than passing for success, and
 * why the reviewer is user-configurable in Settings → Runtime.
 */
export const DEFAULT_GATE_REVIEWER: GateReviewer = { model: "GPT-5.6 Terra", effort: "low" };

const HARNESS_DEFAULTS: Record<HarnessId, HarnessDefaults> = {
  "claude-code": { model: "sonnet", effort: "medium", permissionMode: "default" },
  // A catalog codexModel slug (codexRouteFromCatalog), so the default is
  // selectable even before live model/list discovery lands.
  codex: { model: "gpt-5.4", effort: "medium", codexPolicy: { ...DEFAULT_CODEX_POLICY } },
  cursor: { model: "Grok 4.5", effort: "high", serviceTier: "standard", cursorPolicy: { ...DEFAULT_CURSOR_POLICY } },
  // Grok Build defaults to 4.6/high. Effort is applied when its ACP process
  // starts. Grok owns only normal/plan modes; its adapter enforces finer permission
  // choices when ACP session/request_permission requests arrive.
  grok: { model: "grok-4.6", effort: "high", permissionMode: "default" },
};

const defaults: AppSettings = {
  locale: DEFAULT_APP_LOCALE,
  workspacePath: process.cwd(),
  updateChannel: DEFAULT_UPDATE_CHANNEL,
  claudeExecutablePath: "",
  cursorExecutablePath: "",
  claudeSafeMode: false,
  selectedHarnessId: "claude-code",
  harnessDefaults: HARNESS_DEFAULTS,
  debugEnabled: false,
  // Ports are RUNTIME, not canonical: bind ephemeral (0) by default so multiple
  // processes never collide on a fixed port, and advertise the live bound URL via
  // per-workspace discovery. A dev/QA run can still pin a port via env. (An empty
  // routerBaseUrl → preferredPort 0; consumers read the live `router.baseUrl`.)
  routerBaseUrl: "",
  routerAuthToken: "dummy",
  openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
  deepseekApiKey: process.env[DEEPSEEK_API_KEY_ENV] || "",
  automationApiPort: Number(process.env.AGENTPARTY_AUTOMATION_PORT || "") || 0,
  transcriptFontScale: 1,
  sidebarDrawers: { party: { ...DEFAULT_SIDEBAR_DRAWERS.party }, member: { ...DEFAULT_SIDEBAR_DRAWERS.member } },
  fonts: { ...DEFAULT_FONT_SETTINGS },
  compactDefault: { ...DEFAULT_AUTO_COMPACT },
  idleSleep: { ...DEFAULT_IDLE_SLEEP },
  gateDefaults: { ...DEFAULT_GATE_REVIEWER },
  composer: { ...DEFAULT_COMPOSER_SETTINGS },
  memberMessaging: { ...DEFAULT_MEMBER_MESSAGING_SETTINGS },
  favoriteModels: [...DEFAULT_FAVORITE_MODELS],
  discord: { ...DEFAULT_DISCORD_SETTINGS },
  mobile: { ...MOBILE_SETTINGS_DEFAULTS },
};

/**
 * Shape-only normalization for the mobile link's settings. The URLs are not
 * validated here: an unreachable signaling server must fail visibly in the
 * 모바일 연결 screen's status, not be silently replaced by the default.
 */
function normalizeMobileSettings(value: Partial<MobileSettings> | undefined): MobileSettings {
  return {
    enabled: value?.enabled === true,
    signalingUrl: typeof value?.signalingUrl === "string" && value.signalingUrl ? value.signalingUrl : MOBILE_SETTINGS_DEFAULTS.signalingUrl,
    pushUrl: typeof value?.pushUrl === "string" && value.pushUrl ? value.pushUrl : MOBILE_SETTINGS_DEFAULTS.pushUrl,
    deviceName: typeof value?.deviceName === "string" ? value.deviceName : MOBILE_SETTINGS_DEFAULTS.deviceName,
    natMappingEnabled: value?.natMappingEnabled !== false,
  };
}

/** Transcript zoom bounds — keep in sync with the renderer's Ctrl+wheel step. */
export const TRANSCRIPT_FONT_SCALE_MIN = 0.6;
export const TRANSCRIPT_FONT_SCALE_MAX = 2.0;

/** Clamps an arbitrary stored/HTTP value to a sane zoom, defaulting to 1. */
function clampFontScale(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return 1;
  }
  return Math.min(TRANSCRIPT_FONT_SCALE_MAX, Math.max(TRANSCRIPT_FONT_SCALE_MIN, n));
}

export function getSettings(): AppSettings {
  const stored = migrateSettings(readSettingsFile());
  return sanitizeSettings({
    ...defaults,
    ...stored,
    // Merge per-harness defaults so a partial stored map keeps unset harnesses.
    harnessDefaults: mergeHarnessDefaults(stored.harnessDefaults),
  });
}

/**
 * Migrates a legacy settings.json (flat `claudeModel`/`claudeEffort`/
 * `claudePermissionMode`/… fields, pre per-harness defaults) into the
 * `harnessDefaults["claude-code"]` shape, so upgrading users keep their prior
 * default. Idempotent — a settings file already on the new shape is untouched.
 */
export function migrateSettings(stored: Record<string, any>): Partial<AppSettings> {
  if (!stored || stored.harnessDefaults || !("claudeModel" in stored)) {
    return stored as Partial<AppSettings>;
  }
  const { claudeModel, claudeEffort, claudeReasoning, claudeReasoningBudget, claudePermissionMode, selectedProviderId, ...rest } = stored;
  return {
    ...(rest as Partial<AppSettings>),
    harnessDefaults: {
      "claude-code": {
        model: claudeModel || HARNESS_DEFAULTS["claude-code"].model,
        effort: claudeEffort || HARNESS_DEFAULTS["claude-code"].effort,
        reasoning: claudeReasoning,
        reasoningBudget: claudeReasoningBudget,
        permissionMode: claudePermissionMode || HARNESS_DEFAULTS["claude-code"].permissionMode,
      },
      codex: { ...HARNESS_DEFAULTS.codex },
      cursor: { ...HARNESS_DEFAULTS.cursor },
      grok: { ...HARNESS_DEFAULTS.grok },
    },
  };
}

/** Fills any harness missing from a stored map with the built-in default. */
function mergeHarnessDefaults(stored: Partial<Record<HarnessId, HarnessDefaults>> | undefined): Record<HarnessId, HarnessDefaults> {
  const merged = {} as Record<HarnessId, HarnessDefaults>;
  for (const id of HARNESS_IDS) {
    merged[id] = { ...HARNESS_DEFAULTS[id], ...(stored?.[id] || {}) };
  }
  merged.cursor = {
    ...merged.cursor,
    cursorPolicy: cursorPolicyOf(merged.cursor.cursorPolicy, merged.cursor.permissionMode),
    permissionMode: undefined,
  };
  return merged;
}

/**
 * Heals a per-harness default model that no longer resolves to a catalog model —
 * e.g. a value selected before the catalog was reworked (the legacy "GLM-5.2
 * (OpenRouter)" id). Left untouched it injects an unroutable "current model"
 * fallback route (modelRegistry) that then becomes selectable and only fails at
 * session start. Reset that harness's model to its built-in default.
 */
/**
 * Validates the Message Gate reviewer default, healing an unroutable model back
 * to the built-in (mirrors the per-harness model heal above) so a stale value
 * can never point the gate at a model the catalog no longer knows.
 */
function normalizeGateDefaults(value: unknown): GateReviewer {
  const reviewer = normalizeGateReviewer(value) || { ...DEFAULT_GATE_REVIEWER };
  if (!catalogModelById(reviewer.model) && !catalogModelByRuntime(reviewer.model)) {
    return { ...reviewer, model: DEFAULT_GATE_REVIEWER.model };
  }
  return reviewer;
}

function sanitizeSettings(settings: AppSettings): AppSettings {
  const envAutomationPort = Number(process.env.AGENTPARTY_AUTOMATION_PORT || "");
  const withRuntimeOverrides = envAutomationPort > 0 ? { ...settings, automationApiPort: envAutomationPort } : settings;
  const harnessDefaults = { ...withRuntimeOverrides.harnessDefaults };
  for (const id of HARNESS_IDS) {
    const model = harnessDefaults[id]?.model;
    if (model && !catalogModelById(model) && !catalogModelByRuntime(model)) {
      harnessDefaults[id] = { ...harnessDefaults[id], model: HARNESS_DEFAULTS[id].model };
    }
  }
  const compactDefault = normalizeAutoCompact(withRuntimeOverrides.compactDefault) || { ...DEFAULT_AUTO_COMPACT };
  const gateDefaults = normalizeGateDefaults(withRuntimeOverrides.gateDefaults);
  const discord = normalizeDiscordSettings(withRuntimeOverrides.discord || DEFAULT_DISCORD_SETTINGS);
  const composer = normalizeComposerSettings(withRuntimeOverrides.composer);
  const memberMessaging = normalizeMemberMessagingSettings(withRuntimeOverrides.memberMessaging);
  // Shape-only: unlike `harnessDefaults` above, an id the catalog cannot resolve
  // is NOT dropped here. A harness default must name a usable model to boot a
  // member, but a favourite is only a display preference — and "gone for good"
  // and "absent right now" (credential removed, remote provider list failed to
  // load) look identical at this point. Pruning would silently and permanently
  // delete the user's choice in the second case. The catalog resolves the list
  // when it renders, so an unknown id draws nothing and returns on its own.
  const favoriteModels = normalizeFavoriteModels(withRuntimeOverrides.favoriteModels);
  const idleSleep = sanitizeIdleSleep(withRuntimeOverrides.idleSleep);
  const fonts = normalizeFontSettings(withRuntimeOverrides.fonts);
  const mobile = normalizeMobileSettings(withRuntimeOverrides.mobile);
  const updateChannel = normalizeUpdateChannel(withRuntimeOverrides.updateChannel);
  // Drops overrides for sections the app no longer has, and no-op entries (text
  // identical to the built-in), so a stale file cannot make a member session
  // start with a prompt the settings screen would not show.
  const partyPrimer = normalizePartyPrimerSettings(withRuntimeOverrides.partyPrimer);
  const sidebarDrawers = normalizeSidebarDrawers(withRuntimeOverrides.sidebarDrawers);
  return { ...withRuntimeOverrides, locale: normalizeAppLocale(withRuntimeOverrides.locale), updateChannel, harnessDefaults, compactDefault, idleSleep, gateDefaults, composer, memberMessaging, favoriteModels, discord, fonts, mobile, partyPrimer, sidebarDrawers, transcriptFontScale: clampFontScale(withRuntimeOverrides.transcriptFontScale) };
}

export function getPublicSettings(): AppSettings {
  const settings = getSettings();
  return {
    ...settings,
    openRouterApiKey: settings.openRouterApiKey ? maskSecret(settings.openRouterApiKey) || "" : "",
    deepseekApiKey: settings.deepseekApiKey ? maskSecret(settings.deepseekApiKey) || "" : "",
    routerAuthToken: settings.routerAuthToken ? "[redacted]" : "",
    // The bot token is a bot credential — never leaves the main process in clear.
    discord: { ...settings.discord!, botToken: settings.discord?.botToken ? maskSecret(settings.discord.botToken) || "" : "" },
  };
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // settings.json is ONE file shared by every process/workspace. An atomic
  // temp+rename stops a torn read, but not a lost update: if A and B each
  // read → merge a different patch → write, the later writer silently drops the
  // earlier's change. Serialize the whole read-modify-write behind a cross-
  // process lock, and re-read INSIDE it so the patch merges onto the freshest
  // on-disk values.
  return withSettingsLock(file, () => {
    const next = { ...getSettings(), ...patch };
    // Per-process temp name: two writers must never collide on one temp file.
    const tempPath = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tempPath, file);
    return next;
  });
}

/**
 * Runs `fn` while holding an exclusive lockfile next to `file`, serializing the
 * settings read-modify-write across processes. Uses `open(..., "wx")` (atomic
 * exclusive create) as the mutex; spins with a real synchronous sleep until the
 * lock frees or a short deadline passes. A lock older than {@link LOCK_STALE_MS}
 * is treated as abandoned (a crashed holder) and stolen, so a dead process can
 * never wedge every future write. Best-effort: on timeout it proceeds anyway
 * (a rare lost update beats blocking the UI), and the lock is always released.
 */
function withSettingsLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = nowMs() + LOCK_WAIT_MS;
  let held = false;
  while (!held) {
    try {
      fs.closeSync(fs.openSync(lock, "wx"));
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        break; // unexpected fs error — don't block the write on locking
      }
      if (lockAgeMs(lock) > LOCK_STALE_MS) {
        try { fs.rmSync(lock, { force: true }); } catch { /* raced with another stealer */ }
        continue;
      }
      if (nowMs() >= deadline) {
        break; // give up waiting; proceed best-effort rather than hang the UI
      }
      sleepMs(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try { fs.rmSync(lock, { force: true }); } catch { /* already gone */ }
    }
  }
}

function lockAgeMs(lock: string): number {
  try {
    return nowMs() - fs.statSync(lock).mtimeMs;
  } catch {
    return 0; // vanished under us — treat as fresh, next open() will settle it
  }
}

function nowMs(): number {
  return Date.now();
}

/** Blocks the calling thread for `ms` without a busy-loop (main-process writes are rare). */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 10_000;

export function maskSecret(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.length <= 8 ? "********" : `${"*".repeat(8)}${value.slice(-4)}`;
}

function readSettingsFile(): Partial<AppSettings> {
  try {
    const file = settingsPath();
    if (!fs.existsSync(file)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function settingsPath(): string {
  return path.join(getUserDataDir(), "settings.json");
}
