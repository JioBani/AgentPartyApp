"""Real SQLite/Windows handle checks for frozen migration source readers.

This is a worker regression/performance probe, not product E2E.
"""
import importlib.util
import pathlib
import sqlite3
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("worker", ROOT / "scripts/codex-storage-transition.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
case = pathlib.Path(tempfile.mkdtemp(prefix="read-copy-qa-", dir=ROOT / ".tmp"))
frozen, live, replay = (case / name for name in ("frozen.sqlite", "live.sqlite", "replay.sqlite"))
for file in (frozen, live, replay):
    with worker.database(file) as db:
        db.execute("create table history (message text)")
        db.execute("insert into history values ('original')")


def read(file):
    with worker.connect(file) as db:
        return db.execute("select message from history").fetchone()[0]


sources = {"source": str(frozen)}
started = time.perf_counter()
with worker.read_copy_connections(sources):
    for _ in range(1000):
        assert read(frozen) == "original"
    try:
        with worker.connect(frozen) as db:
            db.execute("delete from history")
        raise AssertionError("Frozen source accepted a write")
    except sqlite3.OperationalError as error:
        assert "readonly" in str(error)
    assert read(live) == "original"
    with worker.database(live) as db:
        db.execute("update history set message='new reply'")
    assert read(live) == "new reply"
    live.unlink()  # No pooled handle may pin a mutable destination on Windows.
    sources["new replay"] = str(replay)
    assert read(replay) == "original"
    replay.unlink()  # Later baselines must not enter the frozen-source allowlist.
print(f"PASS: 1000 frozen reads in {time.perf_counter()-started:.3f}s; writes refused; live/replay handles released", flush=True)

try:
    with worker.read_copy_connections({"source": str(frozen)}):
        assert read(frozen) == "original"
        raise RuntimeError("simulated verification failure")
except RuntimeError as error:
    assert str(error) == "simulated verification failure"
assert read(frozen) == "original"
frozen.unlink()  # Both normal and exceptional scopes must close every reader.
print("PASS: original content preserved and all reader handles released after failure", flush=True)
