# CLAUDE.md

Project guidance for Claude Code. The agent instructions below are the single
source of truth shared with all agents; this file imports them so Claude and
other tools stay in sync.

@AGENTS.md

The real-rendering and layout-verification requirements for UI changes are inherited from `AGENTS.md` and are mandatory.

For UI features, also apply the `AGENTS.md` accessibility regression gate to existing workflows: verify in the real app that overlays, native browser views, and inputs do not cover or intercept permission/Message Gate controls or other existing actions, and confirm those controls remain clickable and keyboard-reachable.

After feature development, prioritize manual end-to-end testing against the real running AgentParty application through its local automation API instead of writing a new test script. Create a dedicated test script only for a sufficiently complex or difficult case where scripting is materially faster than manual API-driven verification.

When automation or QA acts as a party member and the capability exists as an AgentParty MCP tool, use the member-scoped real MCP transport endpoint (`/api/parties/:partyId/members/:name/mcp-tools/:tool`) by default. Do not replace it with a lower-level HTTP action route or a direct controller call, because that bypasses MCP schema, identity, framing, and host routing. Use direct HTTP only to test the HTTP contract itself, prepare or inspect fixtures and state, drive a human-only action, or cover a capability with no MCP tool, and record that reason in the test or validation notes.

When relevant validation already passed in the owning worktree and interaction risk between pending changes is low, merge validation follows `AGENTS.md`: confirm inclusion and conflict status, then run only the minimum necessary smoke checks instead of repeating the full typecheck, build, and E2E suite for every merge into `master`. Run the full integrated validation once immediately before release after all planned work is merged, while retaining targeted regressions for high-risk interactions and changes to core runtime, data, security, or release paths.

Plan work by dependencies and the critical path, distinguishing prerequisites and deployment or integration blockers from independent follow-up work instead of serializing a task list by default. In member collaboration, deliver the minimum output, decision, or status that unblocks a waiting member before continuing independent validation, cleanup, or supplementary work afterward or in parallel.

Worktree and temporary-directory cleanup that is not required for a release must not delay deployment; track it and complete it after deployment succeeds and is verified. Cleanup necessary for safety, integrity, or release reproducibility remains a pre-deployment gate.

Worktrees live only under `.worktrees/<topic>` inside the main checkout (git-ignored) and are removed with `node scripts/remove-worktree.mjs <path>` as soon as their branch is merged or abandoned — for released work, right after the deployment is verified. Never create a party member or spawn an agent with a worktree as its cwd: a session rooted there is lost when the worktree is removed. Start it from the main checkout and give it the worktree's absolute path to work in.

Worktree `node_modules` handling follows the mandatory rules in `AGENTS.md`: a `.worktrees/` worktree has no `node_modules` of its own and uses the main checkout's single install by walking up the tree — never add a junction or copy there by hand (only `scripts/package-win.mjs` links it, for the packaging run), and resolve tool paths through `scripts/lib/installRoot.mjs`. `npm install` runs only in the main checkout; never run a recursive cleanup there that can reach `.worktrees/`; remove worktrees only through `scripts/remove-worktree.mjs`, which unlinks every junction inside first (deleting through a live junction wiped the shared install on 2026-08-17 and 2026-08-23); if the shared install is found empty, stop builds, announce to the party, and restore before resuming.
