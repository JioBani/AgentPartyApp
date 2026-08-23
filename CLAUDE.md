# CLAUDE.md

Project guidance for Claude Code. The agent instructions below are the single
source of truth shared with all agents; this file imports them so Claude and
other tools stay in sync.

@AGENTS.md

The real-rendering and layout-verification requirements for UI changes are inherited from `AGENTS.md` and are mandatory.

After feature development, prioritize manual end-to-end testing against the real running AgentParty application through its local automation HTTP API instead of writing a new test script. Create a dedicated test script only for a sufficiently complex or difficult case where scripting is materially faster than manual API-driven verification.

When relevant validation already passed in the owning worktree and interaction risk between pending changes is low, merge validation follows `AGENTS.md`: confirm inclusion and conflict status, then run only the minimum necessary smoke checks instead of repeating the full typecheck, build, and E2E suite for every merge into `master`. Run the full integrated validation once immediately before release after all planned work is merged, while retaining targeted regressions for high-risk interactions and changes to core runtime, data, security, or release paths.

Plan work by dependencies and the critical path, distinguishing prerequisites and deployment or integration blockers from independent follow-up work instead of serializing a task list by default. In member collaboration, deliver the minimum output, decision, or status that unblocks a waiting member before continuing independent validation, cleanup, or supplementary work afterward or in parallel.

Worktree and temporary-directory cleanup that is not required for a release must not delay deployment; track it and complete it after deployment succeeds and is verified. Cleanup necessary for safety, integrity, or release reproducibility remains a pre-deployment gate.

Worktree `node_modules` handling follows the mandatory rules in `AGENTS.md`: worktrees share the main checkout's single install through junctions, so before any worktree removal or recursive cleanup, check whether `node_modules` is a junction and remove the link itself first (`cmd /c rmdir <worktree>\node_modules`) — deleting through a live junction wipes the shared install for everyone (it happened on 2026-08-17 and again on 2026-08-23). `npm install` runs only in the main checkout; never substitute another worktree's install via a temporary junction; if the shared install is found empty, stop builds, announce to the party, and restore before resuming.
