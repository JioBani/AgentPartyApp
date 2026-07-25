/*
 * Discord bridge — settings-save gateway lifecycle (regression).
 *
 * The bug: saving Discord settings to add an allowed user tore down the inbound
 * gateway and never brought it back. The settings form resubmits every field, so
 * `updateSettings` saw `patch.guildId !== undefined` and called stopGateway() even
 * though nothing about the gateway changed — leaving connection stuck at "off" so
 * a message typed in Discord was never injected.
 *
 * This locks in the fix (compare VALUES, only reconnect on a real token change):
 *   1) resubmitting the same token/guild with a new allowlist keeps the SAME live
 *      gateway — no stop, connection never drops to "off",
 *   2) changing only the guild id leaves the socket alone (guild feeds REST only),
 *   3) a real token change stops the old socket AND immediately opens a new one
 *      while a member is still bound.
 *
 * A fake gateway stands in for the real WebSocket, so this needs no Discord
 * credentials and no network. No Electron, no model.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

// Point settings.json / discord-bindings.json at a throwaway dir BEFORE the
// module loads — userDataDir is captured from the env at import time.
const userData = path.join(os.tmpdir(), `ap-discord-settings-${process.pid}`);
rmSync(userData, { recursive: true, force: true });
mkdirSync(userData, { recursive: true });
process.env.AGENTPARTY_USER_DATA = userData;

// Seed a configured bridge with one bound member, so resume() starts a gateway.
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  discord: { desktopName: "T", botToken: "tok-A", guildId: "g-1", allowedUserIds: [] },
}));
writeFileSync(path.join(userData, "discord-bindings.json"), JSON.stringify({
  bindings: [{
    workspacePath: "/ws", party: "p1", member: "main",
    channelId: "c1", channelName: "dev", threadId: "t1", threadName: "main",
  }],
}));

const outDir = path.join(projectRoot, "node_modules/.qa");
mkdirSync(outDir, { recursive: true });
const bundled = await build({
  entryPoints: [path.join(projectRoot, "src/main/discordBridgeService.ts")],
  // `ws` stays external (the real gateway is never constructed here — a fake is
  // injected — and bundling ws's CJS internals breaks under ESM).
  bundle: true, format: "esm", platform: "node", write: false, external: ["electron", "ws"],
});
const bundlePath = path.join(outDir, "discord-bridge-service.mjs");
writeFileSync(bundlePath, bundled.outputFiles[0].text);
const { DiscordBridgeService } = await import(pathToFileURL(bundlePath).href);

// A fake that records lifecycle calls and, like the real one, announces a state
// on start — "connecting" (not "connected", which would trigger a real /me call).
const gateways = [];
class FakeGateway extends EventEmitter {
  constructor(token) { super(); this.token = token; this.started = 0; this.stopped = 0; gateways.push(this); }
  start() { this.started += 1; this.emit("state", "connecting"); }
  stop() { this.stopped += 1; this.emit("state", "off"); }
}

const service = new DiscordBridgeService({
  deliver: async () => ({ delivered: true }),
  createGateway: (token) => new FakeGateway(token),
});

// resume() → one live gateway on the seeded token.
service.resume();
console.log("\nafter resume:");
assert(gateways.length === 1, "exactly one gateway was opened");
assert(gateways[0]?.token === "tok-A", "it uses the stored token");
assert(service.status().connection === "connecting", "bridge is live (connecting), not off");

// 1) The reported bug: add an allowed user, form resubmits token + guild unchanged.
console.log("\nsave: add allowed user (token + guild resubmitted unchanged):");
service.updateSettings({ botToken: "tok-A", guildId: "g-1", allowedUserIds: ["u-1"] });
assert(gateways.length === 1, "no new gateway was created");
assert(gateways[0].stopped === 0, "the live gateway was NOT stopped");
assert(service.status().connection === "connecting", "connection stayed live (regression: was 'off')");
assert(service.status().allowedUserIds.join(",") === "u-1", "the new allowlist was persisted");

// 2) Changing only the guild id must not touch the socket (guild feeds REST only).
console.log("\nsave: change only the guild id:");
service.updateSettings({ botToken: "tok-A", guildId: "g-2", allowedUserIds: ["u-1"] });
assert(gateways.length === 1, "guild-id change opened no new gateway");
assert(gateways[0].stopped === 0, "guild-id change did not stop the gateway");
assert(service.status().connection === "connecting", "connection stayed live across a guild change");

// 3) A real token change stops the old socket AND opens a fresh one (member bound).
console.log("\nsave: change the bot token:");
service.updateSettings({ botToken: "tok-B", guildId: "g-2", allowedUserIds: ["u-1"] });
assert(gateways[0].stopped === 1, "the old gateway was stopped");
assert(gateways.length === 2, "a new gateway was opened on the new token");
assert(gateways[1].token === "tok-B", "the new gateway uses the new token");
assert(gateways[1].started === 1 && gateways[1].stopped === 0, "the new gateway is running");
assert(service.status().connection === "connecting", "inbound is live again after the token change");

rmSync(userData, { recursive: true, force: true });
console.log(failures.length ? `\nFAIL — ${failures.length} assertion(s)` : "\nPASS — Discord settings gateway lifecycle");
process.exit(failures.length ? 1 : 0);
