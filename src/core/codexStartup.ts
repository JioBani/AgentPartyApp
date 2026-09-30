/** Coordinate local Codex initialization; initialized members still run in parallel. */
let startupTail: Promise<void> = Promise.resolve();
let shuttingDown = false;
let storageMaintenance = false;

export function assertCodexStorageMaintenanceIdle(): void {
  if (storageMaintenance) throw new Error("Codex storage maintenance is running. Wait for it to finish before changing thread connections.");
}

// Large existing rollout collections can take minutes to index on first launch.
export const CODEX_INITIALIZE_TIMEOUT_MS = 300_000;

export async function withAgentPartyCodexStartup<T>(start: () => Promise<T>): Promise<T> {
  return queueStartup(start, false);
}

async function queueStartup<T>(start: () => Promise<T>, maintenance: boolean): Promise<T> {
  const previous = startupTail;
  let release!: () => void;
  startupTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    if (shuttingDown) throw new Error("AgentParty is closing; no new Codex process can start.");
    if (storageMaintenance && !maintenance) throw new Error("Codex storage maintenance is running. Start this session after it finishes.");
    return await start();
  } finally {
    release();
  }
}

/** One explicit maintenance operation; no discovery/member start can race it. */
export async function withCodexStorageMaintenance<T>(operation: () => Promise<T>): Promise<T> {
  if (storageMaintenance) throw new Error("Codex storage maintenance is already running.");
  storageMaintenance = true;
  try {
    return await queueStartup(operation, true);
  } finally {
    storageMaintenance = false;
  }
}

/** Refuse queued/new starts and let the current initialization finish before app exit. */
export function finishCodexStartupBeforeQuit(): Promise<void> {
  shuttingDown = true;
  return startupTail;
}

/** An installer must not be spawned while a migration or handshake owns DBs. */
export function prepareCodexForInstall(): Promise<void> {
  if (storageMaintenance) throw new Error("Codex 저장소 전환 중에는 업데이트를 설치할 수 없습니다. 전환이 끝난 뒤 다시 시도하세요.");
  return finishCodexStartupBeforeQuit();
}

/** If installer dispatch fails, the still-running app can accept starts again. */
export function cancelCodexInstallPreparation(): void {
  shuttingDown = false;
}

export async function waitForCodexInitialization<T>(
  initialization: Promise<T>,
  reportSlow: (message: string) => void = console.warn,
  warningMs = CODEX_INITIALIZE_TIMEOUT_MS,
): Promise<T> {
  // A timed-out initialize may still be backfilling SQLite. Killing it leaves
  // Codex's persistent backfill flag running, blocking CLI/IDE starts as well.
  const timer = setTimeout(() => reportSlow(
    `Codex initialization is still running after ${warningMs / 1000}s. Waiting for it to finish to protect its storage.`,
  ), warningMs);
  try {
    return await initialization;
  } finally {
    clearTimeout(timer);
  }
}
