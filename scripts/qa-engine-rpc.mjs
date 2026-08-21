/*
 * Engine RPC transport E2E (Stage 4, the WSL remote-engine design §7).
 *
 * Bundles the engine server entry and the remote client, spawns the server as a
 * child node process, and drives it through RemoteEngineClient over stdio —
 * proving the transport end to end (results, persistence, error propagation)
 * "locally first", before Stage 5 spawns the same server inside a WSL distro.
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { qaTempDir } from "./lib/qaTemp.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, "..");

const qaDir = qaTempDir();

async function bundle(entry, outName) {
  const out = path.join(qaDir, outName);
  const result = await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true, format: "esm", platform: "node", write: false, external: ["electron"],
  });
  writeFileSync(out, result.outputFiles[0].text);
  if (/from ["']electron["']|require\(["']electron["']\)/.test(result.outputFiles[0].text)) {
    throw new Error(`${outName} references electron`);
  }
  return out;
}

const serverBundle = await bundle("src/main/engine/transport/engineServerEntry.ts", "engine-server.mjs");
const clientBundle = await bundle("src/main/engine/transport/remoteEngineClient.ts", "engine-client.mjs");
const { RemoteEngineClient } = await import(pathToFileURL(clientBundle).href);

const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const workspace = path.join(os.tmpdir(), "agentparty-rpc-e2e");
const storage = path.join(os.tmpdir(), "agentparty-rpc-e2e-storage");
mkdirSync(workspace, { recursive: true });
rmSync(path.join(workspace, ".agent_party_app"), { recursive: true, force: true });

console.log("Engine RPC transport E2E:");
const child = spawn(process.execPath, [serverBundle, "--workspace", workspace, "--storage", storage], {
  stdio: ["pipe", "pipe", "pipe"],
});

// Wait for the server's readiness handshake on stderr.
await new Promise((resolve, reject) => {
  let buf = "";
  const t = setTimeout(() => reject(new Error("server did not signal ready in 10s")), 10000);
  child.stderr.on("data", (d) => {
    buf += d.toString();
    if (buf.includes("ENGINE_SERVER_READY")) { clearTimeout(t); resolve(); }
  });
  child.on("exit", (code) => { clearTimeout(t); reject(new Error(`server exited early (${code})`)); });
});
assert(true, "server child spawned and signaled ready over stderr");

const client = new RemoteEngineClient({ input: child.stdout, output: child.stdin }, workspace);

try {
  assert(client.workspacePath === workspace, "client reports its workspace");

  await client.qaReset();
  const seed = await client.qaSeed({ party: "RPC", members: [
    { name: "rpc-1", role: "backend" },
    { name: "rpc-2", role: "reviewer" },
  ] });
  assert(seed.created.includes("rpc-1") && seed.created.includes("rpc-2"), "qaSeed over RPC created both members");

  const listing = await client.listParty();
  const names = listing.members.map((m) => m.name);
  assert(names.includes("rpc-1") && names.includes("rpc-2"), `listParty over RPC returns members (${names.join(",")})`);
  assert(listing.parties.some((p) => p.name === "RPC"), "party 'RPC' present over RPC");

  await client.qaEmit("rpc-1", { events: [{ type: "assistant_text_delta", text: "via rpc" }], status: "working" });
  assert(true, "qaEmit over RPC accepted");

  // The server's engine persisted the current split store to the workspace fs
  // (server side, not client): one index plus one detail file per party.
  const storeRoot = path.join(workspace, ".agent_party_app");
  const indexPath = path.join(storeRoot, "parties.json");
  assert(existsSync(indexPath), "server engine persisted the party index");
  if (existsSync(indexPath)) {
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    const members = (index.parties || []).flatMap((party) => {
      const detailPath = path.join(storeRoot, "parties", party.id, "party.json");
      return existsSync(detailPath) ? (JSON.parse(readFileSync(detailPath, "utf8")).members || []) : [];
    });
    assert(members.some((m) => m.name === "rpc-1"), "persisted per-party store contains rpc-1");
  }

  // Error propagation: an engine-side throw becomes a rejected client promise.
  let rejected = false;
  try {
    await client.partyAction("rpc-1", "no-such-action", {});
  } catch (error) {
    rejected = /Unknown party action/.test(error.message);
  }
  assert(rejected, "engine-side error propagates as a rejected promise");
} finally {
  client.dispose();
  child.kill();
}

console.log("");
if (failures.length) {
  console.log(`ENGINE RPC FAILED: ${failures.length} assertion(s)`);
  process.exit(1);
}
console.log("ENGINE RPC PASSED");
process.exit(0);
