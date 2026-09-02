/**
 * Remote model catalog loader — decouples catalog delivery from app releases.
 *
 * The published catalog lives in the (public) release repo the auto-updater
 * already talks to; the developer ships an update with `npm run catalog:publish`
 * (one commit, no app build). Load order and fallback:
 *
 *   remote fetch (validated) → disk cache (last good remote) → bundled JSON
 *
 * Every fallback is VISIBLE: fetch/validation failures are logged and carried
 * in the status the automation API serves (`GET /api/models/catalog`), never
 * silently swallowed. A payload that fails validation — including one with a
 * schemaVersion this build does not understand — is rejected whole; routing is
 * never built from a half-parsed catalog.
 *
 * Design doc: docs/기획 노트 — 원격 모델 카탈로그.md
 */
import fs from "node:fs";
import path from "node:path";
import { applyModelCatalog, validateModelCatalogPayload } from "../shared/modelCatalog";
import { getUserDataDir } from "./userDataDir";
import { log } from "./logger";

export const REMOTE_CATALOG_URL = "https://raw.githubusercontent.com/JioBani/AgentParty-releases/main/modelCatalog.json";
/** raw.githubusercontent CDN caches ~5 min; 6h polling is plenty for a catalog. */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_FILE = "modelCatalog.remote.json";

/** Where the currently applied catalog came from, plus the last fetch outcome. */
export interface RemoteCatalogStatus {
  /** bundled = release-time snapshot; cache = last good remote from disk; remote = live fetch this run. */
  source: "bundled" | "cache" | "remote";
  url: string;
  modelCount: number;
  /** When the applied catalog was originally fetched from the remote (absent for bundled). */
  fetchedAt?: string;
  /** When the last remote fetch attempt finished (success or failure). */
  lastCheckedAt?: string;
  /** Why the newest fetch/cache load was not applied. Cleared on success. */
  lastError?: string;
}

interface CacheEnvelope {
  fetchedAt: string;
  url: string;
  payload: unknown;
}

let status: RemoteCatalogStatus = { source: "bundled", url: REMOTE_CATALOG_URL, modelCount: 0 };
let appliedJson = "";
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let onCatalogApplied: (() => void) | undefined;
let inflight: Promise<RemoteCatalogStatus> | undefined;

export function remoteModelCatalogStatus(): RemoteCatalogStatus {
  return { ...status };
}

/**
 * Loads the cached remote catalog synchronously (so the first window already
 * sees it), then starts the periodic remote refresh. `onApplied` fires whenever
 * a DIFFERENT catalog is applied — the caller pushes rebuilt model routes to
 * open windows there.
 */
export function startRemoteModelCatalog(onApplied: () => void): void {
  onCatalogApplied = onApplied;
  loadCacheSync();
  void refreshRemoteModelCatalog();
  refreshTimer ??= setInterval(() => {
    void refreshRemoteModelCatalog();
  }, REFRESH_INTERVAL_MS);
  // A timer must never keep the app process alive on quit.
  refreshTimer.unref?.();
}

export function stopRemoteModelCatalog(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

/**
 * Fetches, validates and applies the published catalog now. Shared by startup,
 * the interval, and the automation API's force-refresh; concurrent calls join
 * the in-flight attempt. Failures keep the currently applied catalog and are
 * recorded in {@link remoteModelCatalogStatus}.
 */
export function refreshRemoteModelCatalog(): Promise<RemoteCatalogStatus> {
  inflight ??= doRefresh().finally(() => {
    inflight = undefined;
  });
  return inflight;
}

async function doRefresh(): Promise<RemoteCatalogStatus> {
  try {
    const response = await fetch(REMOTE_CATALOG_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    const { models } = validateModelCatalogPayload(payload);
    const fetchedAt = new Date().toISOString();
    const changed = apply(models, { source: "remote", fetchedAt });
    saveCache({ fetchedAt, url: REMOTE_CATALOG_URL, payload });
    if (changed) {
      log("info", "model-catalog", "remote catalog applied", { models: models.length, fetchedAt });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    status = { ...status, lastCheckedAt: new Date().toISOString(), lastError: reason };
    log("warn", "model-catalog", "remote catalog fetch failed; keeping current catalog", {
      url: REMOTE_CATALOG_URL,
      source: status.source,
      reason,
    });
  }
  return remoteModelCatalogStatus();
}

/** Applies validated models and updates status. Returns whether anything changed. */
function apply(models: unknown[], next: { source: "cache" | "remote"; fetchedAt?: string }): boolean {
  const json = JSON.stringify(models);
  const changed = json !== appliedJson;
  if (changed) {
    appliedJson = json;
    applyModelCatalog(models as Parameters<typeof applyModelCatalog>[0]);
  }
  status = {
    source: next.source,
    url: REMOTE_CATALOG_URL,
    modelCount: models.length,
    fetchedAt: next.fetchedAt,
    lastCheckedAt: next.source === "remote" ? new Date().toISOString() : status.lastCheckedAt,
  };
  if (changed) {
    onCatalogApplied?.();
  }
  return changed;
}

function cachePath(): string {
  return path.join(getUserDataDir(), CACHE_FILE);
}

function loadCacheSync(): void {
  const file = cachePath();
  try {
    if (!fs.existsSync(file)) {
      return;
    }
    const envelope = JSON.parse(fs.readFileSync(file, "utf8")) as CacheEnvelope;
    const { models } = validateModelCatalogPayload(envelope.payload);
    apply(models, { source: "cache", fetchedAt: envelope.fetchedAt });
    log("info", "model-catalog", "cached remote catalog applied", { models: models.length, fetchedAt: envelope.fetchedAt });
  } catch (error) {
    // A broken cache must not take the app down — but it is surfaced, and the
    // file is removed so the next successful fetch rewrites it cleanly.
    const reason = error instanceof Error ? error.message : String(error);
    status = { ...status, lastError: `cache rejected: ${reason}` };
    log("warn", "model-catalog", "cached catalog rejected; falling back to bundled", { file, reason });
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* rm failure only means the same warning next launch */
    }
  }
}

function saveCache(envelope: CacheEnvelope): void {
  const file = cachePath();
  try {
    fs.writeFileSync(file, JSON.stringify(envelope));
  } catch (error) {
    log("warn", "model-catalog", "failed to write catalog cache", {
      file,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
