/**
 * What actually happened to a tool call, as opposed to whether it finished.
 *
 * The transcript drew ONE glyph — a check — and only recoloured it, so a call
 * the user REFUSED and a call that ran clean were the same shape. A red check
 * still reads as "done, fine", which is the opposite of what a refusal means.
 *
 * The mapping reads structured fields only (`status`, `exitCode`) and never the
 * error text: an outcome decided by matching words in a message is an outcome
 * that changes when the harness rewords its errors. Where the structure cannot
 * say — an old transcript, a harness that reports no exit code — the fallback is
 * the neutral "finished", never "succeeded": overstating a result is the one
 * error this whole distinction exists to prevent.
 *
 * `status` on the wire:
 *   started    — the call was issued; nothing has come back yet
 *   completed  — the call closed without the harness reporting an error
 *   failed     — the harness reported an error (tool_result is_error)
 *   denied     — the user or a policy refused the call (permission_denied)
 */

/** One tool call's user-facing result. */
export type ToolOutcome = "running" | "ok" | "failed" | "denied";

/** The fields the decision reads. Kept structural so tests need no transcript. */
export interface ToolOutcomeInput {
  status?: string;
  exitCode?: number;
  result?: unknown;
}

export function toolOutcomeOf(block: ToolOutcomeInput): ToolOutcome {
  switch (block.status) {
    case "started":
      return "running";
    case "denied":
      return "denied";
    case "failed":
      return "failed";
    default:
      break;
  }
  // A shell that closed "completed" with a non-zero exit did not succeed. The
  // harness reports the code; nothing here has to guess at the output.
  if (typeof block.exitCode === "number" && block.exitCode !== 0) {
    return "failed";
  }
  return "ok";
}

/**
 * Whether the outcome is one the user should not read as success.
 *
 * Kept as a function rather than `outcome !== "ok"` at each call site, so the
 * tone rules stay in one place when another non-success outcome is added.
 */
export function isToolProblem(outcome: ToolOutcome): boolean {
  return outcome === "failed" || outcome === "denied";
}
