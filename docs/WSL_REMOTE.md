# Remote Engine — WSL-native Workspaces (Tier A)

> Status: **design / in progress**. This document is the single source of truth
> for the WSL-native workspace effort. Each implementation stage below must land
> green (typecheck + `test:ui` + multi-window QA) and keep **local (Windows)
> behavior byte-identical** until the remote path is explicitly opted into.

## 1. Goal

Run agent sessions with a **native WSL working directory**, the way VS Code's
WSL extension does: open the app "in" a WSL distro so the agent's `cwd`, file
tools, `Bash`, `git`, Node, and build toolchain all execute **inside Linux** —
not as Windows processes reaching across the `\\wsl$` 9P bridge.

Non-goals (for now): SSH remotes, Dev Containers. The boundary introduced here is
designed to accept them later, but only WSL is in scope.

## 2. How VS Code actually does it (reference model)

VS Code Remote-WSL does **not** merely change a `cwd` string. It splits the app:

- **Client** (Electron UI on Windows): renderer + a thin client.
- **Server** (headless Node, installed and run **inside the distro**): the
  extension host, integrated terminal, file system, debugger, tasks — everything
  that touches the workspace — runs in Linux with Linux paths.
- The two communicate over a local pipe; the workspace is identified by a remote
  URI (`vscode-remote://wsl+Ubuntu/home/user/proj`).

The lesson: **move the engine to the OS where the workspace lives.** We mirror
this.

## 3. Current architecture (as-is) — why WSL is impossible today

Everything that touches the workspace runs in the **Electron main process on
Windows**, with Windows paths and a Windows-native harness binary. Seven concrete
blockers:

| # | Location | Blocker |
|---|----------|---------|
| 1 | [`claudeNativePackageName`](../src/core/claudeAdapter.ts) | harness = **win32 `claude.exe`**, spawned by the SDK as a Windows child process. Bash/git/Edit run on Windows. |
| 2 | [sessionManager.ts](../src/main/sessionManager.ts), [claudeAdapter.ts](../src/core/claudeAdapter.ts) | `cwd` is a **bare string**; there is no notion of *which host* it belongs to. |
| 3 | [workspaceManager.ts](../src/main/workspaceManager.ts), [windowRegistry.ts](../src/main/windowRegistry.ts), [appController.ts](../src/main/application/appController.ts) | workspace identity = **win32 `path.resolve`** → corrupts a Linux absolute path (`/home/x` → `C:\home\x`). |
| 4 | [partyRepository.ts](../src/main/partyRepository.ts) | storage via **Windows `node:fs` + `path.join`** → `.agent_party_app/` lands on Windows fs (or slow 9P). |
| 5 | [sessionManager.ts](../src/main/sessionManager.ts) (`listResumableSessions`) | `sdk.listSessions({dir})` reads the **Windows `~/.claude`**. |
| 6 | [main.ts](../src/main/main.ts) (`workspace:choose`) | workspace picker = **Windows `showOpenDialog`**; no distro / Linux-path selection. |
| 7 | [routerShim.ts](../src/core/routerShim.ts) | embedded router runs on Windows `127.0.0.1`; an in-distro harness can't reach it cleanly. |

