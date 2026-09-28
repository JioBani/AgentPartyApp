"""Run the production transition against a private, multi-store operational copy.

Source databases are opened read-only with SQLite's backup API. Only copied
indexes have paths changed. This is a data migration audit, not product E2E.
It makes no provider calls and does not copy credentials. A foreign rollout is
retained in the fixture and reported; this does not authorize moving or dropping
that rollout in the operational profile.
"""
import argparse
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--user-data', required=True, type=pathlib.Path)
parser.add_argument('--home', required=True, type=pathlib.Path)
parser.add_argument('--destination', required=True, type=pathlib.Path)
parser.add_argument('--codex', required=True, type=pathlib.Path)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location('worker', ROOT / 'scripts/codex-storage-transition.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
source_data, source_home = args.user_data.resolve(), args.home.resolve()
destination = args.destination.resolve()
assert destination != source_data and destination != source_home
assert not destination.is_relative_to(source_data) and not destination.is_relative_to(source_home)
destination.mkdir(parents=True, exist_ok=True)
case = pathlib.Path(tempfile.mkdtemp(prefix='operational-copy-', dir=destination)).resolve()
home, data = case / 'home', case / 'user-data'
home.mkdir()
data.mkdir()
print(json.dumps({'case': str(case), 'phase': 'inventory'}), flush=True)
excluded = {}
states, records, sources, metadata = w.inventory(source_data, source_home, source_home, excluded)
assert not excluded, 'Resolve missing operational rollouts explicitly before this audit.'
foreign = {tid: str(path) for tid, path in records.items() if not path.is_relative_to(source_home)}
report = {'case': str(case), 'stores': len(states), 'threads': len(records),
          'foreignRollouts': foreign, 'completed': False}
(case / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
directories = {state.parent for state in states}
for count, directory in enumerate(sorted(directories), 1):
    target = home if directory == source_home else data / directory.relative_to(source_data)
    target.mkdir(parents=True, exist_ok=True)
    for db in directory.glob('*.sqlite'):
        if not db.name.startswith('logs_'):
            w.backup_database(db, target / db.name)
    if count % 25 == 0 or count == len(directories):
        print(json.dumps({'phase': 'copy-databases', 'copied': count, 'total': len(directories)}), flush=True)
targets = {}
for count, (tid, source) in enumerate(records.items(), 1):
    relative = source.relative_to(source_home) if source.is_relative_to(source_home) else pathlib.Path('sessions/imported-qa') / source.name
    target = home / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    before = source.stat()
    shutil.copyfile(source, target)
    after = source.stat()
    assert (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns), 'Rollout writer changed during snapshot: ' + tid
    assert target.stat().st_size == before.st_size
    targets[tid] = target
    if count % 100 == 0 or count == len(records):
        print(json.dumps({'phase': 'copy-rollouts', 'copied': count, 'total': len(records)}), flush=True)
for directory in sorted(directories):
    target = home if directory == source_home else data / directory.relative_to(source_data)
    with w.database(target / 'state_5.sqlite') as db:
        for tid, old in db.execute('select id,rollout_path from threads').fetchall():
            # Preserve stale/moved paths as distinct missing paths so the
            # production inventory must still resolve the multi-store shape.
            original = w.normalized(old)
            copied = home / original.relative_to(source_home) if original.is_relative_to(source_home) else targets[tid]
            db.execute('update threads set rollout_path=? where id=?', (str(copied), tid))
if (source_data / 'party-store').exists():
    shutil.copytree(source_data / 'party-store', data / 'party-store')
(home / 'config.toml').write_text('cli_auth_credentials_store="file"\n', encoding='utf-8')
request = {'command': str(args.codex.resolve()), 'args': [], 'mode': 'native',
           'userData': str(data), 'home': str(home), 'sqliteEnvironment': str(home)}
env = os.environ.copy()
env.pop('CODEX_SQLITE_HOME', None)
env['CODEX_HOME'] = str(home)
with (case / 'worker.stderr').open('w', encoding='utf-8') as err:
    child = subprocess.Popen(['python', '-B', str(ROOT / 'scripts/codex-storage-transition.py')],
                             env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err,
                             text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW)
    child.stdin.write(json.dumps(request))
    child.stdin.close()
    final = None
    with (case / 'progress.jsonl').open('w', encoding='utf-8') as log:
        for line in child.stdout:
            log.write(line)
            log.flush()
            event = json.loads(line)
            if event.get('complete'):
                final = event
            if event.get('error') or event.get('complete') or event.get('phase') not in ('verify', 'schema-upgrade') or event.get('verified', -1) % 50 == 0:
                print(line.strip(), flush=True)
    code = child.wait()
report.update(exitCode=code, result=final, completed=code == 0 and bool(final) and final.get('verified') == len(records))
(case / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
assert report['completed'], 'Operational-copy transition failed; see preserved progress and stderr at ' + str(case)
print(json.dumps({'PASS': True, 'stores': len(states), 'threads': len(records), 'case': str(case), 'foreignRollouts': len(foreign)}), flush=True)
