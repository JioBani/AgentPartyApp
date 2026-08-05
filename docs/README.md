# AgentParty documentation

This directory contains the maintained product and engineering documentation.
Design handoffs live separately under `디자인 핸드오프/` and are intentionally not
listed here.

## Start here

- [기능정의서.md](기능정의서.md): current product capability definition.
- [현황.md](현황.md): current work status, active blockers, and shared-workspace
  operating rules. It supersedes the one-off 2026-08-01 work-lane documents.
- [아이디어/아이디어.md](아이디어/아이디어.md): proposed product work.
- [FEEDBACK.md](FEEDBACK.md): open defects and verified improvements.

## Engineering references

- [ARCHITECTURE.md](ARCHITECTURE.md): dependency boundaries and feature-change
  checklist.
- [CODEMAP.md](CODEMAP.md): source ownership and runtime flows.
- [API.md](API.md): local automation API reference.
- [E2E_TESTING.md](E2E_TESTING.md): full-process verification guidance.

## Plans and research

- `기획 노트*.md`: feature-specific design decisions; each file names its scope.
- `model research/`, `claude-code-ux-research/`, and `codex-ux-research/`: dated
  research records, not current product contracts.
When changing a user-visible capability, update the capability definition,
`src/shared/apiSpec.ts`, and [API.md](API.md) together.
