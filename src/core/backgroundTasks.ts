/**
 * Counts a Claude session's work that OUTLIVES its turn, so the app can tell a
 * genuinely idle member from one whose turn merely ended while work kept going.
 *
 * Why this is separate from {@link ClaudeSubagentTracker}: that tracker answers
 * "what should the subagent dock show", so it deliberately keeps only
 * `task_type === "local_agent"` rows. Liveness is the opposite question — a
 * backgrounded shell (`run_in_background`), a workflow, or an MCP monitor is
 * exactly the work that must not be killed, and those are the types the dock
 * throws away.
 *
 * ## What the harness actually emits
 *
 * Measured against a live Claude Code session rather than assumed (the debug
 * `sdk_message` log of a real run):
 *
 * - An ordinary FOREGROUND `Bash` call emits **no `task_*` events at all**. It
 *   begins and ends inside its tool_use/tool_result pair.
 * - A `run_in_background: true` Bash emits `task_started`
 *   (`task_type: "local_bash"`) and nothing further while it runs.
 *
 * So an open `task_started` IS the signal: the harness only raises one for work
 * that outlives the tool call. An earlier version of this file required
 * `task_updated.patch.is_backgrounded` before counting a task — that patch is
 * for backgrounding an already-running foreground task (the Ctrl+B path) and
 * never arrives for `run_in_background`, so the guard silently counted nothing
 * and a member with a live background shell was torn down anyway.
 *
 * Tasks settle on a terminal `task_updated.patch.status` or the
 * `task_notification` a backgrounded task emits when it finishes.
 *
 * ## Deliberate bias
 *
 * Nothing here is inferred from timing and nothing times out: a task stays
 * counted until the harness says it is over. If some path raises a
 * `task_started` that never settles, the member simply never sleeps — it keeps
 * memory it did not need. The opposite mistake destroys running work, so every
 * uncertainty resolves this way. `scripts/fixtures/subagents` contains exactly
 * such traffic (three `local_bash` tasks that never settle), which is why a
 * process-level check is the intended follow-up rather than more event guessing.
 */

/** `task_updated.patch.status` values that mean the task will produce no more work. */
const SETTLED_STATUSES = new Set(["completed", "failed", "killed"]);

interface TrackedTask {
  /** Task kind / description, for diagnostics only. */
  label: string;
}

export class BackgroundTaskTracker {
  private readonly tasks = new Map<string, TrackedTask>();

  /** `task_started` — work that outlives its tool call is now in flight. */
  started(message: unknown): void {
    const id = taskIdOf(message);
    if (!id) {
      return;
    }
    const record = message as { task_type?: unknown; description?: unknown };
    this.tasks.set(id, { label: String(record.task_type || record.description || "task") });
  }

  /** `task_updated` — settle the task when its status says it is over. */
  updated(message: unknown): void {
    const id = taskIdOf(message);
    const status = (message as { patch?: { status?: unknown } })?.patch?.status;
    if (id && typeof status === "string" && SETTLED_STATUSES.has(status)) {
      this.tasks.delete(id);
    }
  }

  /** `task_notification` — the terminal report for a task, whatever its outcome. */
  notified(message: unknown): void {
    const id = taskIdOf(message);
    if (id) {
      this.tasks.delete(id);
    }
  }

  /** How much detached work is in flight. Zero means nothing would be destroyed. */
  get count(): number {
    return this.tasks.size;
  }

  /** Task kinds still in flight, for diagnosing a member that never sleeps. */
  describe(): string[] {
    return [...this.tasks.values()].map((task) => task.label);
  }

  /** Drops all state — a restarted session starts from a clean slate. */
  reset(): void {
    this.tasks.clear();
  }
}

function taskIdOf(message: unknown): string | undefined {
  const id = (message as { task_id?: unknown })?.task_id;
  return typeof id === "string" && id ? id : undefined;
}
