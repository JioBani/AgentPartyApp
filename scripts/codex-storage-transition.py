"""One-time Windows storage transition. Runtime sessions do not depend on Python.

Codex owns the state index. The one-time worker also imports backed-up history
projections into a schema-compatible destination, in one SQLite transaction.
Original isolated DBs, rollout files and archive flags are retained. Normal
runtime never reads or writes Codex database schemas.
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
import contextlib
import contextvars
import stat
try:
    import tomllib
except ImportError:
    print(json.dumps({"error": "Python 3.11+ is required for this one-time storage operation."}), flush=True)
    sys.exit(1)

PROTECTED_THREAD_FIELDS = ("archived", "memory_mode", "thread_section_id", "section_position", "section_entered_at_ms")
AUXILIARY_TABLES = ("thread_dynamic_tools", "thread_attachments", "projects", "project_roots",
                    "project_idempotency_keys", "remote_control_enrollments", "external_agent_config_imports")
HISTORY_TABLES = ("thread_turns", "thread_items", "thread_realtime_items", "thread_history_projection_state")


def emit(**message):
    print(json.dumps(message, ensure_ascii=True), flush=True)


def normalized(value):
    return pathlib.Path(str(value).removeprefix("\\\\?\\")).resolve()


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def database(*args, **kwargs):
    return sqlite3.connect(*args, factory=ClosingConnection, **kwargs)


READ_COPY_CONNECTIONS = contextvars.ContextVar("read_copy_connections", default=None)


def connect(file):
    pool = READ_COPY_CONNECTIONS.get()
    if pool is not None:
        allowed, readers = pool
        if file in allowed:
            # Only frozen backup/read-copy files qualify. SQLite's normal context
            # manager ends a transaction without closing this scoped connection.
            if file not in readers:
                readers[file] = sqlite3.connect(file.as_uri() + "?mode=ro", uri=True, timeout=10)
                # Hundreds of stores must not each retain the default 2 MiB cache.
                readers[file].execute("pragma cache_size=-256")
            return readers[file]
    return database(file.as_uri() + "?mode=ro", uri=True, timeout=10)


@contextlib.contextmanager
def read_copy_connections(databases):
    """Reuse immutable source readers, then close all before scratch cleanup.

    Live destinations and later-created replay baselines are deliberately absent
    from this fixed allowlist. They retain independent, short-lived connections.
    """
    readers = {}
    token = READ_COPY_CONNECTIONS.set(({pathlib.Path(p) for p in databases.values()}, readers))
    try:
        yield
    finally:
        primary_error = sys.exc_info()[1]
        READ_COPY_CONNECTIONS.reset(token)
        failures = []
        for file, reader in readers.items():
            try:
                reader.close()
            except Exception as error:
                failures.append(str(file) + ": " + str(error))
        if failures:
            message = "Read-copy connections failed to close: " + "; ".join(failures)
            if primary_error is not None:
                message = str(primary_error) + "; " + message
            raise RuntimeError(message) from primary_error


def tables(db):
    return {r[0] for r in db.execute("select name from sqlite_master where type='table'")}


def rowset(db, table, excluded_threads=()):
    if table not in tables(db):
        return set()
    rows = set(db.execute('select * from "' + table + '"'))
    if excluded_threads:
        columns = [r[1] for r in db.execute('pragma table_info("' + table + '")')]
        references = [columns.index(r[3]) for r in db.execute('pragma foreign_key_list("' + table + '")')
                      if r[2] == "threads" and r[4] == "id"]
        if table == "thread_spawn_edges":
            # Codex 0.158 declares these relationships without SQL foreign keys.
            references.extend(columns.index(name) for name in ("parent_thread_id", "child_thread_id"))
        rows = {row for row in rows if not any(row[i] in excluded_threads for i in references)}
    return rows


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


def thread_history(thread):
    # Preserve ordering, tool calls/results, images and other non-text items,
    # not just a multiset of user/assistant strings.
    return [{key: turn.get(key) for key in ("id", "status", "error", "items")}
            for turn in thread.get("turns", [])]


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
        # The helper joins its own Job Object before launching Codex. Even when
        # Codex exits normally, remaining Git/plugin descendants die with that
        # helper instead of continuing to write into a baseline being removed.
        self.child = subprocess.Popen([sys.executable, "-B", str(pathlib.Path(__file__).resolve()), "--server"],
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
            command = [request["command"], *request["args"], "app-server"]
            self.child.stdin.write(json.dumps({"command": command}) + "\n")
            self.child.stdin.flush()
            ready = self.wait_response(initializing=True)
            if ready.get("error"):
                raise RuntimeError(str(ready["error"]["message"]))
            if ready != {"id": 0, "result": {"serverReady": True}}:
                raise RuntimeError("Codex process helper stopped before startup.")
            self.call("initialize", {"clientInfo": {"name": "agentparty-storage-transition", "version": "1"},
                                     "capabilities": {"experimentalApi": True}})
            self.child.stdin.write(json.dumps({"method": "initialized", "params": {}}) + "\n")
            self.child.stdin.flush()
        except Exception:
            self.close()
            raise

    def wait_response(self, initializing=False):
        while True:
            try:
                return self.responses.get(timeout=300)
            except queue.Empty as error:
                if not initializing:
                    raise RuntimeError("Codex did not answer within 300 seconds; inspect the preserved worker log.") from error
                emit(phase="initialize-slow", warning="Codex initialization is still running. Waiting without terminating its SQLite backfill.")

    def call(self, method, params):
        self.sequence += 1
        self.child.stdin.write(json.dumps({"id": self.sequence, "method": method, "params": params}) + "\n")
        self.child.stdin.flush()
        response = self.wait_response(initializing=method == "initialize")
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

    def refresh(self, tid, staging_overrides=None):
        # Paginated threads can have a stale/absent history DB after changing
        # storage. Codex's own resume rebuilds it from the rollout without a
        # model turn. Overrides are used only by the private baseline replay.
        thread = self.call("thread/resume", {"threadId": tid, **(staging_overrides or {})})["thread"]
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


def inventory(user_data, native, home=None, excluded=None):
    excluded = excluded if excluded is not None else {}
    referenced = {tid for tid, _ in legacy_targets(user_data)}
    paths = sorted((user_data / "codex-sqlite").glob("*/state_*.sqlite"))
    if (native / "state_5.sqlite").exists():
        paths.append(native / "state_5.sqlite")
    records, sources, metadata, locations = {}, {}, {}, {}
    for file in paths:
        if file.name != "state_5.sqlite":
            raise RuntimeError("An unvalidated state DB version was found: " + str(file))
        with connect(file) as db:
            for tid, rollout in db.execute("select id, rollout_path from threads"):
                location = normalized(rollout)
                locations.setdefault(tid, set()).add(location)
                sources.setdefault(tid, []).append(file)
            fields = {r[1] for r in db.execute("pragma table_info(threads)")}
            selected = [f for f in PROTECTED_THREAD_FIELDS if f in fields]
            for row in db.execute("select id," + ",".join(selected) + " from threads"):
                for field, value in zip(selected, row[1:]):
                    metadata.setdefault((row[0], field), set()).add(value)
    for tid, candidates in locations.items():
        existing = set()
        for location in candidates:
            try:
                info = location.stat()
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError("Rollout path is not a regular file: " + str(location))
            existing.add(location)
        if not existing and tid not in referenced:
            if not home or any(not location.is_relative_to(home) for location in candidates):
                raise RuntimeError("Missing rollout outside the selected Codex home requires a separate path review: " + tid)
            for location in candidates:
                category = location.relative_to(home).parts[0]
                if category not in ("sessions", "archived_sessions"):
                    raise RuntimeError("Missing rollout has an unvalidated directory: " + str(location))
                root = home / category
                if not root.is_dir():
                    raise RuntimeError("Rollout root is unavailable; no missing conversations may be excluded: " + str(root))
                # Force an actual directory read: an inaccessible/offline mount
                # must not be interpreted as a set of deleted conversations.
                with os.scandir(root) as entries:
                    next(entries, None)
            # No member can resume this absent rollout. Preserve all source
            # DBs/caches in the backup; never resurrect deleted cached content.
            excluded[tid] = sorted(str(p) for p in candidates)
            sources.pop(tid, None)
            emit(phase="missing-unreferenced-rollout", threadId=tid)
            continue
        if not existing:
            raise missing_member_error(user_data, tid)
        if len(candidates) == 1:
            records[tid] = next(iter(candidates))
        elif len(existing) == 1:
            # Codex archive/unarchive moves the same rollout. An old isolated
            # index can retain its now-missing path. Never choose between two
            # existing files or discard metadata other than that derived flag.
            records[tid] = next(iter(existing))
            emit(phase="stale-index-resolved", threadId=tid, missingPaths=len(candidates) - 1)
        else:
            raise RuntimeError("Conflicting rollout paths for thread " + tid + "; expected exactly one existing file. Original indexes were not changed.")
        parts = records[tid].relative_to(home).parts if home and records[tid].is_relative_to(home) else ()
        if records[tid].is_file() and parts and parts[0] in ("archived_sessions", "sessions"):
            archived = int(parts[0] == "archived_sessions")
            old = metadata.get((tid, "archived"))
            if old and old != {archived}:
                emit(phase="stale-archive-index-resolved", threadId=tid, archived=archived)
                metadata[(tid, "archived")] = {archived}
    metadata = {key: values for key, values in metadata.items() if key[0] not in excluded}
    for (tid, field), values in metadata.items():
        if len(values) > 1:
            raise RuntimeError("Conflicting " + field + " values for thread " + tid)
    return paths, records, sources, metadata


def backup_database(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with connect(source) as src, database(destination) as dest:
        src.backup(dest)
        if dest.execute("pragma quick_check").fetchone()[0] != "ok":
            raise RuntimeError("SQLite backup validation failed: " + str(source))


def preflight_space(request, home, native, states, records):
    """Conservative peak estimate before creating backups or opening a writer.

    Keep a reserve for the OS and unrelated writers. This is a preflight, not
    a promise about other processes: subsequent I/O errors remain visible.
    """
    directories = {p.parent for p in states} | {native}
    db_bytes = sum(p.stat().st_size for d in directories for p in d.glob("*.sqlite*") if not p.name.startswith("logs_"))
    rollout_bytes = sum(p.stat().st_size for p in set(records.values()) if p.is_file())
    user_data = normalized(request["userData"])
    app_bytes = sum(p.stat().st_size for p in (user_data / "party-store").rglob("*") if p.is_file())
    # Immutable backup + upgraded read copies + rebuild/import/SQLite WAL
    # headroom. Baselines are per-thread and released after each comparison.
    required = 4 * db_bytes + 3 * rollout_bytes + app_bytes
    reserve = 5 * 1024**3
    volumes = {user_data.anchor: user_data, native.anchor: native, home.anchor: home}
    for directory in volumes.values():
        existing = directory
        while not existing.exists():
            existing = existing.parent
        free = shutil.disk_usage(existing).free
        if free < required + reserve:
            raise RuntimeError(f"Insufficient free space on {directory.anchor}: need an estimated {required + reserve} bytes including reserve; available {free}. No storage files have been changed.")
    emit(phase="space-checked", estimatedPeakBytes=required, reserveBytes=reserve)


def remove_scratch(backup, directory):
    """Delete only owned transient copies; immutable backup and reports remain."""
    root = normalized(backup)
    target = normalized(directory)
    if target == root or not target.is_relative_to(root) or directory.is_symlink():
        raise RuntimeError("Refusing to remove scratch outside the backup: " + str(directory))

    def remove_readonly_file(function, filename, error_info):
        error = error_info[1]
        path = pathlib.Path(filename)
        # Git leaves read-only pack/index files in disposable plugin clones.
        # Clear only that file attribute, never ACLs or permissions on backups.
        info = path.lstat()
        if (os.name == "nt" and isinstance(error, PermissionError)
                and function in (os.unlink, os.remove)
                and normalized(path).is_relative_to(target)
                and stat.S_ISREG(info.st_mode)
                and info.st_nlink == 1
                and not info.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
                and info.st_file_attributes & stat.FILE_ATTRIBUTE_READONLY):
            path.chmod(stat.S_IWRITE)
            function(filename)
        else:
            raise error

    if directory.exists():
        # Exited Codex/Git processes and file scanners can briefly retain handles.
        # Access denied may also be transient; persistent ACL errors still fail.
        for attempt in range(20):
            try:
                shutil.rmtree(directory, onerror=remove_readonly_file)
                break
            except OSError as error:
                if getattr(error, "winerror", None) not in (5, 32, 145) or attempt == 19:
                    raise
                time.sleep(0.25)


def cleanup_scratch(backup):
    for name in ("baseline", "read-copies"):
        remove_scratch(backup, backup / name)


def prepare_backup(request, home, native, states, records):
    user_data = normalized(request["userData"])
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = user_data / "codex-storage-backups" / stamp
    backup.mkdir(parents=True)
    emit(phase="backup", backupPath=str(backup), total=len(records))
    databases = {}
    for directory in {p.parent for p in states} | {native}:
        for source in directory.glob("*.sqlite"):
            if source.name.startswith("logs_"):
                continue  # Diagnostic logs carry no conversation/session state.
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


def history_schema(db):
    # Never guess how to merge a future Codex schema. Indexes, triggers, table
    # definitions and migration checksums must all match the installed CLI.
    names = tables(db)
    if names != {*HISTORY_TABLES, "_sqlx_migrations"}:
        raise RuntimeError("Unvalidated Codex history tables: " + repr(sorted(names)))
    return (set(db.execute("select type,name,tbl_name,sql from sqlite_master where name not like 'sqlite_%'")),
            set(db.execute("select version,description,success,checksum from _sqlx_migrations")))


def prepare_read_copies(request, backup, databases, states, copied):
    """Let the installed Codex upgrade private DB copies, preserving backups.

    Legacy directories can contain schemas from several CLI releases. We do
    not translate those schemas ourselves or maintain a CLI version allowlist.
    Initialization runs against a separate private home, with index paths pointed
    inside that home, so it cannot reach operational rollouts. Later history
    baselines supply the actual copied rollout for the thread they read.
    """
    readable = dict(databases)
    for state in states:
        directory = backup / "read-copies" / hashlib.sha256(str(state.parent).encode()).hexdigest()[:24]
        home = directory / "home"
        home.mkdir(parents=True)
        original = pathlib.Path(databases[str(state)])
        dest = directory / state.name
        backup_database(original, dest)
        history = state.parent / "thread_history_1.sqlite"
        if str(history) in databases:
            backup_database(pathlib.Path(databases[str(history)]), directory / history.name)
        with database(dest) as db:
            ids = {r[0] for r in db.execute("select id from threads")}
            included = ids.intersection(copied)
            for tid in included:
                location = home / copied[tid].relative_to(backup / "home")
                category = copied[tid].relative_to(backup / "home").parts[0]
                if category in ("sessions", "archived_sessions"):
                    db.execute("update threads set rollout_path=?,archived=? where id=?", (str(location), int(category == "archived_sessions"), tid))
                else:
                    db.execute("update threads set rollout_path=? where id=?", (str(location), tid))
            paginated = [r[0] for r in db.execute("select id from threads where history_mode='paginated'") if r[0] in included]
        # Some Codex releases initialize the history database lazily, on the
        # first history read. Supply one real copied rollout to trigger that
        # official path, rather than applying Codex's SQL migrations ourselves.
        seed = min(paginated or included, key=lambda tid: copied[tid].stat().st_size) if included else None
        if seed:
            rollout = home / copied[seed].relative_to(backup / "home")
            rollout.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(copied[seed], rollout)
        server = Server(request, backup / "schema-upgrade.stderr", home, directory)
        try:
            if seed:
                server.read(seed)
        finally:
            server.close()
        with connect(dest) as db:
            if {r[0] for r in db.execute("select id from threads")} != ids:
                raise RuntimeError("Codex changed the thread inventory while preparing a read copy: " + str(state))
            if db.execute("pragma quick_check").fetchone()[0] != "ok":
                raise RuntimeError("Codex could not prepare a valid read copy: " + str(state))
        readable[str(state)] = str(dest)
        if (directory / history.name).exists():
            readable[str(history)] = str(directory / history.name)
    emit(phase="read-copies-prepared", count=len(states))
    return readable


def history_rows(db, tid):
    return {table: set(db.execute('select * from "' + table + '" where thread_id=?', (tid,)))
            for table in HISTORY_TABLES}


def copy_thread_history(source, destination, tid):
    """Copy one thread under the exact original schema, including committed WAL.

    A whole-store backup per thread multiplies storage by the thread count.
    The immutable whole-store backup already exists; disposable API baselines
    need only this thread. No Codex schema translation happens here.
    """
    with connect(source) as src, database(destination) as dest:
        expected_schema = history_schema(src)
        definitions = list(src.execute("select type,sql from sqlite_master where sql is not null and name not like 'sqlite_%'"))
        for kind, sql in definitions:
            if kind == "table":
                dest.execute(sql)
        for table in ("_sqlx_migrations", *HISTORY_TABLES):
            query = 'select * from "' + table + '"'
            cursor = src.execute(query) if table == "_sqlx_migrations" else src.execute(query + " where thread_id=?", (tid,))
            marks = ",".join("?" for _ in cursor.description)
            dest.executemany('insert into "' + table + '" values (' + marks + ')', cursor)
        for kind, sql in definitions:
            if kind != "table":
                dest.execute(sql)
        if history_schema(dest) != expected_schema or history_rows(src, tid) != history_rows(dest, tid):
            raise RuntimeError("Thread baseline copy differs from its source: " + tid)
        if dest.execute("pragma quick_check").fetchone()[0] != "ok" or dest.execute("pragma foreign_key_check").fetchone():
            raise RuntimeError("Thread baseline copy failed integrity checks: " + tid)


def restore_history_cache(directory, tids, databases, sources, records):
    """Import complete per-thread projections, never archive/unarchive a rollout.

    All app-servers are closed by the caller. Inputs are consistent backups;
    only the selected destination history DB is writable. SQLite rolls back
    the entire import on failure or process termination. This is deliberately
    outside the adapter and verifies the actual source/destination schemas.
    """
    if not tids:
        return []  # A fresh home has no lazily-created history DB yet.
    destination = directory / "thread_history_1.sqlite"
    if not destination.exists():
        raise RuntimeError("Codex did not initialize its history database: " + str(destination))
    imported = []
    with database(destination.as_uri() + "?mode=rw", uri=True, timeout=10) as target:
        target.execute("pragma foreign_keys=on")
        target.execute("begin immediate")
        schema = history_schema(target)
        for tid in tids:
            cursor, selected = -1, None
            for state in sources[tid]:
                file = databases.get(str(state.parent / destination.name))
                if not file:
                    continue
                with connect(pathlib.Path(file)) as source:
                    if history_schema(source) != schema:
                        raise RuntimeError("Codex history schema differs: " + str(state.parent))
                    row = source.execute("select next_rollout_byte_offset from thread_history_projection_state where thread_id=?", (tid,)).fetchone()
                    if not row:
                        # Realtime history without a projection cursor cannot
                        # be ordered safely against another store.
                        if any(history_rows(source, tid).values()):
                            raise RuntimeError("History has no projection cursor: " + tid)
                        continue
                    if row[0] < 0 or row[0] > records[tid].stat().st_size:
                        raise RuntimeError("History cursor is outside its rollout: " + tid)
                    if row[0] < cursor:
                        continue
                    rows = history_rows(source, tid)
                    if row[0] == cursor and selected != rows:
                        raise RuntimeError("Conflicting history at the same rollout position: " + tid)
                    cursor, selected = row[0], rows
            if selected is None:
                continue
            current = history_rows(target, tid)
            if current == selected:
                continue
            existing = target.execute("select next_rollout_byte_offset from thread_history_projection_state where thread_id=?", (tid,)).fetchone()
            if existing and existing[0] >= cursor:
                raise RuntimeError("Destination history changed after backup: " + tid)
            # A later projection can update an item, but must not lose IDs
            # already visible in the destination (including tool/image items).
            for table in ("thread_turns", "thread_items", "thread_realtime_items"):
                columns = list(target.execute('pragma table_info("' + table + '")'))
                keys = [i for i, column in enumerate(columns) if column[5]]
                if not keys:
                    raise RuntimeError("History table has no primary key: " + table)
                identities = lambda rows: {tuple(row[i] for i in keys) for row in rows}
                if not identities(current[table]).issubset(identities(selected[table])):
                    raise RuntimeError("Source history would remove existing items: " + tid)
            for table in reversed(HISTORY_TABLES):
                target.execute('delete from "' + table + '" where thread_id=?', (tid,))
            for table in HISTORY_TABLES:
                rows = selected[table]
                if rows:
                    marks = ','.join('?' for _ in next(iter(rows)))
                    target.executemany('insert into "' + table + '" values (' + marks + ')', rows)
            if history_rows(target, tid) != selected:
                raise RuntimeError("History import verification failed: " + tid)
            imported.append(tid)
        if target.execute("pragma quick_check").fetchone()[0] != "ok" or target.execute("pragma foreign_key_check").fetchone():
            raise RuntimeError("History database integrity verification failed")
    if imported:
        emit(phase="history-imported", count=len(imported))
    return imported


def baseline_thread(request, backup, databases, copied, source_files, tid):
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
        # Read copies and rebuilt baselines may retain committed pages in WAL
        # even after Codex exits. Never copy only the SQLite main file.
        backup_database(original_backup, dest)
        if history:
            copy_thread_history(pathlib.Path(history), baseline / "thread_history_1.sqlite", tid)
        with database(dest) as db:
            for row in db.execute("select id from threads").fetchall():
                location = copied.get(row[0], backup / "home" / "unavailable" / row[0])
                db.execute("update threads set rollout_path=? where id=?", (str(location), row[0]))
    baseline_home = baseline / "home"
    rollout = baseline_home / copied[tid].relative_to(backup / "home")
    rollout.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(copied[tid], rollout)
    with database(dest) as db:
        db.execute("update threads set rollout_path=? where id=?", (str(rollout), tid))
    server = Server(request, backup / "baseline.stderr", baseline_home, baseline)
    try:
        with connect(dest) as db:
            paginated = db.execute("select history_mode from threads where id=?", (tid,)).fetchone()[0] == "paginated"
        # Existing cache is authoritative. Rebuild absent cache only on this
        # private copy; operational archive flags and rollouts never change.
        # A first read can create an empty cursor at zero. That is not a
        # preserved history projection and must not suppress reconstruction.
        cached = bool(history) and latest_projection > 0
        rebuild = paginated and not cached
        if rebuild:
            with connect(dest) as db:
                archived = bool(db.execute("select archived from threads where id=?", (tid,)).fetchone()[0])
            if archived:
                server.call("thread/unarchive", {"threadId": tid})
            try:
                # Replay never starts a model turn. A private baseline need
                # not recreate retired/custom provider credentials just to
                # parse history. This override changes only the copied index
                # and appended settings, never the user's provider/config.
                emit(phase="staged-history-rebuild", threadId=tid, provider="openai", modelTurns=False)
                thread = server.refresh(tid, {"modelProvider": "openai", "approvalPolicy": "never", "sandbox": "read-only"})
            finally:
                if archived:
                    server.call("thread/archive", {"threadId": tid})
        else:
            thread = server.read(tid)
    finally:
        server.close()
    if rebuild:
        trim_staging_projection(baseline, rollout, copied[tid], tid)
    return thread, baseline


def trim_staging_projection(baseline, rollout, original, tid):
    # Resume appends settings metadata to the private rollout. Imported cache
    # must stop at the ORIGINAL byte/ordinal boundary, otherwise a later live
    # turn could be skipped. Permit only metadata and prove no projected item
    # refers to those extra bytes before resetting the private cursor.
    lines, appended = 0, 0
    with original.open("rb") as before, rollout.open("rb") as after:
        for line in before:
            lines += 1
            if after.read(len(line)) != line:
                raise RuntimeError("Staged history rebuild changed original bytes: " + tid)
        for line in after:
            appended += 1
            if not line.strip():
                continue
            event = json.loads(line)
            settings = event.get("type") == "event_msg" and event.get("payload", {}).get("type") == "thread_settings_applied"
            if event.get("type") not in ("session_meta", "turn_context") and not settings:
                raise RuntimeError("Staged history rebuild added conversation activity: " + tid)
    size = original.stat().st_size
    with database(baseline / "thread_history_1.sqlite") as db:
        projection = db.execute("select next_rollout_byte_offset,next_rollout_ordinal from thread_history_projection_state where thread_id=?", (tid,)).fetchone()
        if projection != (rollout.stat().st_size, lines + appended):
            raise RuntimeError("Staged rebuild did not project the complete rollout with the expected ordinal boundary: " + tid)
        for table in HISTORY_TABLES[:-1]:
            columns = [r[1] for r in db.execute('pragma table_info("' + table + '")')]
            for column in columns:
                limit = size if column.endswith("byte_offset") else lines if column.endswith("ordinal") else None
                if limit is not None and db.execute('select 1 from "' + table + '" where thread_id=? and "' + column + '">? limit 1', (tid, limit)).fetchone():
                    raise RuntimeError("Staged projected history extends past original rollout: " + tid)
        changed = db.execute("update thread_history_projection_state set next_rollout_byte_offset=?,next_rollout_ordinal=? where thread_id=?", (size, lines, tid))
        if changed.rowcount != 1:
            raise RuntimeError("Staged rebuild did not create a history projection: " + tid)


def legacy_thread(request, backup, databases, copied, source_files, tid):
    thread, baseline = baseline_thread(request, backup, databases, copied, source_files, tid)
    remove_scratch(backup, baseline)
    return thread


def rebuild_missing_history(request, backup, databases, copied, sources):
    rebuilt = []
    for tid, candidates in sources.items():
        paginated, cached = False, False
        for state in candidates:
            with connect(pathlib.Path(databases[str(state)])) as db:
                paginated |= db.execute("select history_mode from threads where id=?", (tid,)).fetchone()[0] == "paginated"
            history = databases.get(str(state.parent / "thread_history_1.sqlite"))
            if history:
                with connect(pathlib.Path(history)) as db:
                    cached |= db.execute("select 1 from thread_history_projection_state where thread_id=? and next_rollout_byte_offset>0", (tid,)).fetchone() is not None
        if paginated and not cached:
            _, baseline = baseline_thread(request, backup, databases, copied, candidates, tid)
            state = baseline / "state_5.sqlite"
            databases[str(state)] = str(state)
            history = baseline / "thread_history_1.sqlite"
            databases[str(history)] = str(history)
            candidates.append(state)
            rebuilt.append(tid)
            emit(phase="staged-history-rebuilt", threadId=tid)
    return rebuilt


def verify_conversation(server, directory, tid, expected, request, backup, databases, copied, sources):
    actual_thread = server.read(tid)
    actual = thread_messages(actual_thread)
    # Compare ordered API history for ordinary threads too. Matching only
    # user/assistant text cannot detect missing tools, images or ordering.
    reference_thread = legacy_thread(request, backup, databases, copied, sources, tid)
    reference = thread_messages(reference_thread)
    if actual == reference and thread_history(actual_thread) == thread_history(reference_thread):
        return actual, True, False
    require_inactive_goal(directory, tid)
    refreshed_thread = server.refresh(tid)
    refreshed = thread_messages(refreshed_thread)
    if refreshed != reference or thread_history(refreshed_thread) != thread_history(reference_thread):
        (backup / ("history-mismatch-" + tid + ".json")).write_text(json.dumps({
            "threadId": tid, "read": actual, "reference": reference, "refreshed": refreshed,
        }), encoding="utf-8")
        raise RuntimeError("Conversation content differs from the legacy API for thread " + tid)
    emit(phase="history-refreshed", threadId=tid)
    return refreshed, True, True


def index_signature(directory):
    file = directory / "state_5.sqlite"
    if not file.is_file():
        raise RuntimeError("Codex index is missing: " + str(file))
    with connect(file) as db:
        if "backfill_state" not in tables(db):
            raise RuntimeError("Codex index has no validated backfill state: " + str(file))
        statuses = list(db.execute("select status from backfill_state"))
        if not statuses or any(row[0] != "complete" for row in statuses):
            raise RuntimeError("Codex index is not complete. No live initialization was started. Complete or explicitly recover this index with Codex before retrying: " + str(file))
        return set(db.execute("select version,description,success,checksum from _sqlx_migrations"))


def require_ready_index(directory, databases):
    reference = databases.get(str(directory / "state_5.sqlite"))
    if not reference or index_signature(directory) != index_signature(pathlib.Path(reference).parent):
        raise RuntimeError("Codex index needs an official schema upgrade before storage transition. Run Codex with this store and retry: " + str(directory))


def prepare_index(request, backup, home, directory, databases):
    if not (directory / "state_5.sqlite").exists():
        require_absent_index_sidecars(directory)
        if list(directory.glob("state_*.sqlite")):
            raise RuntimeError("An existing Codex index version needs an official upgrade: " + str(directory))
        # Codex indexes real rollout paths into disposable SQLite storage.
        # A worker crash can only strand this private index, never a live one.
        stage = backup / "read-copies" / ("bootstrap-" + hashlib.sha256(str(directory).encode()).hexdigest()[:24])
        stage.mkdir(parents=True)
        server = Server(request, backup / "bootstrap.stderr", home, stage)
        server.close()
        index_signature(stage)
        directory.mkdir(parents=True, exist_ok=True)
        temporary = directory / (".agentparty-state-" + backup.name + ".sqlite")
        backup_database(stage / "state_5.sqlite", temporary)
        require_absent_index_sidecars(directory)
        # Windows rename refuses an existing destination. Never overwrite an
        # index created concurrently by an external CLI/IDE.
        os.rename(temporary, directory / "state_5.sqlite")
        databases[str(directory / "state_5.sqlite")] = str(stage / "state_5.sqlite")
        emit(phase="index-published", directory=str(directory))
    require_ready_index(directory, databases)


def require_absent_index_sidecars(directory):
    if any((directory / ("state_5.sqlite" + suffix)).exists() for suffix in ("-wal", "-shm", "-journal")):
        raise RuntimeError("Codex index sidecars remain without a database. Preserve them for recovery; no replacement index was published: " + str(directory))


def live_server(request, backup, home, directory, databases):
    # Each live launch requires an already-complete, current-schema index.
    # The worker's crash Job Object must never kill a live backfill.
    require_ready_index(directory, databases)
    return Server(request, backup / "codex.stderr", home, directory)


def prepare_destination(request, backup, home, directory, tids, databases, sources, records):
    prepare_index(request, backup, home, directory, databases)
    server = live_server(request, backup, home, directory, databases)
    try:
        # Official API locates and indexes rollouts, including archived ones.
        for tid in tids:
            server.read(tid)
    finally:
        server.close()
    return restore_history_cache(directory, tids, databases, sources, records)


def verify_metadata(states, databases, native, metadata, excluded_threads=()):
    with connect(native / "state_5.sqlite") as target:
        for (tid, field), values in metadata.items():
            row = target.execute('select "' + field + '" from threads where id=?', (tid,)).fetchone()
            if row is None or row[0] not in values:
                raise RuntimeError("Thread metadata was not preserved: " + tid + " / " + field)
        for source in states:
            with connect(pathlib.Path(databases[str(source)])) as db:
                for table in ("thread_spawn_edges", *AUXILIARY_TABLES):
                    if not rowset(db, table, excluded_threads).issubset(rowset(target, table)):
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


def missing_member_error(user_data, tid):
    owners = []
    for file in (user_data / "party-store/.agent_party_app/parties").glob("*/party.json"):
        party = json.loads(file.read_text(encoding="utf-8-sig"))
        owners.extend(file.parent.name + "/" + str(member.get("name"))
                      for member in party.get("members", []) if member.get("harnessSessionId") == tid)
    return RuntimeError("A saved member has no indexed rollout: " + tid + "; members: " + ", ".join(owners) +
                        ". Restore the Codex rollout/index, or explicitly disconnect this member's Codex thread with expectedThreadId and confirm=true. Its AgentParty transcript will be retained.")


def run(request):
    if os.name != "nt":
        raise RuntimeError("This transition worker currently supports Windows only.")
    if sys.version_info < (3, 11):
        raise RuntimeError("Python 3.11+ is required for this one-time operation.")
    # Informational only: no CLI release allowlist or version comparison.
    version = subprocess.run([request["command"], *request["args"], "--version"], capture_output=True,
                             text=True, creationflags=subprocess.CREATE_NO_WINDOW).stdout.strip()
    home, native = resolve_home(request)
    user_data = normalized(request["userData"])
    excluded = {}
    states, records, sources, metadata = inventory(user_data, native, home, excluded)
    requested_exclusions = request.get("excludeMissingThreadIds", [])
    if not isinstance(requested_exclusions, list) or any(not isinstance(tid, str) for tid in requested_exclusions):
        raise RuntimeError("excludeMissingThreadIds must be an explicit array of thread IDs.")
    if excluded:
        emit(phase="missing-rollout-review", excludedMissing=len(excluded), missingRollouts=excluded)
    if set(requested_exclusions) != set(excluded):
        raise RuntimeError("Missing unreferenced rollout files require explicit review. Check that storage is online, then retry with excludeMissingThreadIds containing exactly these IDs: " + json.dumps(sorted(excluded)))
    for tid, _ in legacy_targets(user_data):
        if tid not in records:
            raise missing_member_error(user_data, tid)
    destinations = [native] if request["mode"] == "native" else [directory for _, directory in legacy_targets(user_data)]
    for directory in destinations:
        if (directory / "state_5.sqlite").exists():
            index_signature(directory)  # Reject incomplete live indexes before any backup/writer.
    preflight_space(request, home, native, states, records)
    backup, databases, copied, expected, signatures = prepare_backup(request, home, native, states, records)
    try:
        run_verified(request, version, home, native, user_data, states, records, sources, metadata,
                     backup, databases, copied, expected, signatures, excluded)
    except Exception as failure:
        try:
            cleanup_scratch(backup)
        except Exception as cleanup_failure:
            raise RuntimeError(f"Storage verification failed: {failure}; scratch cleanup also failed: {cleanup_failure}") from failure
        raise
    else:
        cleanup_scratch(backup)


def run_verified(request, version, home, native, user_data, states, records, sources, metadata,
                 backup, databases, copied, expected, signatures, excluded):
    databases = prepare_read_copies(request, backup, databases, states, copied)
    with read_copy_connections(databases):
        return verify_prepared_copies(request, version, home, native, user_data, states, records,
                                      sources, metadata, backup, databases, copied, expected,
                                      signatures, excluded)


def verify_prepared_copies(request, version, home, native, user_data, states, records, sources,
                          metadata, backup, databases, copied, expected, signatures, excluded):
    staged = rebuild_missing_history(request, backup, databases, copied, sources)
    differences = []
    refreshed = set()
    imported = []
    verified = 0
    if request["mode"] == "native":
        imported.extend(prepare_destination(request, backup, home, native, records, databases, sources, records))
        server = live_server(request, backup, home, native, databases)
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
        verify_metadata(states, databases, native, metadata, excluded)
    else:
        targets = legacy_targets(user_data)
        for tid, directory in targets:
            if tid not in records:
                raise missing_member_error(user_data, tid)
            goals = directory / "goals_1.sqlite"
            if goals.exists():
                with connect(goals) as db:
                    if any(row[0] not in ("complete", "blocked", "paused", "usage_limited") for row in db.execute("select status from thread_goals")):
                        raise RuntimeError("Legacy rollback would restore an active goal. Stop that goal explicitly first.")
            directory.mkdir(parents=True, exist_ok=True)
            imported.extend(prepare_destination(request, backup, home, directory, [tid], databases, sources, records))
            server = live_server(request, backup, home, directory, databases)
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
              "historyImported": sorted(set(imported)),
              "stagedHistoryRebuilt": staged,
              "missingUnreferencedRollouts": excluded,
              "goals": "not merged; original DBs retained", "backupPath": str(backup)}
    report_file = backup / "report.json"
    report_file.write_text(json.dumps(report, indent=2), encoding="utf-8")
    emit(complete=True, phase="verified", verified=verified, excludedMissing=len(excluded), missingRollouts=excluded, backupPath=str(backup), reportPath=str(report_file))


def own_worker_process_tree():
    """An OS Job Object kills orphaned Codex children if this worker crashes.

    The handle is deliberately retained until process exit; closing it earlier
    would also terminate this worker. Assignment precedes all child launches.
    """
    import ctypes
    from ctypes import wintypes

    class Limits(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
                    ("flags", wintypes.DWORD), ("min_working", ctypes.c_size_t),
                    ("max_working", ctypes.c_size_t), ("processes", wintypes.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD),
                    ("scheduling", wintypes.DWORD)]

    class Extended(ctypes.Structure):
        _fields_ = [("limits", Limits), ("io", ctypes.c_ulonglong * 6),
                    ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                    ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    limits = Extended()
    limits.limits.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        raise ctypes.WinError(ctypes.get_last_error())
    return handle


def run_server_process():
    """Launch after Job assignment, with a handshake before inheriting stdin.

    Only the launch header is in the pipe when readline runs. The parent waits
    for serverReady before sending RPC, so Python cannot prefetch Codex input.
    This process's exit closes its Job and terminates surviving descendants.
    """
    header = json.loads(sys.stdin.buffer.readline())
    child = subprocess.Popen(header["command"], stdin=sys.stdin, stdout=sys.stdout,
                             stderr=sys.stderr, creationflags=subprocess.CREATE_NO_WINDOW)
    emit(id=0, result={"serverReady": True})
    return child.wait()


@contextlib.contextmanager
def worker_lock(file):
    import msvcrt
    file.parent.mkdir(parents=True, exist_ok=True)
    # No replace/unlink: both apps must inspect the same OS-locked file.
    with file.open("a+b", buffering=0) as lock:
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise RuntimeError("Another Codex storage worker holds the maintenance lock.") from error
        try:
            if file.stat().st_size == 0:
                lock.write(b"1")
            yield
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


if __name__ == "__main__":
    try:
        worker_job_handle = own_worker_process_tree() if os.name == "nt" else None
        if sys.argv[1:] == ["--server"]:
            sys.exit(run_server_process())
        elif len(sys.argv) == 3 and sys.argv[1] == "--lock":
            lock_file = normalized(sys.argv[2])
            with worker_lock(lock_file):
                emit(locked=True)
                request = json.load(sys.stdin)
                if lock_file != normalized(request["userData"]) / "codex-storage.lock":
                    raise RuntimeError("Worker lock does not match the requested user data directory.")
                run(request)
        elif len(sys.argv) == 1:
            run(json.load(sys.stdin))
        else:
            raise RuntimeError("Unexpected storage worker arguments.")
    except Exception as error:
        if sys.argv[1:] == ["--server"]:
            emit(id=0, error={"message": str(error)})
        else:
            emit(error=str(error))
        sys.exit(1)
