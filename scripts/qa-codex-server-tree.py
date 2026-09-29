"""Actual Windows process-tree regression, not product E2E.

A tiny RPC fixture leaves a writer alive after its parent exits, like an orphan
Git clone. Compare the previous worker with the current worker using OS process
handles, then require scratch deletion. No operational process is accessed.
"""
import ctypes
import importlib.util
import os
import pathlib
import subprocess
import sys
import tempfile
import types
from ctypes import wintypes

assert os.name == "nt"
ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("worker", ROOT / "scripts/codex-storage-transition.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
qa_job = worker.own_worker_process_tree()
case = pathlib.Path(tempfile.mkdtemp(prefix="server-tree-qa-", dir=ROOT / ".tmp"))
fixture = case / "fixture.py"
fixture.write_text('''import json, pathlib, subprocess, sys, time
home = pathlib.Path.cwd()
if "--writer" in sys.argv:
    (home/"writer-ready").write_text("ready")
    end = time.monotonic()+30
    index = 0
    while time.monotonic()<end:
        (home/("git-index-"+str(index))).write_text("temporary")
        index += 1
        time.sleep(.02)
    sys.exit(0)
child = subprocess.Popen([sys.executable, __file__, "--writer"], stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=subprocess.CREATE_NO_WINDOW)
(home/"writer-pid").write_text(str(child.pid))
while not (home/"writer-ready").exists(): time.sleep(.01)
for line in sys.stdin:
    message = json.loads(line)
    if "id" in message:
        print(json.dumps({"id":message["id"], "result":{}}), flush=True)
''', encoding="utf-8")
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel.OpenProcess.restype = wintypes.HANDLE
kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
request = {"command": sys.executable, "args": [str(fixture)]}

old = types.ModuleType("previous_worker")
old.__file__ = str(ROOT / "scripts/codex-storage-transition.py")
source = subprocess.check_output(["git", "show", "69d0d00:scripts/codex-storage-transition.py"], cwd=ROOT, text=True)
exec(compile(source, old.__file__, "exec"), old.__dict__)
for label, implementation in [("previous", old), *[("current-"+str(i), worker) for i in range(10)]]:
    home = case / label
    home.mkdir()
    server = implementation.Server(request, case / (label+".stderr"), home, home)
    handle = kernel.OpenProcess(0x100001, False, int((home/"writer-pid").read_text()))
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        server.close()
        if label == "previous":
            assert kernel.WaitForSingleObject(handle, 0) == 258, "Previous orphan did not reproduce"
            assert kernel.TerminateProcess(handle, 0), "Could not stop our fixture writer"
            assert kernel.WaitForSingleObject(handle, 5000) == 0
            print("REPRODUCED: previous Server.close leaves a live descendant", flush=True)
        else:
            assert kernel.WaitForSingleObject(handle, 5000) == 0, "Descendant survived close"
        worker.remove_scratch(case, home)
        assert not home.exists()
    finally:
        kernel.CloseHandle(handle)
print("PASS: 10 current server exits terminate descendants and allow scratch cleanup", flush=True)
