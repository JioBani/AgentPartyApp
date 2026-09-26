"""One-time Windows storage transition. Runtime sessions do not depend on Python.

Only the Codex app-server writes operational state. sqlite3 is used read-only
and for consistent backups, including committed WAL data. No source DB is
merged, replaced, deleted, or marked backfill-complete by this worker.
"""
import collections
import datetime
import hashlib
import json
import os
import pathlib
import queue
import re
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
try:
    import tomllib
except ImportError:
    print(json.dumps({"error": "Python 3.11+ is required for this one-time storage operation."}), flush=True)
    sys.exit(1)

SUPPORTED_VERSION = "codex-cli 0.155.1"
PROTECTED_THREAD_FIELDS = ("archived", "memory_mode", "thread_section_id", "section_position", "section_entered_at_ms")
AUXILIARY_TABLES = ("thread_dynamic_tools", "thread_attachments", "projects", "project_roots",
                    "project_idempotency_keys", "remote_control_enrollments", "external_agent_config_imports")


def emit(**message):
    print(json.dumps(message, ensure_ascii=True), flush=True)


def normalized(value):
    return pathlib.Path(str(value).removeprefix("\\\\?\\")).resolve()


def connect(file):
    return sqlite3.connect(file.as_uri() + "?mode=ro", uri=True, timeout=10)


def tables(db):
    return {r[0] for r in db.execute("select name from sqlite_master where type='table'")}


def rowset(db, table):
    return set(db.execute('select * from "' + table + '"')) if table in tables(db) else set()


def fingerprint(text):
    return hashlib.sha256(text.replace("\r\n", "\n").encode()).hexdigest()


def thread_messages(thread):
    result = {"user": collections.Counter(), "assistant": collections.Counter()}
    for turn in thread.get("turns", []):
        for item in turn.get("items", []):
            if item.get("type") == "userMessage":
                role = "user"
                text = "\n".join(c.get("text", "") for c in item.get("content", []) if c.get("type") == "text")
            elif item.get("type") == "agentMessage":
                role, text = "assistant", item.get("text", "")
            else:
                continue
            if text:
                result[role][fingerprint(text)] += 1
    return result


def require_inactive_goal(directory, tid):
    file = directory / "goals_1.sqlite"
    if file.exists():
        with connect(file) as db:
            row = db.execute("select status from thread_goals where thread_id=?", (tid,)).fetchone()
            if row and row[0] not in ("complete", "blocked", "paused", "usage_limited"):
                raise RuntimeError("Stop the active goal before refreshing conversation history: " + tid)


