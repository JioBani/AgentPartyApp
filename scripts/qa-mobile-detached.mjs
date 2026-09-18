import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

const pkg = JSON.parse(read("package.json"));
assert.equal(pkg.optionalDependencies?.["@agentparty/protocol"], undefined, "desktop package must not depend on the mobile protocol");
assert.equal(pkg.optionalDependencies?.["node-datachannel"], undefined, "desktop package must not ship the mobile WebRTC native module");
assert(!JSON.stringify(pkg.build?.asarUnpack || []).includes("node-datachannel"), "desktop package must not unpack the mobile WebRTC native module");
assert.doesNotMatch(read("src/main/main.ts"), /mobileLink|mobilePipe|AGENTPARTY_MOBILE/, "main process must not start the mobile runtime");
assert.doesNotMatch(read("src/main/api/methodRoutes.ts"), /mobileRoutes/, "HTTP capability table must not publish mobile routes");
assert.doesNotMatch(read("src/preload/preload.ts"), /mobile:/, "preload must not expose mobile IPC");
assert.doesNotMatch(read("src/shared/runtimeTabs.ts"), /[\"']mobile[\"']/, "settings navigation must not expose a mobile tab");

const mainTsconfig = JSON.parse(read("tsconfig.main.json"));
for (const excluded of ["src/main/mobile/**", "src/main/mobileLink.ts", "src/main/mobilePipe.ts"]) {
  assert(mainTsconfig.exclude?.includes(excluded), `main build must exclude dormant source: ${excluded}`);
}

console.log("qa-mobile-detached: desktop runtime, API, IPC, UI, and package dependency are detached; dormant source remains excluded for future reactivation");
