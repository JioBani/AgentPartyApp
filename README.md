# AgentParty

AgentParty Desktop is an Electron client for local multi-agent coding sessions.

The app currently ports the AgentParty Native VS Code extension core into a desktop shell:

- Claude Code session harness
- Embedded OpenRouter-compatible router
- Auth panel for subscription and API-key based providers
- AgentParty member list/create/send/start/resume/close/remove controls
- Streaming-safe renderer updates for long model output
- In-app self-update from GitHub Releases (titlebar badge, 설정 → 버전 tab)

## Install (Windows)

Grab the latest `AgentParty-Setup-<version>.exe` from
[Releases](https://github.com/JioBani/AgentParty-releases/releases) and run it.
The build is unsigned, so SmartScreen warns once (추가 정보 → 실행).

Installed builds update themselves: the app checks GitHub Releases on start and
every 6 hours, shows a titlebar badge, and downloads only when you ask. The
portable `AgentParty-<version>.exe` runs without installing but cannot
self-update. See [docs/RELEASE.md](docs/RELEASE.md) for how releases are cut.

## Development

```powershell
npm install
npm run build
npm run start
```

Packaging:

```powershell
npm run dist:win      # build installer + portable into release/, no upload
npm run release:win   # same, then publish a draft GitHub release (needs GH_TOKEN)
```

For renderer hot reload:

```powershell
npm run dev
npm run start:dev
```

## Automation API

The app exposes every action through a local HTTP API for AI agents, debugging, and E2E tests.

Default URL:

```text
http://127.0.0.1:47831
```

Open the live spec:

```powershell
Invoke-RestMethod http://127.0.0.1:47831/api/spec
```

The maintained API document is [docs/API.md](docs/API.md).
For the complete documentation map, see [docs/README.md](docs/README.md).

## Logs

AgentParty writes NDJSON logs under the Electron user-data directory. The active log path is available from:

```powershell
Invoke-RestMethod http://127.0.0.1:47831/api/logs
```

## E2E

```powershell
npm run test:e2e
```

The smoke test starts the app, calls the automation API, verifies settings/model route updates, exercises window controls, and closes the app through the API.

`npm run test:e2e` starts the app with `AGENTPARTY_E2E=1`. In that mode provider verification and AgentParty member CLI calls are mocked, so the test does not call OpenRouter or other paid model APIs.

## Architecture

- `src/core`: reusable harness/router/cost/model modules ported from AgentParty Native.
- `src/main`: Electron main process, local settings, IPC handlers, session orchestration.
- `src/preload`: narrow IPC bridge exposed to the renderer.
- `src/renderer`: React desktop UI.
- `src/shared`: IPC and app state contracts shared by main and renderer.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for dependency rules and
[docs/CODEMAP.md](docs/CODEMAP.md) for the current module and runtime-flow map.

New harnesses should be added behind the main-process orchestration boundary instead of being called directly from the renderer.
