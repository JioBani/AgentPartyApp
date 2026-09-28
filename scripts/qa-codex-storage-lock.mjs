/** OS fault test, separate from product E2E. Only owned QA children are killed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = process.cwd();
const directory = fs.mkdtempSync(path.join(root, '.tmp', 'storage-lock-'));
const marker = path.join(directory, 'codex-storage.lock');
const require = createRequire(import.meta.url);
const policies = [];
for (const [label, source] of [
  ['conversion', root], ['compat', path.resolve(root, '../codex-compat-current')],
]) {
  const outfile = path.join(directory, label + '.cjs');
  await build({ entryPoints: [path.join(source, 'src/core/codexStoragePolicy.ts')], outfile, bundle: true, platform: 'node', logLevel: 'silent' });
  policies.push(require(outfile).codexSqliteHomeForScope);
}
const check = () => policies.forEach(policy => policy(directory, 'desktop:lock-qa'));
for (const content of ['', '{', JSON.stringify({pid:4}), JSON.stringify({pid:process.pid})]) {
  fs.writeFileSync(marker, content);
  check();
}
assert(!fs.existsSync(path.join(directory, 'codex-storage.json')), 'Status/default policy must not write a mode record');

function worker() {
  const child = spawn('python', ['-B', path.join(root, 'scripts/codex-storage-transition.py'), '--lock', marker], {windowsHide:true});
  const closed = once(child, 'close');
  const ready = new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      for (const line of output.split('\n').filter(Boolean)) {
        const result = JSON.parse(line);
        if (result.locked) resolve();
        if (result.error) reject(new Error(result.error));
      }
    });
    child.once('error', reject);
    child.once('close', () => reject(new Error('Worker closed before acquiring lock')));
  });
  return {child, closed, ready};
}
const first = worker();
try {
  await first.ready;
  for (const policy of policies) assert.throws(() => policy(directory, 'desktop:lock-qa'), /maintenance is still running/);
  const second = worker();
  await assert.rejects(second.ready, /Another Codex storage worker/);
  await second.closed;
  first.child.kill();
  await first.closed;
  check();
  const retry = worker();
  await retry.ready;
  retry.child.stdin.end('{}'); // Invalid request fails visibly and releases the OS lock.
  assert.equal((await retry.closed)[0], 1);
  check();
} finally {
  if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill();
}
const treeHelper = path.join(directory, 'tree.py');
fs.writeFileSync(treeHelper, `import importlib.util,sys,subprocess
spec=importlib.util.spec_from_file_location('worker',sys.argv[1])
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
handle=w.own_worker_process_tree()
child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(10)'])
print(child.pid,flush=True)
sys.stdin.read()
`);
const tree = spawn('python', ['-B',treeHelper,path.join(root,'scripts/codex-storage-transition.py')], {windowsHide:true});
const treeClosed = once(tree, 'close');
const [pidText] = await once(tree.stdout, 'data');
const descendant = Number(String(pidText).trim());
assert(Number.isInteger(descendant) && descendant > 0);
tree.kill();
await treeClosed;
let descendantGone = false;
for (let attempt=0; attempt<20; attempt++) {
  try { process.kill(descendant, 0); }
  catch (error) { if (error.code==='ESRCH') { descendantGone=true; break; } throw error; }
  await new Promise(resolve=>setTimeout(resolve,25));
}
assert(descendantGone, 'Worker death left its child process running');
console.log('PASS: both apps ignore stale/corrupt/PID-reused markers; live lock blocks both; concurrent worker refuses; forced death and failed request release lock; retry succeeds; Job Object terminates orphan descendants.');
