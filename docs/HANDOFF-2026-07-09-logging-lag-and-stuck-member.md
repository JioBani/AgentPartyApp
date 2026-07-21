# Handoff — Runaway transcript logging → UI lag, disk-write spike, and stuck "working" members

- **Date:** 2026-07-09
- **Author:** main (AgentParty session), investigation only — no code changed
- **Why this doc:** The AgentParty desktop is too laggy to edit safely in-place (see Issue A). Fix these in a clean environment.
- **Environment observed:** Windows 11 desktop app (`%APPDATA%\AgentParty`) + WSL2 engine (`engine-server.mjs`, Ubuntu-20.04) driving workspaces `/home/spdlqj8876/sellmate-dockerize` and `/home/spdlqj8876/erp`.

## Status — 2026-07-20

Recommendations 1–3 and 5 are implemented; the follow-up investigation is in
[HANDOFF-2026-07-20-transcript-rpc-backpressure.md](HANDOFF-2026-07-20-transcript-rpc-backpressure.md).

| # | Recommendation | Status |
|---|---|---|
| 1 | Stop logging large IPC payloads | **done** — `summarizeIpcArgs` in `main.ts` |
| 2 | Logger size cap / async / rotation | **partial** — payloads bounded by #1; the write is still sync `appendFileSync` with no rotation |
| 3 | Don't re-serialize the whole transcript per save | **done** — anchored appends (`TranscriptSave`), see the 07-20 handoff |
| 4 | Investigate transcript bloat (~150 MB, blocks ~30 KB each) | **open** — `TRANSCRIPT_CAP` still counts blocks, not bytes |
| 5 | Recover stuck members when their turn dies | **done** — manual force stop in both adapters (no auto-escalation; see the 07-20 handoff for why) |

## TL;DR

One root-cause bug produces three symptoms. The generic IPC handler logs the **full argument payload of every IPC call**, and `party:transcript:save` carries the **entire member transcript**. The logger writes it with a **synchronous, unbounded `fs.appendFileSync`** on the Electron main thread. When transcripts get large (tens–hundreds of MB), every save blocks the main thread on a huge `JSON.stringify` + disk append, and the log file grows by GB/minute.

- **Issue A (primary, live):** UI lag with low memory. Active desktop log grew at **28.6 MB/s (~1.6 GB/min)** to 10.9 GB; individual log lines were **70–153 MB**, all `party:transcript:save` for members `main`/`worker01` (~150 MB transcripts). Main-thread event loop starves → lag. Memory stays low because data is streamed to disk, not held.
- **Issue B:** A member (`survey4`, Codex/gpt-5.5) is stuck forever in "작업중"/working. Its `codex app-server` process died mid-turn; the terminal state never reached the desktop, and there is no watchdog to reconcile a busy snapshot against a dead process.
- **Issue C (open, not yet root-caused):** `/compact` and the compact toolbar button are unresponsive on `worker`. Likely related to the same main-thread stall and/or large transcripts. Needs its own investigation.

---

## Root cause (shared by A and B)

### The logging amplifier
- `src/main/main.ts:498-500` — generic IPC wrapper logs the **full `args`** of every channel:
  ```ts
  function handle(channel, listener) {
    ipcMain.handle(channel, async (event, ...args) => {
      log("info", "ipc", channel, { args });   // <-- full payload, every call
  ```
- `src/main/main.ts:495` — `party:transcript:save` args are `[name, blocks]`, where `blocks` is the **entire transcript array** for that member. So every save re-logs the whole transcript → O(n²) growth as transcripts grow.
- `src/main/logger.ts:44-52` — `info` level is **not** gated by the debug flag (only `"debug"` is), and the write is **synchronous & unbounded**:
  ```ts
  export function log(level, scope, message, data?) {
    if (level === "debug" && !debugLoggingEnabled) return;   // info always writes
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(file, line, "utf8");                    // sync, blocks main thread, no size cap
  ```
