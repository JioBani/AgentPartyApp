"""Read the installed CLI's compatibility with disposable copies of old QA DBs.

This is a storage/API audit, not product E2E. It runs the production worker
without a version bypass and never writes the input fixture. No provider turns are sent.
The producer compares complete source/destination schema definitions and history
itself; its concise result is the verification evidence.
"""
import argparse
import importlib.util
import json
import os
import pathlib
import shutil
import sqlite3
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--fixture', required=True, type=pathlib.Path)
parser.add_argument('--fixture-db', default='home', help='Database directory relative to the QA fixture')
parser.add_argument('--codex', required=True, type=pathlib.Path)
args = parser.parse_args()
original = args.fixture.resolve()
fixture_db = (original / args.fixture_db).resolve()
assert fixture_db.is_relative_to(original)
assert '.tmp' in original.parts and (fixture_db/'state_5.sqlite').is_file()
(ROOT/'.tmp').mkdir(exist_ok=True)
case = pathlib.Path(tempfile.mkdtemp(prefix='codex-version-',dir=ROOT/'.tmp')).resolve()
home, legacy, native, reference = [case/name for name in ('home','codex-sqlite/fixture','native','reference')]
for directory in (home,legacy,native,reference): directory.mkdir(parents=True)
os.environ.pop('CODEX_SQLITE_HOME',None)
os.environ['CODEX_HOME']=str(home)
spec=importlib.util.spec_from_file_location('worker',ROOT/'scripts/codex-storage-transition.py')
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
for name in ('sessions','archived_sessions'):
    if (original/'home'/name).exists(): shutil.copytree(original/'home'/name,home/name)
(home/'config.toml').write_text('cli_auth_credentials_store="file"\n')
for file in fixture_db.glob('*.sqlite'): w.backup_database(file,legacy/file.name)
with sqlite3.connect(legacy/'state_5.sqlite') as db:
    records=db.execute('select id,rollout_path,archived from threads').fetchall()
    for tid,file,_ in records:
        copied=home/w.normalized(file).relative_to(original/'home')
        assert copied.is_file()
        db.execute('update threads set rollout_path=? where id=?',(str(copied),tid))
def schema(directory):
    result={}
    for file in directory.glob('*.sqlite'):
        with w.connect(file) as db:
            result[file.name]={r[0]:r[1] for r in db.execute("select name,sql from sqlite_master where name not like 'sqlite_%'")}
    return result
before=schema(legacy)
# A second legacy store has the pre-archive path/flag for the same thread.
# This is the actual duplicate-index shape; the surviving rollout is unique.
stale = case/'codex-sqlite/stale'
stale.mkdir()
for file in legacy.glob('*.sqlite'): w.backup_database(file,stale/file.name)
archived_tid = next(tid for tid,_,a in records if a)
with sqlite3.connect(stale/'state_5.sqlite') as db:
    file = pathlib.Path(db.execute('select rollout_path from threads where id=?',(archived_tid,)).fetchone()[0])
    old_path = home/'sessions'/file.relative_to(home/'archived_sessions')
    assert not old_path.exists()
    db.execute('update threads set rollout_path=?,archived=0 where id=?',(str(old_path),archived_tid))
stale_schema = schema(stale)
for file in legacy.glob('*.sqlite'): w.backup_database(file,reference/file.name)
request={'command':str(args.codex.resolve()),'args':[]}
version=subprocess.check_output([request['command'],'--version'],text=True).strip()
summary={'cli':version,'case':str(case)}
server=w.Server(request,case/'cli.stderr',home,reference)
try:
    upgraded={tid:w.thread_history(server.read(tid)) for tid,_,_ in records}
finally:server.close()
after=schema(reference)
summary['databaseFilesAdded']=sorted(set(after)-set(before))
summary['schemaChanges']={name:sorted(k for k in set(before.get(name,{}))|set(defs)
                                      if before.get(name,{}).get(k)!=defs.get(k))
                          for name,defs in after.items() if before.get(name)!=defs}
summary['threadsRead']=len(upgraded)
summary['itemsRead']=sum(len(t['items']) for turns in upgraded.values() for t in turns)
summary['archivedRead']=sum(1 for _,_,a in records if a)
server=w.Server(request,case/'cli.stderr',home,native)
try:
    cold={tid:w.thread_history(server.read(tid)) for tid,_,_ in records}
    archived=next(tid for tid,_,a in records if a)
    try: server.refresh(archived)
    except RuntimeError as error: summary['coldArchivedResumeError']=str(error)
    else: summary['coldArchivedResumeError']=None
finally:server.close()
summary['coldHistoryMatches']={tid:cold[tid]==upgraded[tid] for tid in upgraded}
transition={**request,'mode':'native','userData':str(case),'home':str(home),'sqliteEnvironment':str(native)}
child=subprocess.run(['python','-B',str(ROOT/'scripts/codex-storage-transition.py')],
                     input=json.dumps(transition),text=True,capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
(case/'transition.stdout').write_text(child.stdout,encoding='utf-8')
(case/'transition.stderr').write_text(child.stderr,encoding='utf-8')
assert child.returncode==0,(child.stdout[-3000:],child.stderr)
for backup in (case/'codex-storage-backups').iterdir():
    assert not (backup/'baseline').exists(), 'Completed verification retained per-thread scratch'
    assert not (backup/'read-copies').exists(), 'Completed verification retained upgraded scratch'
server=w.Server(request,case/'cli.stderr',home,native)
try:
    for tid,_,_ in records: assert w.thread_history(server.read(tid))==upgraded[tid],tid
finally:server.close()
assert schema(legacy)==before,'Original legacy schemas must remain untouched'
assert schema(stale)==stale_schema,'Stale source schemas must remain untouched'
with w.connect(stale/'state_5.sqlite') as db:
    assert db.execute('select rollout_path,archived from threads where id=?',(archived_tid,)).fetchone()==(str(old_path),0)
with w.connect(legacy/'state_5.sqlite') as db:
    for tid,_,archived in records:
        assert db.execute('select archived from threads where id=?',(tid,)).fetchone()==(archived,)
summary['transition']='PASS: duplicate old-schema stores with stale archive path -> current native; all API history retained; original schemas and stale indexes untouched; scratch removed'
(case/'result.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary,indent=2),flush=True)
