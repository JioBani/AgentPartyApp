/** Coordinate local Codex initialization; initialized members still run in parallel. */
let startupTail: Promise<void> = Promise.resolve();
let shuttingDown = false;
let storageMaintenance = false;

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

export async function waitForCodexInitialization<T>(initialization: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      initialization,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Codex initialization did not finish within ${CODEX_INITIALIZE_TIMEOUT_MS / 1000}s. The process must be stopped; its storage may require recovery.`,
        )), CODEX_INITIALIZE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