- `src/main/partyRepository.ts:264` — the actual persistence (`saveMemberTranscript`) also uses **synchronous** `fs.writeFileSync` of the same large transcript, so each save stalls the main thread **twice** (once to persist, once to log).

Net effect: with a ~150 MB transcript, each save = `JSON.stringify(150MB)` ×2 + ~300 MB of synchronous disk writes on the Electron main thread.

---

## Evidence

### Issue A — live measurement (this desktop, 2026-07-09)
- Active log `%APPDATA%\AgentParty\logs\agentparty-2026-07-09T00-06-09-211Z.ndjson`: **8.4 GB → 10.9 GB** across two samples ~2 min apart → **~1.6 GB/min**, instantaneous **28.6 MB/s**.
- Last 60 log lines = **4.31 GB**, avg **73.6 MB/line**, max **153.9 MB** single line; **100% `party:transcript:save`** for `main` and `worker01`.
- Electron processes: working sets 75–600 MB (one ~1.6 GB) — **memory is not the problem**; matches the "메모리는 안 높은데 렉" report.
- Log folder history: 13 GB+ total; single files 2.6–2.8 GB on 2026-07-08 and 2026-07-06/07.

### Issue B — survey4 stuck "working"
- Party `party-1783402907431-ae35105b0206d`, workspace `sellmate-dockerize`. Member `survey4`: model `gpt-5.5` (Codex adapter), `sessionId=resume-1783499278721`, `harnessSessionId=019f40d2-d54b-79e0-8341-bc43031ed288`.
- Codex rollout `~/.codex/sessions/2026/07/08/rollout-...-019f40d2-...jsonl` **stops mid-turn at 2026-07-08T09:08:51Z** (last record a `reasoning` item; no completion). Turn accounting: `task_started=7` vs `task_complete=5` → 2 turns never finished. No approval/elicitation pending.
- **No `codex app-server` process alive** for survey4 (verified via full `pstree` of engine pid 72514 and cmdline scan). Engine 72514 itself has been alive since 14:08:14 KST and **never restarted**.
- Codex's own log DB `~/.codex/logs_2.sqlite` reads **"database disk image is malformed"** — signature of an abrupt (non-graceful) termination; last durable row 09:00:27Z.

### Issue B — why it stays "working" (renderer logic)
- `src/renderer/workbench/memberStatus.ts:7` `BUSY_STATUSES = {requesting, responding, interrupting}`; `:9` `isSessionBusy`; `:20-35` `deriveStatus` returns `"working"` iff a live session is busy.
- Only `turn_complete` clears busy: `src/core/codexAdapter.ts:1012`. On process death, `handleExit` (`codexAdapter.ts:1050`) → `finishWithError` (`:1016`) emits an **`error`** event, **not** `turn_complete`. `error` status is not in `BUSY_STATUSES`, so IF it reached the desktop the member would show idle/error — it does not, so the desktop's cached session snapshot is frozen at `responding`.
- No watchdog reconciles this. `src/main/sessionManager.ts` stall watchdog (20 s interval / 120 s threshold) only appends an advisory `diagnostic` (would show "stalled", not recover), and `partyApplicationService` sets `status="running"` but never resets it to idle.

### What actually killed the codex process (ruled out OOM)
- **No kernel OOM-killer** anywhere on 2026-07-08 (`journalctl -k`).
- **No `systemd-oomd`** kills (unit has no entries).
- **No cgroup memory kill**; `.wslconfig` is `memory=24GB, swap=8GB` (autoMemoryReclaim off).
- Instead, correlated with the death: a **WSL interop stdio-relay EPIPE storm** at 2026-07-08 18:09:00–02 KST (≈9 s after codex stopped): ~6,100 lines in 3 s of
  ```
  WSL (32552 - Relay(32553)) ERROR: InitCreateProcessUtilityVm:1788: delayed stdin write failed 32, ChildPid=-1
  ```
  `failed 32` = **EPIPE (broken pipe)**. Desktop logs show the giant transcript log froze at 17:59:32 KST and codex telemetry at 18:00:27 — i.e., the main process was buried in synchronous transcript I/O around then.
