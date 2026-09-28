/** Installer dispatch/coordinator regression test; not a substitute for NSIS product QA. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
process.env.AGENTPARTY_USER_DATA = fs.mkdtempSync(path.join(process.cwd(), '.tmp', 'install-guard-'));
const require = createRequire(import.meta.url);
const { UpdateService } = require('../dist/main/updateService.js');
const { withAgentPartyCodexStartup, withCodexStorageMaintenance, prepareCodexForInstall, cancelCodexInstallPreparation } = require('../dist/core/codexStartup.js');
let installs = 0;
class Updater extends EventEmitter {
  failInstall = false;
  setFeedURL() {}
  quitAndInstall() { if (this.failInstall) this.emit('error',new Error('QA installer dispatch failure')); else installs += 1; }
}
const updater = new Updater();
const service = new UpdateService({getVersion:()=>'0.18.0',isPackaged:()=>true,updaterFactory:()=>updater,prepareForInstall:prepareCodexForInstall,cancelInstallPreparation:cancelCodexInstallPreparation,checkIntervalHours:0});
service.setMockStatus({state:'downloaded',latestVersion:'0.18.1'});
let releaseMaintenance;
const maintenance = withCodexStorageMaintenance(() => new Promise(resolve => {releaseMaintenance=resolve;}));
await Promise.resolve();
await assert.rejects(service.install(), /전환 중/);
assert.equal(installs, 0);
releaseMaintenance();
await maintenance;
updater.failInstall = true;
await assert.rejects(service.install(), /QA installer dispatch failure/);
await withAgentPartyCodexStartup(async()=>{});
updater.failInstall = false;
service.setMockStatus({state:'downloaded',latestVersion:'0.18.1'});
let releaseStartup;
const startup = withAgentPartyCodexStartup(() => new Promise(resolve => {releaseStartup=resolve;}));
await Promise.resolve();
const pending = service.install();
await Promise.resolve();
assert.equal(installs, 0, 'Installer must not spawn while initialization is pending');
await assert.rejects(service.install(), /준비/);
releaseStartup();
await startup;
await pending;
assert.equal(installs, 1);
await assert.rejects(withAgentPartyCodexStartup(async()=>{}), /closing/);
console.log('PASS: maintenance refuses installation; failed dispatch restores startup; pending initialization drains before installer spawn; duplicate install and new startup are rejected.');
