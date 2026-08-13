/**
 * "This machine is not set up for that" — raised instead of a bare `Error` so
 * the failure arrives in the transcript as something the user can ACT on.
 *
 * It deliberately carries only a `checkId`, never the fix itself. The
 * environment report already owns every label, explanation and remedy for that
 * check; copying them here would give the transcript card and the environment
 * screen two versions of the same advice, free to drift. The renderer looks the
 * id up and renders the one authoritative answer.
 *
 * `raw` keeps the untranslated CLI text (paths tried, exit codes). It is what a
 * bug report needs, so it is preserved and shown under a disclosure rather than
 * replaced by the friendlier sentence.
 */
export class EnvironmentBlockedError extends Error {
  constructor(
    message: string,
    readonly checkId: string,
    readonly raw?: string,
  ) {
    super(message);
    this.name = "EnvironmentBlockedError";
  }
}

/** Narrowing helper — `instanceof` alone breaks across bundle boundaries. */
export function isEnvironmentBlockedError(value: unknown): value is EnvironmentBlockedError {
  return value instanceof EnvironmentBlockedError
    || (value instanceof Error && value.name === "EnvironmentBlockedError" && typeof (value as EnvironmentBlockedError).checkId === "string");
}

/**
 * Whether a thrown value is the OS refusing to start a program, as opposed to
 * the program failing once it ran. These are the codes `child_process` reports
 * when the executable is missing or not runnable — the shape of "not installed".
 */
export function isSpawnFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && ["ENOENT", "EACCES", "EPERM", "EINVAL"].includes(code);
}

/**
 * Turns any thrown value into the payload of an `error` event.
 *
 * Shared so every adapter reports a setup problem the same way: forgetting the
 * `environment` field in one of them is exactly how a harness ends up back at a
 * red wall of text while its siblings show a card.
 */
export function errorEventPayload(error: unknown): { message: string; environment?: { checkId: string; raw?: string } } {
  if (isEnvironmentBlockedError(error)) {
    return { message: error.message, environment: { checkId: error.checkId, raw: error.raw } };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}
