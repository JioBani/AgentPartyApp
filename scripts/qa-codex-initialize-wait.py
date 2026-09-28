"""Real Codex backfill through production discovery/probe, not product E2E.

Each invocation gets a fresh SQLite directory and 4000 synthetic rollouts.
No provider turn is sent. The 1ms deadline must warn without killing backfill.
"""
import argparse
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--codex', required=True, type=pathlib.Path)
p.add_argument('--compat', required=True, type=pathlib.Path)
args = p.parse_args()
case = pathlib.Path(tempfile.mkdtemp(prefix='initialize-wait-', dir=ROOT / '.tmp')).resolve()
spec = importlib.util.spec_from_file_location('worker', ROOT / 'scripts/codex-storage-transition.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)
os.environ.pop('CODEX_SQLITE_HOME', None)
template = case / 'template'
template.mkdir()
server = w.Server({'command': str(args.codex), 'args': []}, case / 'template.stderr', template, case / 'template-db')
try:
    tid = server.call('thread/start', {'cwd': str(template), 'approvalPolicy': 'never', 'sandbox': 'read-only'})['thread']['id']
    server.call('thread/inject_items', {'threadId': tid, 'items': [
        {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'synthetic backfill user'}]},
        {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'synthetic backfill reply'}]},
    ]})
finally:
    server.close()
seed = next((template / 'sessions').rglob('*.jsonl'))
events = [json.loads(line) for line in seed.read_text(encoding='utf-8').splitlines() if line.strip()]
events = [events[0]] + [e for e in events if e['type'] == 'response_item' and 'synthetic backfill' in json.dumps(e)]
home = case / 'home'
for i in range(4000):
    tid = str(uuid.uuid4())
    copied = json.loads(json.dumps(events))
    for ordinal, e in enumerate(copied):
        e['ordinal'] = ordinal
        if e['type'] == 'session_meta':
            e['payload'].update(id=tid, session_id=tid, cwd=str(home), base_instructions={'text': 'Synthetic QA fixture'})
    dest = home / 'sessions' / f'rollout-2026-09-28T00-00-00-{tid}.jsonl'
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text('\n'.join(json.dumps(e) for e in copied) + '\n', encoding='utf-8')
runner = case / 'run.cjs'
runner.write_text('''
const [root, codex, home, sqlite, kind] = process.argv.slice(2);
const path = require('node:path');
process.env.CODEX_HOME = process.env.AGENTPARTY_NATIVE_CODEX_HOME = home;
process.env.CODEX_SQLITE_HOME = sqlite;
let warnings = 0;
const warn = console.warn;
console.warn = (...args) => { warnings++; warn(...args); };
(async () => {
  if (kind === 'discovery') {
    const {discoverCodexModels} = require(path.join(root, 'dist/core/codexModelDiscovery.js'));
    try { await discoverCodexModels({cwd:home, executablePath:codex, sqliteHome:sqlite, timeoutMs:1}); }
    catch (e) { if (!e.message.includes('model discovery timed out')) throw e; }
  } else {
    const {probeAppServerCommand} = require(path.join(root, 'dist/core/harnessExecutionProbe.js'));
    const result = await probeAppServerCommand(codex, ['app-server'], home, process.env, 1);
    if (!result.ok) throw new Error(JSON.stringify(result));
  }
  if (!warnings) throw new Error('The slow initialization boundary was not exercised');
})().catch(e => { console.error(e); process.exitCode = 1; });
''', encoding='utf-8')
for label, root in [('storage', ROOT), ('compat', args.compat.resolve())]:
    for kind in ('discovery', 'probe'):
        sqlite = case / (label + '-' + kind)
        sqlite.mkdir()
        result = subprocess.run(['node', str(runner), str(root), str(args.codex), str(home), str(sqlite), kind],
                                capture_output=True, text=True, timeout=180)
        assert result.returncode == 0, result.stderr
        w.index_signature(sqlite)
        with w.connect(sqlite / 'state_5.sqlite') as db:
            assert db.execute('select count(*) from threads').fetchone()[0] == 4000
        print('PASS:', label, kind, 'warned after 1ms; all 4000 rollouts indexed; backfill complete', flush=True)
print('QA:', case, flush=True)
