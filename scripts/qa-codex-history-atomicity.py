"""Storage fault injection, not product E2E. Uses disposable copies of real QA DBs.

Kills the worker inside its transaction, verifies rollback, then retries the
same import. Also checks that schema mismatch cannot partially change data.
No special fault hooks are added to production code.
"""
import argparse
import importlib.util
import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--case', required=True, type=pathlib.Path)
parser.add_argument('--crash-child', action='store_true')
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('worker', ROOT/'scripts/codex-storage-transition.py')
w = importlib.util.module_from_spec(spec); spec.loader.exec_module(w)

if args.crash_child:
    case = args.case.resolve()
    config = json.loads((case/'request.json').read_text())
    original = sqlite3.connect
    class Connection(sqlite3.Connection):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            def trace(sql):
                if sql.lower().startswith('insert into "thread_items"'):
                    os._exit(91)  # turns inserted; items/projection not committed
            self.set_trace_callback(trace)
    def injected(*a, **kw):
        if 'mode=rw' in str(a[0]): kw['factory'] = Connection
        return original(*a, **kw)
    sqlite3.connect = injected
else:
    source_case = args.case.resolve()
    assert source_case.is_relative_to(ROOT/'.tmp')
    case = pathlib.Path(tempfile.mkdtemp(prefix='history-atomicity-',dir=ROOT/'.tmp'))
    source = source_case/'home/thread_history_1.sqlite'
    with w.connect(source_case/'home/state_5.sqlite') as db:
        tid, rollout = db.execute('select id,rollout_path from threads where archived=1 limit 1').fetchone()
    target = case/'destination'; target.mkdir()
    snapshot = case/'snapshot/thread_history_1.sqlite'
    w.backup_database(source,snapshot)
    w.backup_database(source,target/source.name)
    with sqlite3.connect(target/source.name) as db:
        db.execute('update thread_history_projection_state set next_rollout_byte_offset=0,next_rollout_ordinal=0 where thread_id=?',(tid,))
        db.execute('delete from thread_items where thread_id=?',(tid,))
    config = {'tid':tid,'rollout':rollout}
    (case/'request.json').write_text(json.dumps(config))

tid = config['tid']
target = case/'destination'
state = case/'snapshot/state_5.sqlite'
databases = {str(state.parent/'thread_history_1.sqlite'):str(state.parent/'thread_history_1.sqlite')}
def restore():
    return w.restore_history_cache(target,[tid],databases,{tid:[state]},{tid:pathlib.Path(config['rollout'])})
def contents():
    with w.connect(target/'thread_history_1.sqlite') as db:
        assert db.execute('pragma quick_check').fetchone()==('ok',)
        return {table:w.rowset(db,table) for table in w.HISTORY_TABLES}
if args.crash_child:
    restore()
    raise AssertionError('Fault was not reached')

before = contents()
crashed = subprocess.run([sys.executable,'-B',__file__,'--case',str(case),'--crash-child'],creationflags=subprocess.CREATE_NO_WINDOW)
assert crashed.returncode==91,crashed.returncode
assert contents()==before,'Interrupted transaction was not rolled back'
assert restore()==[tid]
with w.connect(case/'snapshot/thread_history_1.sqlite') as source, w.connect(target/'thread_history_1.sqlite') as destination:
    assert w.history_rows(source,tid)==w.history_rows(destination,tid)
assert restore()==[],'Import must be idempotent'
after=contents()
with sqlite3.connect(target/'thread_history_1.sqlite') as db:
    db.execute('create table unvalidated_schema_version (value text)')
try:
    restore()
except RuntimeError as error:
    assert 'Unvalidated Codex history tables' in str(error),str(error)
else:
    raise AssertionError('Unknown schema accepted')
assert contents()==after,'Schema rejection changed history'
print('PASS: mid-transaction process death rolls back; retry preserves full history; repeat is idempotent; unknown schema rejects without writes.',flush=True)
print('Private fixture:',case,flush=True)