**Key leverage:** the binary-selection logic in blocker #1 already picks
`@anthropic-ai/claude-agent-sdk-linux-x64` when `process.platform === 'linux'`.
So if the **engine itself runs inside WSL**, much of the path/binary code (#1,
#3, #4, #5) becomes correct *for free*. This is why Tier A (move the engine), not
Tier B (wrap the cwd), is the root-cause fix.

## 4. Target architecture (to-be)

```
┌── Windows ─────────────────┐         ┌── WSL distro (e.g. Ubuntu) ───────────┐
│  Electron UI (renderer)    │         │  AgentParty Engine (headless Node)    │
│  + thin client / window    │  RPC    │   SessionManager + ClaudeAdapter      │
│  registry                  │◄──────► │     (linux claude binary)             │
│                            │ socket/ │   PartyRepository (linux node:fs)     │
│  EngineConnection ─────────┼─stdio──►│   EmbeddedRouter + Automation API     │
│   ├─ LocalEngine (in-proc) │         │   cwd = /home/user/project (native)   │
│   └─ RemoteEngineClient ───┼────────►│   storage = <cwd>/.agent_party_app/   │
└────────────────────────────┘         └───────────────────────────────────────┘
```

- **Local (Windows) workspace** → `LocalEngine`, in-process, exactly today's code.
- **WSL workspace** → an `EngineServer` spawned **inside the distro** via
  `wsl.exe -d <distro> -- <node> server.js`, reached through a
  `RemoteEngineClient`.
- A **window** is bound to one `EngineConnection`. Windows on the **same (host,
  workspace)** share one engine context — the locked single-source rule
  ([[workspace-window-model]]), extended from `workspace` to `(host, workspace)`.

## 5. `WorkspaceLocation` — typed identity (Stage 1)

Replace the bare `workspacePath: string` with a typed location that flows through
settings → window registry → engine → harness `cwd` → storage.

```ts
type WorkspaceHost =
  | { kind: "local" }
  | { kind: "wsl"; distro: string };

interface WorkspaceLocation {
  host: WorkspaceHost;
  path: string; // host-native absolute path (win32 for local, posix for wsl)
}
```

**URI codec** (`src/shared/workspaceLocation.ts`, pure & unit-tested):

- `parse(s)`:
  - `wsl+<distro>:<posix-abs-path>` → `{ host:{kind:'wsl',distro}, path }`
  - anything else → `{ host:{kind:'local'}, path: s }` (backward compatible)
- `serialize(loc)`:
  - wsl → `wsl+<distro>:<path>`
  - local → **the raw path unchanged** (so existing settings/state keep working)
- `key(loc)` — identity for caching/dedup, replacing every `path.resolve(...)`:
  - local → `path.win32.resolve(path)` (**identical to today**)
  - wsl → `wsl+<distro>:` + `path.posix.normalize(path)`

This makes local behavior byte-identical while giving WSL a stable identity. The
example URI mirrors VS Code's `wsl+<distro>` authority.

## 6. `EngineConnection` boundary (Stage 2)

Today `AppController` directly holds `sessionManager` and `workspaceManager`.
Extract the surface it uses into an interface:

```ts
interface EngineConnection {
  state(loc): Promise<EngineState>;
  party: PartyOps;        // list/create/member ops
  sessions: SessionOps;   // create/send/approve/...
  qa: QaOps;
  onEvent(cb): Unsubscribe; // session events / party updates
  dispose(): void;
}
```

- `LocalEngine implements EngineConnection` — wraps the current in-process
  managers. **No behavior change**; this stage is a pure refactor.
- Later, `RemoteEngineClient implements EngineConnection` — same interface over
  RPC.

A small `EngineRegistry` maps `key(loc)` → connection (local in-proc, or a
spawned remote), enforcing the shared-context rule.

## 7. RPC transport (Stage 4)

- Message set = exactly the payloads already crossing Electron IPC / the
  automation API (request/response + an event stream). No new semantics.
- Framing: length-prefixed JSON over a socket (Windows ↔ distro). WSL2 forwards
  `localhost`, but an explicit socket/stdio pipe is preferred (deterministic,
  no port races).
- Prove it **locally first**: run `EngineServer` as a Windows child node process
  over the socket before introducing `wsl.exe`. Same transport, fewer variables.

**Implemented (S7 — the live session plane):**
- Session control by id (send/interrupt/approve/restart/compact/model/effort/
  permission/close) is now part of EngineConnection and routed to the engine
  that owns **the caller's workspace** (the sending window / `?window=`) — a
  session lives in its workspace's engine, so no global session→engine map is
  needed.
- The engine **pushes** session activity (`session:events`/`:snapshot`/
  `:sessions`) over the same channel as `{ kind: "event" }` frames;
  `RemoteEngineClient.onEvent` re-emits them and the desktop broadcasts them to
  that workspace's windows (re-stamping the workspace to the Windows-side URI).
- Verified by `test:wsl-session`: a turn sent to a member whose session lives in
  the WSL engine streams its reply (assistant delta + turn_complete) back to
  Windows over wsl.exe — real transport/routing/streaming, only the model
  *content* mocked. Holds at the app level too (seed+send via HTTP → the WSL
  session goes idle on completion).

## 8. In-distro server bootstrap (Stage 5)

Mirrors VS Code's "install server on first connect":

1. **Detect distros** — `wsl.exe -l -q` (+ verify online). Surface the list; do
   not guess a default silently.
2. **Require distro node** (decided: rely on the distro's node, not a bundled
   runtime — see §16). Probe `node -v` in the distro; if missing or too old,
   **surface an explicit error with an install hint** (`sudo apt install nodejs`)
   — never silently fall back to a Windows run.
3. **Ensure engine** under `~/.agent_party_app/server/<version>/` inside the
   distro: copy the engine bundle **and the linux claude binary** from the
   Windows app into the distro. Version-gated so upgrades reinstall.
4. **Spawn** `wsl.exe -d <distro> -- <node> server.js --socket <path>`.
   **Strip `ELECTRON_RUN_AS_NODE`** (the known launch-bug lesson — see
   [[renderer-qa-without-electron]] context): inside the distro we run *plain
   node*, not electron.
5. **Handshake**: version check, capability check, then connect.

Failures (no distro, install error, version mismatch, handshake timeout) are
**surfaced explicitly** (log + UI), never silently downgraded to a Windows run
(convention #3).

## 9. Router & auth

- The `EmbeddedRouter` runs **alongside the engine** (inside the distro for WSL),
  so the harness `env.ANTHROPIC_BASE_URL` points to a reachable in-host address.
- Credentials (OpenRouter key, etc.) are **per-host**: a WSL engine reads/writes
  its own store inside the distro. The client forwards what's needed at connect
  time; we do not assume Windows-side secrets are visible in the distro.

## 10. Automation API impact (convention #4)

Every new capability is exposed through the same `AppController` path, registered
in [`apiSpec.ts`](../src/shared/apiSpec.ts), documented in [API.md](API.md):

- `GET /api/hosts` — list available hosts (`local` + detected WSL distros).
- Window/workspace open gains a **host**: `POST /api/windows` and
  `POST /api/windows/:id/workspace` accept a `WorkspaceLocation` URI (the
  `wsl+<distro>:/path` form), in addition to today's plain path.
- `GET /api/state` / `GET /api/windows` report each window's `WorkspaceLocation`
  (host + path), not just a string.
- All existing routes keep working unchanged for local workspaces.

## 11. QA plan (convention #5)

- **Stage 1**: pure unit test for the `workspaceLocation` codec
  (parse/serialize/key round-trips; local path byte-identical; WSL URI cases).
  Runs headless, no Electron.
- **Stage 2–4**: `LocalEngine` and the socket transport are exercised by the
  existing render/layout/multi-window suites (behavior unchanged) plus a
  transport round-trip test against a Windows-spawned `EngineServer`.
- **Stage 5**: WSL bootstrap is QA'd with `wsl.exe` **mockable** (inject a fake
  launcher) so it runs where WSL is absent; a real-distro smoke is documented but
  gated.
- The mock harness ([mockHarness.ts](../src/main/harness/mockHarness.ts)) is
  already host-agnostic, so frontend E2E keeps working over either engine.

## 12. Migration stages (each shippable & green)

| Stage | Deliverable | Local behavior |
|-------|-------------|----------------|
| **S1** | `WorkspaceLocation` type + codec + unit test; adopt as identity key | byte-identical |
| **S2** | `EngineConnection` + `LocalEngine` (pure refactor) | unchanged |
| **S3** | headless engine entry (process-agnostic bootstrap) | unchanged |
| **S4** | RPC transport; `RemoteEngineClient` ↔ `EngineServer` proven locally | unchanged (still local) |
| **S5** | WSL bootstrap (distro detect, in-distro server install, spawn via `wsl.exe`), distro/path picker + `/api/hosts`, **`agent-party` CLI launcher (§13)** | unchanged; WSL opt-in |
| **S6** | packaging: linux claude binary in-distro; build pipeline; install the CLI shim onto the distro `PATH` | unchanged |

## 13. `agent-party` CLI launcher — the `code .` analog (Stage 5)

**Requirement:** from a directory inside WSL, running `agent-party` (optionally
`agent-party .`) opens that directory as an AgentParty workspace in the Windows
UI — exactly how `code .` opens a Remote-WSL window.

**Reference — how `code` does it** (verified by reading the shim at
`…/Microsoft VS Code/bin/code`): it is a POSIX `sh` script on the WSL `PATH`
that does **not** network from Linux to Windows. Instead it:

1. reads `$WSL_DISTRO_NAME` to know the distro,
2. uses `wslpath`/`WSLENV` (e.g. `WSLENV=ELECTRON_RUN_AS_NODE/w`) to translate
   paths/env across the boundary,
3. invokes the **Windows** Electron exe over WSL→Windows **interop**
   (`ELECTRON_RUN_AS_NODE=1 Code.exe cli.js …`), letting the Windows side do the
   actual window open / remote handshake.

**Our design (mirror it):**

```
[WSL]  agent-party  (sh shim on PATH)
   │  builds  wsl+$WSL_DISTRO_NAME:$(realpath .)
   │  interop → invokes Windows launcher (no WSL→Win networking)
   ▼
[Windows]  agent-party-cli (Electron-as-node or small exe)
   │  if app running → POST /api/windows { workspacePath: "wsl+<distro>:/path" }   (127.0.0.1, Windows-local)
   │  else           → launch the app, then request the window
   ▼
[Windows]  AgentParty UI opens/focuses a window for that WSL workspace
   │  (window then connects the engine inside <distro> — §4/§8)
```

Why interop and not WSL→Windows sockets: in default WSL2 NAT networking, Linux
`localhost` does **not** reach the Windows loopback, so calling the Windows
automation API *from* WSL is unreliable. Interop (proven available:
`/proc/sys/fs/binfmt_misc/WSLInterop = enabled`, `cmd.exe` callable) lets the
shim hand off to a Windows process that *can* reach `127.0.0.1`. This is the same
reason `code` shells out to `Code.exe` instead of opening a socket.

The shim does **not** require a WSL-side install to be typeable: WSL appends the
Windows `PATH` into the distro via interop, so a shim placed in the Windows app's
`bin/` directory (on the Windows PATH) is immediately runnable as `agent-party`
inside any distro — exactly why `command -v code` already resolves the Windows
`code` shim from WSL (verified). The open request reuses the existing
`POST /api/windows` endpoint (convention #4) with a `wsl+<distro>:` URI — no
bespoke channel.

**Implemented (S5d):**
- `scripts/agent-party` — the WSL `sh` shim: builds `wsl+$WSL_DISTRO_NAME:$(realpath .)`
  and execs the Windows launcher via interop (`node.exe`, no WSL→Win networking).
- `scripts/agent-party-launcher.mjs` — Windows launcher: discovers the running
  app's automation URL from `<userData>/automation.json` (written by the app on
  startup) and POSTs `/api/windows`.
- Verified by `npm run test:wsl-cli` (app running): typing `agent-party` in a
  distro dir opens that cwd as a workspace. Installing the shim onto the Windows
  `bin/` (so it is typeable without a path) is a packaging step — §8/S6.

## 14. WSL QA environment (verified)

E2E QA runs against a **real** distro, not a mock, once the engine is headless
(S3+). Verified on this machine:

- distro **Ubuntu-22.04** (WSL2, default), interop **enabled**.
- **node v22.22.2** and **git** already present in the distro → the engine can
  run on the distro's node; pinning a runtime stays optional (see risks).
- native Linux scratch cwd: **`/home/dev/agentparty-wsl-e2e`** on **ext4**
  (not the `\\wsl$` / `/mnt/c` 9P bridge) — this is the canonical WSL-native QA
  workspace. `.agent_party_app/` for it must land on ext4, engine-side.
- `$WSL_DISTRO_NAME` is set inside the distro (the CLI relies on it).

## 15. Deployment / install model (decided)

**One install — on Windows.** There is no manual WSL-side install of AgentParty.

- **The `agent-party` CLI** becomes typeable in every distro automatically,
  because WSL appends the Windows `PATH` (interop) and our shim lives in the
  Windows app's `bin/` (§13) — same mechanism that already exposes `code`.
- **The Linux engine** is auto-provisioned into the distro on first use
  (`~/.agent_party_app/server/<version>/`, copied from the Windows app — §8),
  like VS Code's "server install on connect".
- **node:** decided to **rely on the distro's node** (verified present, v22).
  If a distro lacks node, the bootstrap surfaces an explicit error + install
  hint (§8 step 2) — never a silent Windows fallback. We do **not** bundle a
  Linux node runtime (lighter installer; acceptable for dev distros). Revisit
  only if zero-prerequisite distros become a requirement.
- **The Linux claude binary** is shipped inside the Windows app and copied into
  the distro during provisioning (S6) — not separately installed by the user.

**S6 status:** done — OpenRouter key forwarded into the distro engine via WSLENV
(so harness/model routing works in WSL); engine processes disposed when their
last window closes and on app quit; the CLI shim + launcher ship as
`extraResources` (`resources/bin/`). **Remaining (needs a real build/install to
verify):** register `resources/bin` on the Windows PATH from the NSIS installer,
and provision the **Linux claude binary** into the distro (until then, a *real*
model session in WSL fails with an explicit "claude binary not found" error —
never a silent fallback; mock sessions and routing are unaffected).

Net: install once on Windows; typical dev distros (with node) need **zero**
extra steps; a bare distro needs at most a one-time `apt install nodejs`.

## 16. Risks / open questions

- **File preview on the Windows side**: if the UI ever needs workspace files
  directly (thumbnails, diffs), it must go through the engine RPC, not `\\wsl$`.
- **Per-host auth/router duplication** and where keys live.
- **WSL2 networking:** Windows→WSL `localhost` is auto-forwarded, but WSL→Windows
  is not (NAT). Engine RPC is Windows→WSL (OK); the CLI open is WSL→Windows and
  therefore uses **interop**, not sockets (§13). Favor an explicit socket/pipe
  for the engine transport over relying on localhost.

---

*Linked rules:* [[workspace-window-model]] (extended to `(host, workspace)`),
convention set in [AGENTS.md](../AGENTS.md).
