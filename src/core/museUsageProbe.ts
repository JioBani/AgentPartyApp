import { resolveMuseCli } from "./museCli";
import { MuseMspSession } from "./museMsp";
import { museUsageWindows } from "./museUsage";

export interface MuseUsageProbeOptions {
  cwd: string;
  executablePath?: string;
  model?: string;
  timeoutMs?: number;
  cliResolver?: typeof resolveMuseCli;
  sessionFactory?: (options: ConstructorParameters<typeof MuseMspSession>[0]) => MuseMspSession;
}

const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Makes one minimal provider turn in an isolated MSP session, then reads the
 * subscription snapshot that turn caused Muse to observe. The isolated session
 * is intentional: a usage refresh must never add a synthetic turn to a user's
 * member conversation or leak its prompt/output into the transcript.
 */
export async function probeMuseSubscriptionUsage(options: MuseUsageProbeOptions): Promise<unknown> {
  const cli = await (options.cliResolver || resolveMuseCli)(options.executablePath);
  const factory = options.sessionFactory || ((sessionOptions) => new MuseMspSession(sessionOptions));
  let observedUsage: unknown;
  let settleTurn!: () => void;
  let rejectTurn!: (error: Error) => void;
  let settleUsage!: () => void;
  const turnCompleted = new Promise<void>((resolve, reject) => {
    settleTurn = resolve;
    rejectTurn = reject;
  });
  const usageChanged = new Promise<void>((resolve) => {
    settleUsage = resolve;
  });
  const session = factory({
    command: cli.command,
    cwd: options.cwd,
    modelId: options.model && options.model !== "muse-default" ? options.model : undefined,
    approvalMode: "denyUnmatched",
    onNotification: (method, params) => {
      if (method === "usage/changed") {
        observedUsage = params;
        settleUsage();
      }
      if (method !== "turn/completed") return;
      const terminal = String(params?.terminal || "completed");
      if (terminal === "completed") settleTurn();
      else rejectTurn(new Error(`Muse usage probe ended as '${terminal}'.`));
    },
    onServerRequest: () => undefined,
    onExit: (error) => rejectTurn(error),
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timeout: NodeJS.Timeout | undefined;
  let usageWaitTimer: NodeJS.Timeout | undefined;
  try {
    await session.start();
    await session.startTurn("Reply exactly: OK", "low");
    await Promise.race([
      turnCompleted,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Muse usage probe timed out after ${timeoutMs}ms.`)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
    // Muse publishes `usage/changed` after `turn/completed`. Reading
    // immediately at the turn boundary races the host's own update and returns
    // truthful-but-empty data. Give the push a short head start, then use the
    // read as the authoritative fallback.
    await Promise.race([
      usageChanged,
      new Promise<void>((resolve) => {
        usageWaitTimer = setTimeout(resolve, 10_000);
        usageWaitTimer.unref?.();
      }),
    ]);
    const result = await session.readUsage();
    const usage = result?.usage ?? observedUsage;
    if (!museUsageWindows(usage).length) {
      throw new Error("Muse usage probe completed, but the MSP host reported no subscription usage.");
    }
    return usage;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (usageWaitTimer) clearTimeout(usageWaitTimer);
    session.dispose();
  }
}
