/**
 * Update telemetry — the wire contract shared with the AgentPartyTelemetry
 * server (C:\Project\AgentParty\AgentPartyTelemetry, `functions/src/schema.ts`
 * mirrors this). One event per update step, sent fire-and-forget; the updater
 * itself never waits on it and never learns whether it arrived.
 *
 * What is sent is anonymous by construction: a random per-install id, versions,
 * channel, OS family and arch. No user name, path, IP, or work content — the
 * server also drops the caller's IP before storing.
 */

/** The deployed collector. `AGENTPARTY_TELEMETRY_URL` overrides it (QA, dev). */
export const TELEMETRY_ENDPOINT = "https://asia-northeast3-agentparty-telemetry.cloudfunctions.net/collect";

export const TELEMETRY_SCHEMA_VERSION = 1;

export type AppTelemetryEvent =
  /** First launch of any build on this machine. */
  | "first_run"
  /** First launch after the installed version changed (from → to). */
  | "update_installed"
  /** A check finished and found nothing newer. */
  | "update_check"
  /** A check found a version to offer. */
  | "update_available"
  | "update_download_start"
  | "update_downloaded"
  /** A check or download failed. Only the stage is sent, never the message. */
  | "update_error";

export interface AppTelemetryPayload {
  v: typeof TELEMETRY_SCHEMA_VERSION;
  source: "app";
  event: AppTelemetryEvent;
  installId: string;
  appVersion: string;
  channel: "stable" | "beta";
  os: string;
  arch: string;
  fromVersion?: string;
  toVersion?: string;
  downgrade?: boolean;
  /** For update_error: the state the updater was in when it failed. */
  stage?: string;
  ts: string;
}

/** What `GET /api/telemetry` reports — for QA, and for a user who asks. */
export interface TelemetryStatus {
  enabled: boolean;
  /** Why nothing is sent, when `enabled` is false. */
  disabledReason?: string;
  endpoint?: string;
  installId: string;
  recent: Array<{ event: AppTelemetryEvent; at: string; result: "sent" | "failed" | "skipped"; detail?: string }>;
}
