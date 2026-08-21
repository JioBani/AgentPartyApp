# CLAUDE.md

Project guidance for Claude Code. The agent instructions below are the single
source of truth shared with all agents; this file imports them so Claude and
other tools stay in sync.

@AGENTS.md

The real-rendering and layout-verification requirements for UI changes are inherited from `AGENTS.md` and are mandatory.

After feature development, prioritize manual end-to-end testing against the real running AgentParty application through its local automation HTTP API instead of writing a new test script. Create a dedicated test script only for a sufficiently complex or difficult case where scripting is materially faster than manual API-driven verification.
