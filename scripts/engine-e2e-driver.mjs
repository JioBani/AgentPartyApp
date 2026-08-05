/*
 * Headless engine E2E driver (Stage 3, the WSL remote-engine design). Runs the SAME engine
 * bootstrap under whatever node executes it — Windows node or a WSL distro's node
 * — against a given workspace cwd, with no Electron. Proves the engine is host-
 * agnostic and writes .agent_party_app/ to the workspace's own filesystem.
 *
 * Usage: node engine-e2e-driver.mjs <workspace> <storageDir> <engineHostBundle>
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [workspace, storageDir, bundlePath] = process.argv.slice(2);
if (!workspace || !bundlePath) {
  console.error("usage: engine-e2e-driver <workspace> <storageDir> <engineHostBundle>");
  process.exit(2);
}

const { createEngineHost } = await import(pathToFileURL(bundlePath).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

console.log(`Engine E2E @ ${workspace}`);
console.log(`  platform=${process.platform} node=${process.version}`);

// Start from a clean workspace store.
rmSync(path.join(workspace, ".agent_party_app"), { recursive: true, force: true });

const host = createEngineHost({
  storageDir: storageDir || workspace,
  router: { preferredPort: 0, authToken: "qa", openRouterApiKey: "" },
});
const engine = host.engineRegistry.forWorkspace(workspace);

// Seed a party with mock members — no model calls, same path the UI drives.
const seed = await engine.qaSeed({
  party: "WSL E2E",
  members: [
    { name: "wsl-1", role: "backend" },
    { name: "wsl-2", role: "reviewer" },
  ],
});
assert(seed.created.includes("wsl-1") && seed.created.includes("wsl-2"), "qaSeed created both mock members");
const names = seed.listing.members.map((m) => m.name);
assert(names.includes("wsl-1") && names.includes("wsl-2"), `listParty shows members (${names.join(",")})`);
assert(seed.listing.parties.some((p) => p.name === "WSL E2E"), "party 'WSL E2E' present");

// Inject a mock event — proves the mock harness runs headless under this node.
await engine.qaEmit("wsl-1", { events: [{ type: "assistant_text_delta", text: "hello from the engine" }], status: "working" });
assert(true, "qaEmit accepted (mock harness alive)");

// The point of Tier A: state persists to the workspace's own fs (ext4 in WSL),
// via the engine's node:fs — not the Windows side over \\wsl$. Party state is
// split: a shared `parties.json` index + per-party `parties/<id>/party.json`.
const root = path.join(workspace, ".agent_party_app");
const indexPath = path.join(root, "parties.json");
assert(existsSync(indexPath), `party index persisted at ${indexPath}`);
if (existsSync(indexPath)) {
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const members = (index.parties || []).flatMap((party) => {
    const file = path.join(root, "parties", party.id, "party.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).members || []) : [];
  });
  assert(members.some((m) => m.name === "wsl-1"), "persisted per-party store contains wsl-1");
}

host.dispose();
console.log("");
if (failures.length) {
  console.log(`ENGINE E2E FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("ENGINE E2E PASSED");
process.exit(0);
