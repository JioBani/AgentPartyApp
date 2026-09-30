/** Executes the real NSIS guard macro in a no-install fixture. No registry/install writes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { installPath } from './lib/installRoot.mjs';

const root = process.cwd();
const directory = fs.mkdtempSync(path.join(root, '.tmp', 'nsis-guard-'));
const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis');
const compiler = path.join(cache, 'nsis-3.0.4.1/Bin/makensis.exe');
const resources = path.join(cache, 'nsis-resources-3.4.1/plugins/x86-unicode');
const includes = installPath(root, 'app-builder-lib/templates/nsis/include');
const source = path.join(directory, 'guard.nsi');
const executable = path.join(directory, 'guard.exe');
const imageName = 'AgentPartyStorageGuardQA-' + process.pid + '.exe';
fs.writeFileSync(source, `Unicode true
Name "AgentParty storage guard QA"
OutFile "${executable}"
RequestExecutionLevel user
!include "LogicLib.nsh"
!define isUpdated '0 = 0'
!addincludedir "${includes}"
!addplugindir "${resources}"
!define APP_EXECUTABLE_FILENAME "${imageName}"
!include "${path.join(root, 'build/installer.nsh')}"
!include "allowOnlyOneInstallerInstance.nsh"
Section
  !insertmacro customCheckAppRunning
  SetErrorLevel 0
SectionEnd
`);
const compiled = spawnSync(compiler, ['/V2', source], {encoding:'utf8',windowsHide:true});
assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
const helper = path.join(directory, imageName);
fs.copyFileSync(path.join(process.env.SystemRoot, 'System32/ping.exe'), helper);
const child = spawn(helper, ['-t', '127.0.0.1'], {stdio:'ignore',windowsHide:true});
const closed = once(child, 'close');
await once(child, 'spawn');
try {
  const refusedProcess = spawn(executable, ['/S'], {windowsHide:true,stdio:'ignore'});
  const [refusedCode] = await once(refusedProcess, 'close');
  assert.equal(refusedCode, 2, 'Silent installer must refuse while the app is running');
  assert.doesNotThrow(()=>process.kill(child.pid, 0), 'Guard terminated the running app');
} finally {
  child.kill();
  await closed;
}
const accepted = spawnSync(executable, ['/S'], {windowsHide:true,timeout:15000});
assert.equal(accepted.status, 0, 'Installer must proceed once the app has exited');
const exiting = spawn(helper, ['-t', '127.0.0.1'], {stdio:'ignore',windowsHide:true});
await once(exiting, 'spawn');
const exitingClosed = once(exiting, 'close');
const waitingInstaller = spawn(executable, ['/S'], {windowsHide:true,stdio:'ignore'});
const installerClosed = once(waitingInstaller, 'close');
const naturalExit = setTimeout(() => exiting.kill(), 1500);
try {
  const [code] = await installerClosed;
  assert.equal(code, 0, 'Installer must wait for normal app exit without failing');
} finally {
  clearTimeout(naturalExit);
  if (exiting.exitCode === null) exiting.kill();
  await exitingClosed;
}
console.log('PASS: actual NSIS macro refuses a running owned QA process without killing it, then permits installation after process exit. Full product install/feed QA remains separate.');
