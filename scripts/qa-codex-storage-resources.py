"""Bounded storage regression checks on a disposable QA snapshot, not product E2E."""
import argparse
import importlib.util
import pathlib
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--case', required=True, type=pathlib.Path)
args = parser.parse_args()
source_case = args.case.resolve()
assert source_case.is_relative_to(ROOT / '.tmp')
spec = importlib.util.spec_from_file_location('worker', ROOT / 'scripts/codex-storage-transition.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
case = pathlib.Path(tempfile.mkdtemp(prefix='storage-resources-', dir=ROOT / '.tmp')).resolve()
source = source_case / 'home/thread_history_1.sqlite'
with w.connect(source) as db:
    tids = [row[0] for row in db.execute('select distinct thread_id from thread_items')]
assert len(tids) > 1, 'Need multiple conversations to detect whole-store amplification'
for tid in tids:
    destination = case / 'one-thread.sqlite'
    w.copy_thread_history(source, destination, tid)
    with w.connect(destination) as db:
        for table in w.HISTORY_TABLES:
            assert {r[0] for r in db.execute('select distinct thread_id from "' + table + '"')} <= {tid}
    destination.unlink()

usage = w.shutil.disk_usage(case)
original = w.shutil.disk_usage
w.shutil.disk_usage = lambda _: type(usage)(usage.total, usage.total - 1, 1)
try:
    try:
        w.run({'command': 'python', 'args': [], 'mode': 'native', 'userData': str(case),
               'home': str(source_case / 'home')})
    except RuntimeError as error:
        assert 'Insufficient free space' in str(error), error
    else:
        raise AssertionError('Migration accepted insufficient space')
finally:
    w.shutil.disk_usage = original
assert not (case / 'codex-storage-backups').exists(), 'Low-space rejection must precede writes'
one = case/'codex-sqlite/one/state_5.sqlite'
two = case/'codex-sqlite/two/state_5.sqlite'
w.backup_database(source_case/'home/state_5.sqlite', one)
w.backup_database(source_case/'home/state_5.sqlite', two)
other = case/'ambiguous-rollout.jsonl'
other.write_text('{}\n')
with w.database(two) as db:
    tid = db.execute('select id from threads limit 1').fetchone()[0]
    db.execute('update threads set rollout_path=? where id=?', (str(other),tid))
try:
    w.inventory(case,case/'empty-native',source_case/'home')
except RuntimeError as error:
    assert 'Conflicting rollout paths' in str(error), error
else:
    raise AssertionError('Two existing rollouts were resolved arbitrarily')
print('PASS: baselines contain only their selected thread; low-space rejection precedes destination writes; ambiguous existing rollouts are rejected.')
ready = case / 'ready'
w.backup_database(source_case / 'home/state_5.sqlite', ready / 'state_5.sqlite')
reference = case / 'reference'
w.backup_database(ready / 'state_5.sqlite', reference / 'state_5.sqlite')
copies = {str(ready / 'state_5.sqlite'): str(reference / 'state_5.sqlite')}
w.require_ready_index(ready, copies)
with w.database(ready / 'state_5.sqlite') as db:
    db.execute("update backfill_state set status='running'")
try:
    w.require_ready_index(ready, copies)
except RuntimeError as error:
    assert 'not complete' in str(error)
else:
    raise AssertionError('Stranded backfill passed the live initialization gate')
with w.database(ready / 'state_5.sqlite') as db:
    db.execute("update backfill_state set status='complete'")
    db.execute('delete from _sqlx_migrations where version=(select max(version) from _sqlx_migrations)')
try:
    w.require_ready_index(ready, copies)
except RuntimeError as error:
    assert 'schema upgrade' in str(error)
else:
    raise AssertionError('Outdated live schema passed the initialization gate')
for suffix in ('-wal', '-shm', '-journal'):
    orphan = case / ('orphan' + suffix)
    orphan.mkdir()
    marker = orphan / ('state_5.sqlite' + suffix)
    marker.write_bytes(b'preserve for recovery')
    try:
        w.prepare_index({}, case / 'unused-backup', source_case / 'home', orphan, {})
    except RuntimeError as error:
        assert 'sidecars remain' in str(error)
    else:
        raise AssertionError('An orphan index sidecar was ignored')
    assert marker.read_bytes() == b'preserve for recovery'
    assert not (orphan / 'state_5.sqlite').exists()
print('PASS: incomplete indexes, schema changes and orphan sidecars refuse live initialization without replacing stored data.')
missing_user = case / 'missing-profile'
missing_state = missing_user / 'codex-sqlite/source/state_5.sqlite'
w.backup_database(source_case / 'home/state_5.sqlite', missing_state)
offline_home = case / 'offline-home'
offline_home.mkdir()
with w.database(missing_state) as db:
    missing_tid = db.execute('select id from threads limit 1').fetchone()[0]
    db.execute('update threads set rollout_path=? where id=?', (str(offline_home/'sessions/absent.jsonl'), missing_tid))
try:
    w.inventory(missing_user, case/'unused', offline_home, {})
except RuntimeError as error:
    assert 'root is unavailable' in str(error), error
else:
    raise AssertionError('An offline rollout root was interpreted as deletion')
(offline_home/'sessions').mkdir()
with w.database(missing_state) as db:
    db.execute('update threads set rollout_path=? where id=?', (str(case/'outside-absent.jsonl'), missing_tid))
try:
    w.inventory(missing_user, case/'unused', offline_home, {})
except RuntimeError as error:
    assert 'outside the selected Codex home' in str(error), error
else:
    raise AssertionError('An outside-home missing path bypassed path review')
with w.database(case/'edges.sqlite') as db:
    db.execute('create table thread_spawn_edges(parent_thread_id text, child_thread_id text)')
    db.executemany('insert into thread_spawn_edges values (?,?)', [('parent','deleted'),('deleted','child'),('parent','kept')])
    assert w.rowset(db, 'thread_spawn_edges', {'deleted'}) == {('parent','kept')}
print('PASS: offline roots and outside-home missing paths fail closed; deleted-parent/child spawn edges are excluded without relying on SQL foreign keys.')