class Server:
    def __init__(self, request, stderr_file, home, sqlite_home=None):
        self.home = normalized(home)
        env = os.environ.copy()
        env["CODEX_HOME"] = str(home)
        if sqlite_home is not None:
            env["CODEX_SQLITE_HOME"] = str(sqlite_home)
        self.stderr = open(stderr_file, "a", encoding="utf-8")
        self.child = subprocess.Popen([request["command"], *request["args"], "app-server"],
            cwd=str(home), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=self.stderr, text=True, encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW)
        self.responses = queue.Queue()
        self.sequence = 0

        def receive():
            for line in self.child.stdout:
                try:
                    value = json.loads(line)
                    if "id" in value:
                        self.responses.put(value)
                except ValueError:
                    continue
            self.responses.put({"closed": True})

        threading.Thread(target=receive, daemon=True).start()
        try:
            self.call("initialize", {"clientInfo": {"name": "agentparty-storage-transition", "version": "1"},
                                     "capabilities": {"experimentalApi": True}})
            self.child.stdin.write(json.dumps({"method": "initialized", "params": {}}) + "\n")
            self.child.stdin.flush()
        except Exception:
            self.close()
            raise

    def call(self, method, params):
        self.sequence += 1
        self.child.stdin.write(json.dumps({"id": self.sequence, "method": method, "params": params}) + "\n")
        self.child.stdin.flush()
        try:
            response = self.responses.get(timeout=300)
        except queue.Empty as error:
            raise RuntimeError("Codex did not answer within 300 seconds; inspect the preserved worker log.") from error
        if response.get("id") != self.sequence:
            raise RuntimeError("Codex stopped during storage verification; inspect the preserved worker log.")
        if "error" in response:
            raise RuntimeError(str(response["error"].get("message", "Codex request failed")))
        return response["result"]

    def read(self, tid):
        thread = self.call("thread/read", {"threadId": tid, "includeTurns": True})["thread"]
        if thread["id"] != tid:
            raise RuntimeError("Codex returned a different thread ID: " + tid)
        if not thread.get("path") or not normalized(thread["path"]).is_relative_to(self.home):
            raise RuntimeError("Codex resolved a rollout outside the selected home: " + tid)
        return thread

    def refresh(self, tid):
        # Paginated threads can have a stale/absent history DB after changing
        # storage. Codex's own resume rebuilds it from the rollout. Never start
        # a model turn or alter provider/archive settings to make this succeed.
        thread = self.call("thread/resume", {"threadId": tid})["thread"]
        self.call("thread/unsubscribe", {"threadId": tid})
        if thread["id"] != tid:
            raise RuntimeError("Codex resumed a different thread: " + tid)
        # Resume's inline view may differ from the persisted full-history read
        # for a compacted/paginated conversation. Compare the same read API on
        # both stores after unsubscribe has drained the history writer.
        return self.read(tid)

    def close(self):
        if self.child.poll() is None:
            self.child.stdin.close()
            try:
                self.child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                subprocess.run(["taskkill", "/PID", str(self.child.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW, check=False)
                self.child.wait(timeout=10)
        self.stderr.close()


def resolve_home(request):
    if not pathlib.Path(request["home"]).is_absolute():
        raise RuntimeError("A relative Codex home requires an explicit path review before transition.")
    home = normalized(request["home"])
    if not home.is_dir():
        raise RuntimeError("Codex home must exist before this operation: " + str(home))
    config_file = home / "config.toml"
    config = tomllib.loads(config_file.read_text(encoding="utf-8-sig")) if config_file.exists() else {}
    # Do not guess precedence for a profile/CLI override that this one-time
    # migration has not validated. Normal runtime continues to support them.
    if config.get("profile") or any(a.split("=")[0] in ("--profile", "-p") or re.search(r"\b(?:sqlite_home|profile)\s*=", a) for a in request["args"]):
        raise RuntimeError("Storage overrides through profiles/CLI arguments require a separate path review before transition.")
    value = config.get("sqlite_home") or request.get("sqliteEnvironment") or str(home)
    sqlite_home = normalized(value)
    if not pathlib.Path(value).is_absolute():
        raise RuntimeError("A relative sqlite_home requires an explicit path review before transition.")
    if request["mode"] == "legacy" and config.get("sqlite_home"):
        raise RuntimeError("Codex config sqlite_home overrides legacy isolation. Resolve that explicit user setting before requesting legacy mode.")
    return home, sqlite_home


def inventory(user_data, native):
    paths = sorted((user_data / "codex-sqlite").glob("*/state_*.sqlite"))
    if (native / "state_5.sqlite").exists():
        paths.append(native / "state_5.sqlite")
    records, sources, metadata = {}, {}, {}
    for file in paths:
        if file.name != "state_5.sqlite":
            raise RuntimeError("An unvalidated state DB version was found: " + str(file))
        with connect(file) as db:
            for tid, rollout in db.execute("select id, rollout_path from threads"):
                location = normalized(rollout)
                if tid in records and records[tid] != location:
                    raise RuntimeError("Conflicting rollout paths for thread " + tid)
                records[tid] = location
                sources.setdefault(tid, []).append(file)
            fields = {r[1] for r in db.execute("pragma table_info(threads)")}
            selected = [f for f in PROTECTED_THREAD_FIELDS if f in fields]
            for row in db.execute("select id," + ",".join(selected) + " from threads"):
                for field, value in zip(selected, row[1:]):
                    metadata.setdefault((row[0], field), set()).add(value)
    for (tid, field), values in metadata.items():
        if len(values) > 1:
            raise RuntimeError("Conflicting " + field + " values for thread " + tid)
    return paths, records, sources, metadata


def backup_database(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with connect(source) as src, sqlite3.connect(destination) as dest:
        src.backup(dest)
        if dest.execute("pragma quick_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite backup validation failed: " + str(source))


def prepare_backup(request, home, native, states, records):
    user_data = normalized(request["userData"])
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = user_data / "codex-storage-backups" / stamp
    backup.mkdir(parents=True)
    emit(phase="backup", backupPath=str(backup), total=len(records))
    databases = {}
    for directory in {p.parent for p in states} | {native}:
        for source in directory.glob("*.sqlite"):
            key = hashlib.sha256(str(source).encode()).hexdigest()[:24]
            destination = backup / "databases" / key / source.name
            backup_database(source, destination)
            databases[str(source)] = str(destination)
    copied, messages, signatures = {}, {}, {}
    for tid, source in records.items():
        if not source.is_file() or not source.is_relative_to(home):
            raise RuntimeError("Missing rollout or path outside the selected Codex home: " + tid)
        before = source.stat()
        dest = backup / "home" / source.relative_to(home)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
        after = source.stat()
        signature = (before.st_size, before.st_mtime_ns)
        if signature != (after.st_size, after.st_mtime_ns) or dest.stat().st_size != before.st_size:
            raise RuntimeError("A rollout changed during backup; stop its writer and retry: " + tid)
        expected = {"user": collections.Counter(), "assistant": collections.Counter()}
        primary = None
        with dest.open(encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                event = json.loads(line)
                payload = event.get("payload", {})
                if event.get("type") == "session_meta" and primary is None:
                    primary = payload.get("id") or payload.get("session_id")
                if event.get("type") == "event_msg" and payload.get("type") in ("user_message", "agent_message"):
                    text = payload.get("message", "")
                    if text:
                        role = "user" if payload["type"] == "user_message" else "assistant"
                        expected[role][fingerprint(text)] += 1
        if primary != tid:
            raise RuntimeError("The rollout's primary session ID differs from its index: " + tid)
        copied[tid], messages[tid], signatures[tid] = dest, expected, signature
    # Keep app mappings, configuration, transcripts and the prior mode. Do not
    # copy auth.json or silently overwrite any current settings during rollback.
    store = user_data / "party-store"
    if store.exists():
        shutil.copytree(store, backup / "party-store")
    for file in [user_data / "settings.json", user_data / "codex-storage.json", home / "config.toml"]:
        if file.exists():
            destination = backup / ("codex-config.toml" if file == home / "config.toml" else file.name)
            shutil.copyfile(file, destination)
    manifest = {"version": 1, "home": str(home), "native": str(native), "databases": databases,
                "threads": {tid: {"original": str(records[tid]), "copy": str(copied[tid]),
                                   "signature": signatures[tid]} for tid in records}}
    (backup / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return backup, databases, copied, messages, signatures


def legacy_messages(request, backup, databases, copied, source_files, tid):
    source = None
    latest_projection = -2
    for candidate in source_files:
        with connect(pathlib.Path(databases[str(candidate)])) as db:
            state = db.execute("select status from backfill_state").fetchone()
        if state and state[0] == "complete":
            projection = -1
            history_file = databases.get(str(candidate.parent / "thread_history_1.sqlite"))
            if history_file:
                with connect(pathlib.Path(history_file)) as history_db:
                    row = history_db.execute("select next_rollout_byte_offset from thread_history_projection_state where thread_id=?", (tid,)).fetchone()
                    if row:
                        projection = row[0]
            # Multiple legacy stores can have stale views of the same rollout.
            # Preserve the most advanced backed-up projection, not whichever
            # directory happened to sort first.
            if projection > latest_projection:
                source, latest_projection = candidate, projection
    if source is None:
        raise RuntimeError("No initialized baseline index is available to compare thread " + tid)
    original_backup = pathlib.Path(databases[str(source)])
    # Each comparison needs its own history cache. Reusing one while changing
    # rollout paths leaves Codex's persisted paginated-history entries stale.
    baseline = backup / "baseline" / (hashlib.sha256(str(source).encode()).hexdigest()[:16] + "-" + tid)
    baseline.mkdir(parents=True, exist_ok=True)
    dest = baseline / "state_5.sqlite"
    history = databases.get(str(source.parent / "thread_history_1.sqlite"))
    if not dest.exists():
        shutil.copyfile(original_backup, dest)
        if history:
            shutil.copyfile(history, baseline / "thread_history_1.sqlite")
        with sqlite3.connect(dest) as db:
            for row in db.execute("select id from threads").fetchall():
                location = copied.get(row[0], backup / "home" / "unavailable" / row[0])
                db.execute("update threads set rollout_path=? where id=?", (str(location), row[0]))
    baseline_home = baseline / "home"
    rollout = baseline_home / copied[tid].relative_to(backup / "home")
    rollout.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(copied[tid], rollout)
    with sqlite3.connect(dest) as db:
        db.execute("update threads set rollout_path=? where id=?", (str(rollout), tid))
    server = Server(request, backup / "baseline.stderr", baseline_home, baseline)
    try:
        with connect(dest) as db:
            paginated = db.execute("select history_mode from threads where id=?", (tid,)).fetchone()[0] == "paginated"
        # Paginated history is itself persisted state, including sub-agents
        # that Codex refuses to resume independently. Read its backed-up cache
        # when present; never omit it from the reference being preserved.
        cached = bool(history) and latest_projection >= 0
        return thread_messages(server.refresh(tid) if paginated and not cached else server.read(tid))
    finally:
        server.close()


def verify_conversation(server, directory, tid, expected, request, backup, databases, copied, sources):
    actual = thread_messages(server.read(tid))
    paginated = False
    for source in sources:
        with connect(pathlib.Path(databases[str(source)])) as db:
            fields = {r[1] for r in db.execute("pragma table_info(threads)")}
            if "history_mode" in fields and db.execute("select history_mode from threads where id=?", (tid,)).fetchone()[0] == "paginated":
                paginated = True
                break
    if actual == expected and not paginated:
        return actual, False, False
    reference = legacy_messages(request, backup, databases, copied, sources, tid)
    if actual == reference:
        return actual, True, False
    require_inactive_goal(directory, tid)
    refreshed = thread_messages(server.refresh(tid))
    if refreshed != reference:
        (backup / ("history-mismatch-" + tid + ".json")).write_text(json.dumps({
            "threadId": tid, "read": actual, "reference": reference, "refreshed": refreshed,
        }), encoding="utf-8")
        raise RuntimeError("Conversation content differs from the legacy API for thread " + tid)
    emit(phase="history-refreshed", threadId=tid)
    return refreshed, True, True


def verify_metadata(states, databases, native, metadata):
    with connect(native / "state_5.sqlite") as target:
        for (tid, field), values in metadata.items():
            row = target.execute('select "' + field + '" from threads where id=?', (tid,)).fetchone()
            if row is None or row[0] not in values:
                raise RuntimeError("Thread metadata was not preserved: " + tid + " / " + field)
        for source in states:
            with connect(pathlib.Path(databases[str(source)])) as db:
                for table in ("thread_spawn_edges", *AUXILIARY_TABLES):
                    if not rowset(db, table).issubset(rowset(target, table)):
                        raise RuntimeError("State requires a separately reviewed migration: " + table)
                if "thread_sections" in tables(db):
                    fields = {r[1] for r in db.execute("pragma table_info(thread_sections)")}
                    source_sections = set(db.execute("select id,name," + ("appearance" if "appearance" in fields else "null") + " from thread_sections"))
                    target_sections = set(target.execute("select id,name,appearance from thread_sections"))
                    if not source_sections.issubset(target_sections):
                        raise RuntimeError("Thread sections were not preserved.")
    for source, backup_file in databases.items():
        name = pathlib.Path(source).name
        selected = {"memories_1.sqlite": ("stage1_outputs", "jobs", "consolidation_progress"),
                    "queue_1.sqlite": ("queued_items",)}.get(name)
        if not selected:
            continue
        target_file = native / name
        with connect(pathlib.Path(backup_file)) as db:
            for table in selected:
                values = rowset(db, table)
                if not values:
                    continue
                if not target_file.exists():
                    raise RuntimeError("Nonempty state requires a separately reviewed migration: " + name + "/" + table)
                with connect(target_file) as target:
                    if not values.issubset(rowset(target, table)):
                        raise RuntimeError("Nonempty state requires a separately reviewed migration: " + name + "/" + table)


def legacy_targets(user_data):
    targets = []
    for file in (user_data / "party-store/.agent_party_app/parties").glob("*/party.json"):
        party = json.loads(file.read_text(encoding="utf-8-sig"))
        for member in party.get("members", []):
            location = member.get("location") or ""
            tid = member.get("harnessSessionId")
            if member.get("runtime") != "codex" or not tid or location.startswith(("wsl+", "ssh+")):
                continue
            scope = "desktop:party:" + file.parent.name + ":member:" + member["name"]
            digest = hashlib.sha256(scope.encode()).hexdigest()[:16]
            # The canonical helper retains this deterministic suffix. Prefer
            # the existing exact home, including already-created recovery homes.
            matches = list((user_data / "codex-sqlite").glob("*-" + digest))
            if matches:
                directory = matches[0]
            else:
                import unicodedata
                label = re.sub(r"[^a-zA-Z0-9_-]+", "-", unicodedata.normalize("NFKD", scope)).strip("-")[:40] or "runtime"
                directory = user_data / "codex-sqlite" / (label + "-" + digest)
            for _ in range(8):
                recovery = pathlib.Path(str(directory) + "-recovery")
                if not recovery.exists():
                    break
                directory = recovery
            targets.append((tid, directory))
    return targets


def run(request):
    if os.name != "nt":
        raise RuntimeError("This transition worker currently supports Windows only.")
    if sys.version_info < (3, 11):
        raise RuntimeError("Python 3.11+ is required for this one-time operation.")
    version = subprocess.run([request["command"], *request["args"], "--version"], capture_output=True,
                             text=True, check=True, creationflags=subprocess.CREATE_NO_WINDOW).stdout.strip()
    if version != SUPPORTED_VERSION:
        raise RuntimeError("Validate the installed Codex version before migrating: " + version)
    home, native = resolve_home(request)
    user_data = normalized(request["userData"])
    states, records, sources, metadata = inventory(user_data, native)
    for tid, _ in legacy_targets(user_data):
        if tid not in records:
            raise RuntimeError("A saved member has no indexed rollout: " + tid)
    backup, databases, copied, expected, signatures = prepare_backup(request, home, native, states, records)
    differences = []
    refreshed = set()
    verified = 0
    if request["mode"] == "native":
        server = Server(request, backup / "codex.stderr", home, native)
        try:
            with (backup / "verified.jsonl").open("w", encoding="utf-8") as journal:
                for tid in records:
                    actual, compared, rebuilt = verify_conversation(server, native, tid, expected[tid], request, backup, databases, copied, sources[tid])
                    if compared:
                        differences.append(tid)
                    if rebuilt:
                        refreshed.add(tid)
                    verified += 1
                    journal.write(json.dumps({"id": tid, "verified": True, "messages": actual}) + "\n")
                    journal.flush()
                    emit(phase="verify", verified=verified, total=len(records))
        finally:
            server.close()
        verify_metadata(states, databases, native, metadata)
    else:
        targets = legacy_targets(user_data)
        for tid, directory in targets:
            if tid not in records:
                raise RuntimeError("A saved member has no indexed rollout: " + tid)
            goals = directory / "goals_1.sqlite"
            if goals.exists():
                with connect(goals) as db:
                    if any(row[0] not in ("complete", "blocked", "paused", "usage_limited") for row in db.execute("select status from thread_goals")):
                        raise RuntimeError("Legacy rollback would restore an active goal. Stop that goal explicitly first.")
            directory.mkdir(parents=True, exist_ok=True)
            server = Server(request, backup / "codex.stderr", home, directory)
            try:
                _, compared, rebuilt = verify_conversation(server, directory, tid, expected[tid], request, backup, databases, copied, sources[tid])
                if compared:
                    differences.append(tid)
                if rebuilt:
                    refreshed.add(tid)
                verified += 1
                emit(phase="verify-rollback", verified=verified, total=len(targets))
            finally:
                server.close()
    for tid, source in records.items():
        info = source.stat()
        if (info.st_size, info.st_mtime_ns) != signatures[tid]:
            if tid not in refreshed:
                raise RuntimeError("A conversation changed while storage was being verified. Stop its writer and retry: " + tid)
            # Resume may append configuration metadata. Existing bytes must be
            # preserved exactly; no new conversation event may slip into this
            # maintenance window, even when it came from another process.
            with source.open("rb") as current, copied[tid].open("rb") as original:
                while chunk := original.read(1024 * 1024):
                    if current.read(len(chunk)) != chunk:
                        raise RuntimeError("A rollout changed before its append boundary: " + tid)
                for line in current:
                    if line.strip():
                        event = json.loads(line)
                        settings = event.get("type") == "event_msg" and event.get("payload", {}).get("type") == "thread_settings_applied"
                        if event.get("type") not in ("session_meta", "turn_context") and not settings:
                            raise RuntimeError("Unexpected conversation activity during history refresh: " + tid)
    report = {"version": 1, "mode": request["mode"], "codexVersion": version,
              "verified": verified, "inventory": len(records), "legacyApiComparisons": differences,
              "historyRefreshed": sorted(refreshed),
              "goals": "not merged; original DBs retained", "backupPath": str(backup)}
    report_file = backup / "report.json"
    report_file.write_text(json.dumps(report, indent=2), encoding="utf-8")
    emit(complete=True, phase="verified", verified=verified, backupPath=str(backup), reportPath=str(report_file))


if __name__ == "__main__":
    try:
        run(json.load(sys.stdin))
    except Exception as error:
        emit(error=str(error))
        sys.exit(1)