- **Interpretation (strong inference, not directly captured):** the I/O-bound Electron main process stalled and stopped pumping the Windows↔WSL stdio relay; the relay pipe broke (EPIPE storm) and the Codex turn's stdio was torn down mid-turn, so the app-server exited without a `turn_complete`. The exact exit code/signal is unrecoverable — codex stderr is not persisted, the engine does not log adapter exits to its ndjson, and codex's own sqlite log is corrupted.

---

## Recommended fixes

### 1. Stop logging large IPC payloads (fixes A directly; removes B's trigger)
In `src/main/main.ts` `handle()` (lines 498-500), do not log raw `args`. Log a compact summary instead — channel + arg count + byte size, and for `party:transcript:save` the member name + block count only. E.g. replace `log("info","ipc",channel,{args})` with a summarizer that truncates/omits payloads above a small threshold (say 4 KB) and never serializes transcript blocks.

### 2. Make the logger safe (defense in depth)
In `src/main/logger.ts`:
- Add a hard per-entry size cap (truncate `data` when the serialized line exceeds e.g. 16 KB).
- Move off synchronous `fs.appendFileSync` to a buffered async write stream.
- Add log-file rotation with a total-size cap so the folder can never reach multi-GB (it currently has no cap; 13 GB observed).

### 3. Don't re-serialize the whole transcript on every save
`party:transcript:save` + `partyRepository.ts:264` rewrite the full transcript synchronously each time. Consider incremental/append persistence, debouncing saves, and moving the write off the main thread.

### 4. Investigate transcript bloat (why blocks reach ~150 MB)
150 MB per member transcript is itself abnormal — likely large tool outputs (this investigation dumped big command outputs) or base64 images retained verbatim in blocks. Cap/truncate stored block payloads, or store large outputs by reference.

### 5. Recover stuck members when their process dies (fixes B's persistence)
- On Codex `handleExit`, emit a snapshot whose status is non-busy AND ensure it is delivered to the desktop over the WSL RPC (add ack/replay so a dropped terminal event can't freeze the UI).
- Add a liveness reconciliation: if a member's session process is gone but the snapshot is busy, force it to idle/error and surface a diagnostic. Have the stall watchdog escalate (dead process + busy snapshot → auto-clear) instead of only warning.

---

## Immediate mitigations (until fixed)
- Delete/rotate the runaway `%APPDATA%\AgentParty\logs\*.ndjson` (was 10.9 GB and growing ~1.6 GB/min; at that rate it can fill the disk in tens of minutes and cause the same pipe-break crash seen on 2026-07-08).
- Reduce the giant `main`/`worker01` transcripts (compact/clear or close those members). Note the persisted `transcript.json` is also ~150 MB, so a reopen re-triggers the large save/log unless trimmed.
- Recover `survey4`: close & reopen (rebind) the member, or restart the `sellmate-dockerize` workspace engine (other members are unaffected; the engine stays alive).

## Key file references
- `src/main/main.ts:495` (transcript:save handler), `:498-500` (generic IPC full-args logger)
- `src/main/logger.ts:44-52` (sync unbounded appendFileSync; info not gated)
- `src/main/partyRepository.ts:264` (sync writeFileSync of transcript)
- `src/core/codexAdapter.ts:1012` (turn_complete), `:1016` (finishWithError), `:1050-1061` (handleExit + gate)
- `src/renderer/workbench/memberStatus.ts:7-35` (BUSY_STATUSES / isSessionBusy / deriveStatus)
- `src/main/sessionManager.ts` (stall watchdog: 20 s interval / 120 s threshold, advisory only)
- `src/main/application/partyApplicationService.ts` (member status set to "running", never reset to idle)

## Not yet investigated
- **Issue C:** `/compact` command and toolbar compact button unresponsive on `worker`. Reproduce with a small transcript to isolate from the main-thread stall; check the `session:compact` IPC path (seen in logs) end-to-end (renderer → AppController → adapter). Verify whether large transcript / busy state blocks it.
