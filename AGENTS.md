# Agent Instructions

- When problems occur, prioritize fixing the root cause over temporary workarounds. Short-term bypasses can create larger costs later.
- Do not work only from unverified hypotheses. If something is uncertain, inspect the project or search reliable sources before acting.
- Do not hide failures with silent fallback behavior. Surface errors through logs, notifications, or other visible diagnostics.
- Every user-facing capability must be exposed through the local automation HTTP API so AI agents can drive and QA it. Route UI and HTTP through the same `AppController` method, register the endpoint in `src/shared/apiSpec.ts`, and document it in `docs/API.md`.
- For feature testing, create or reuse a QA workspace and run end-to-end tests when the change needs behavioral verification.
- Design UI interactions to be user-friendly and task-oriented. Avoid relying on top-bar quick input for important workflows when an in-view form, modal, or richer interaction would be clearer.
- After every implementation task, review the changed code for AI readability, clean architecture boundaries, low change surface, and extensibility. If the code does not meet those rules, refactor it before treating the task as complete.
