"""Windows filesystem regression probe, not product E2E.

Reproduce read-only Git artifacts and real Windows file locks in disposable
scratch. Assert that immutable backup content and out-of-root files survive.
"""
import ctypes
import importlib.util
import os
import pathlib
import stat
import tempfile
import threading
from ctypes import wintypes

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("worker", ROOT / "scripts/codex-storage-transition.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
assert os.name == "nt", "This probe requires Windows file semantics"
case = pathlib.Path(tempfile.mkdtemp(prefix="scratch-cleanup-qa-", dir=ROOT / ".tmp"))
backup = case / "backup"
scratch = backup / "baseline"
scratch.mkdir(parents=True)
original = backup / "immutable.sqlite"
original.write_bytes(b"preserved backup")
readonly = scratch / "tmp_idx_readonly"
readonly.write_bytes(b"temporary Git index")
readonly.chmod(stat.S_IREAD)
worker.remove_scratch(backup, scratch)
assert not scratch.exists()
assert original.read_bytes() == b"preserved backup"
print("PASS: read-only scratch removed; immutable backup retained", flush=True)

scratch.mkdir()
linked_source = backup / "linked-original"
linked_source.write_bytes(b"original attributes must survive")
os.link(linked_source, scratch / "linked-copy")
linked_source.chmod(stat.S_IREAD)
try:
    try:
        worker.remove_scratch(backup, scratch)
        raise AssertionError("Read-only hardlink was modified")
    except PermissionError:
        pass
    assert linked_source.stat().st_file_attributes & stat.FILE_ATTRIBUTE_READONLY
    assert linked_source.read_bytes() == b"original attributes must survive"
finally:
    linked_source.chmod(stat.S_IWRITE)
worker.remove_scratch(backup, scratch)
print("PASS: hardlinked original attributes retained", flush=True)

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                              ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel.CreateFileW.restype = wintypes.HANDLE
kernel.CloseHandle.argtypes = [wintypes.HANDLE]


def locked_file():
    scratch.mkdir()
    path = scratch / "held-index"
    path.write_bytes(b"held by file scanner")
    handle = kernel.CreateFileW(str(path), 0x80000000, 1, None, 3, 0x80, None)
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    return handle


handle = locked_file()
release = threading.Timer(0.7, kernel.CloseHandle, args=(handle,))
release.start()
try:
    worker.remove_scratch(backup, scratch)
finally:
    release.join()
assert not scratch.exists()
print("PASS: temporary Windows lock retried until released", flush=True)

handle = locked_file()
try:
    try:
        worker.remove_scratch(backup, scratch)
        raise AssertionError("Persistent lock was silently ignored")
    except OSError as error:
        assert error.winerror in (5, 32)
finally:
    kernel.CloseHandle(handle)
assert scratch.exists()
worker.remove_scratch(backup, scratch)
print("PASS: persistent lock reported as an error", flush=True)

outside = case / "outside"
outside.mkdir()
for forbidden in (backup, outside):
    try:
        worker.remove_scratch(backup, forbidden)
        raise AssertionError("Removal escaped scratch boundary")
    except RuntimeError:
        pass
assert outside.is_dir() and original.read_bytes() == b"preserved backup"
print("PASS: backup root and external directory protected", flush=True)
