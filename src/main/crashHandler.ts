import { logCritical } from "./logger";

/**
 * Last-known app state recorded next to a crash. **Counts and durations only** —
 * never a workspace path, a member name, a title, or prompt text. A crash report
 * travels to the author, so "6 sessions open, 3 minutes in" is what earns its
 * place; anything identifying does not.
 */
export type CrashContext = Record<string, string | number | boolean>;

export interface CrashHandlerOptions {
  /**
   * Terminates the process. Injected so this module never imports `electron` —
   * the desktop passes `app.exit`, which also tears down child processes.
   */
  exit: (code: number) => void;
  /** Optional state snapshot; failures inside it must not mask the crash. */
  describeContext?: () => CrashContext;
}

/** Serializes a thrown value, keeping the stack when there is one. */
function errorFacts(value: unknown): { name: string; message: string; stack: string } {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack || "(no stack)" };
  }
  return { name: typeof value, message: String(value), stack: "(not an Error — no stack)" };
}

/**
 * Records process-level failures so the app stops disappearing without a trace.
 *
 * **The two are treated differently, and the difference was measured, not
 * assumed** (Electron 33 on Windows, this app):
 *
 * - `uncaughtException` — **fatal.** It already kills the app today; the only
 *   thing missing is the record. So this logs and exits. It deliberately does
 *   NOT try to keep running: state is already broken, and continuing produces a
 *   second, stranger failure that buries the first. Exiting through `exit` also
 *   fixes an observed leak — an uncaught throw used to leave a process behind
 *   that still held the automation port and the single-instance lock, so the
 *   NEXT launch quit instantly with no explanation.
 * - `unhandledRejection` — **not fatal.** Electron runs the main process in
 *   `--unhandled-rejections=warn`, so today the app survives one and prints a
 *   console warning that a packaged build has nowhere to show. Killing the app
 *   here would newly terminate sessions that currently run fine, so this only
 *   turns that invisible warning into a durable log record.
 *
 * Installing early matters: handlers registered after a failure cannot record it.
 */
export function installCrashHandlers(options: CrashHandlerOptions): void {
  // A failure raised while reporting a failure must not recurse into this
  // handler forever — one honest exit is the goal.
  let handling = false;

  const context = (): CrashContext => {
    if (!options.describeContext) {
      return {};
    }
    try {
      return options.describeContext();
    } catch (error) {
      return { contextError: error instanceof Error ? error.message : String(error) };
    }
  };

  process.on("uncaughtException", (error) => {
    if (handling) {
      process.stderr.write(`[crash] a second exception arrived while reporting the first: ${String(error)}\n`);
      return;
    }
    handling = true;
    logCritical("crash", "uncaught exception — exiting", { fatal: true, error: errorFacts(error), context: context() });
    options.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    logCritical("crash", "unhandled promise rejection — continuing", { fatal: false, error: errorFacts(reason), context: context() });
  });
}
