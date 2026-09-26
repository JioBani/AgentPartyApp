/**
 * Update telemetry: tells the AgentPartyTelemetry collector how installs move
 * through updates (checked → offered → downloaded → installed).
 *
 * It only LISTENS to the update service's status pushes; the update flow does
 * not know it exists, so a slow or dead collector can never hold an update back.
 * Each event is one POST with a short timeout; a failure is logged and dropped —
 * no retry, no queue, nothing shown to the user.
 *
 * Unpackaged (dev / QA) builds send nothing unless AGENTPARTY_TELEMETRY_URL is
 * set, so test runs never pollute real numbers.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EventEmitter } from "node:events";
import type { UpdateChannel, UpdateState, UpdateStatus } from "../shared/appUpdate";
import {
  TELEMETRY_ENDPOINT,
  TELEMETRY_SCHEMA_VERSION,
  type AppTelemetryEvent,
  type AppTelemetryPayload,
  type TelemetryStatus,
} from "../shared/updateTelemetry";

const SEND_TIMEOUT_MS = 3000;
const RECENT_LIMIT = 20;

export interface UpdateTelemetryDeps {
  userDataDir: string;
  appVersion: string;
  isPackaged: boolean;
  channel: () => UpdateChannel;
  log: (level: "info" | "warn", message: string, data?: unknown) => void;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

interface Stored {
  installId: string;
  lastVersion?: string;
  /** UTC day (YYYY-MM-DD) of the last update_check sent — one per day is enough to count actives. */
  lastCheckDay?: string;
}

/** Which status transitions are worth an event, and what they carry. */
function eventFor(prev: UpdateState | undefined, next: UpdateStatus): Pick<AppTelemetryPayload, "event" | "toVersion" | "downgrade" | "stage"> | null {
  if (prev === next.state) return null;
  switch (next.state) {
    case "up-to-date": return { event: "update_check" };
    case "available": return { event: "update_available", toVersion: next.latestVersion, downgrade: Boolean(next.downgrade) };
    case "downloading": return { event: "update_download_start", toVersion: next.latestVersion };
    case "downloaded": return { event: "update_downloaded", toVersion: next.latestVersion };
    case "error": return { event: "update_error", stage: prev || "unknown" };
    default: return null;
  }
}

export class UpdateTelemetry {
  private readonly file: string;
  private readonly stored: Stored;
  private readonly endpoint: string | undefined;
  private readonly disabledReason: string | undefined;
  private readonly recent: TelemetryStatus["recent"] = [];
  private lastState: UpdateState | undefined;

  constructor(private readonly deps: UpdateTelemetryDeps) {
    this.file = path.join(deps.userDataDir, "telemetry.json");
    const { stored, fresh } = this.load();
    this.stored = stored;
    if (fresh) this.save();
    const override = (deps.env ?? process.env).AGENTPARTY_TELEMETRY_URL?.trim();
    if (override) this.endpoint = override;
    else if (deps.isPackaged) this.endpoint = TELEMETRY_ENDPOINT;
    else this.disabledReason = "개발 빌드 — AGENTPARTY_TELEMETRY_URL 을 지정해야 보냅니다";
  }

  /** Records this launch (first run / version change) and starts following the updater. */
  start(updater: EventEmitter): void {
    const previous = this.stored.lastVersion;
    if (previous !== this.deps.appVersion) {
      this.send(previous ? { event: "update_installed", fromVersion: previous, toVersion: this.deps.appVersion } : { event: "first_run" });
      this.stored.lastVersion = this.deps.appVersion;
      this.save();
    }
    updater.on("status", (status: UpdateStatus) => {
      const event = eventFor(this.lastState, status);
      this.lastState = status.state;
      if (!event) return;
      // Checks repeat every few hours; one a day per install keeps the collector
      // inside its free quota and still counts daily actives.
      if (event.event === "update_check") {
        const day = new Date().toISOString().slice(0, 10);
        if (this.stored.lastCheckDay === day) return;
        this.stored.lastCheckDay = day;
        this.save();
      }
      this.send(event);
    });
  }

  status(): TelemetryStatus {
    return {
      enabled: Boolean(this.endpoint),
      ...(this.disabledReason ? { disabledReason: this.disabledReason } : {}),
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
      installId: this.stored.installId,
      recent: [...this.recent],
    };
  }

  private send(fields: Pick<AppTelemetryPayload, "event"> & Partial<AppTelemetryPayload>): void {
    const payload: AppTelemetryPayload = {
      v: TELEMETRY_SCHEMA_VERSION,
      source: "app",
      installId: this.stored.installId,
      appVersion: this.deps.appVersion,
      channel: this.deps.channel(),
      os: process.platform,
      arch: process.arch,
      ts: new Date().toISOString(),
      ...fields,
    };
    if (!this.endpoint) {
      this.remember(payload.event, "skipped", this.disabledReason);
      return;
    }
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    void fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    }).then(
      (res) => {
        if (res.ok) this.remember(payload.event, "sent");
        else this.fail(payload.event, `HTTP ${res.status}`);
      },
      (error: unknown) => this.fail(payload.event, error instanceof Error ? error.message : String(error)),
    );
  }

  private fail(event: AppTelemetryEvent, detail: string): void {
    this.remember(event, "failed", detail);
    // Visible in the app log, never in the UI: the collector being down is not the user's problem.
    this.deps.log("warn", "update telemetry not delivered", { event, detail });
  }

  private remember(event: AppTelemetryEvent, result: "sent" | "failed" | "skipped", detail?: string): void {
    this.recent.unshift({ event, at: new Date().toISOString(), result, ...(detail ? { detail } : {}) });
    this.recent.length = Math.min(this.recent.length, RECENT_LIMIT);
  }

  private load(): { stored: Stored; fresh: boolean } {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Stored>;
      if (typeof data.installId === "string" && data.installId) {
        return {
          stored: {
            installId: data.installId,
            ...(typeof data.lastVersion === "string" ? { lastVersion: data.lastVersion } : {}),
            ...(typeof data.lastCheckDay === "string" ? { lastCheckDay: data.lastCheckDay } : {}),
          },
          fresh: false,
        };
      }
    } catch {
      // First launch, or an unreadable file: start a new id (save() logs if the disk refuses).
    }
    return { stored: { installId: randomUUID() }, fresh: true };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.stored, null, 2));
    } catch (error) {
      this.deps.log("warn", "update telemetry state not saved", { file: this.file, error: String(error) });
    }
  }
}
