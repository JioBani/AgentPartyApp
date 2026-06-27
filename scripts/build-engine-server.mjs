/*
 * Bundles the headless engine server into dist/engine-server.mjs — a single,
 * Electron-free, dependency-inlined file the desktop copies into a WSL distro
 * and runs with the distro's node. Part of `npm run build`.
 * See docs/WSL_REMOTE.md §8.
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(projectRoot, "dist/engine-server.mjs");

const result = await build({
  entryPoints: [path.join(projectRoot, "src/main/engine/transport/engineServerEntry.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  external: ["electron"],
  logLevel: "silent",
  metafile: true,
});

// The engine server must never need Electron — it runs under a distro's node.
const inputs = Object.keys(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].inputs || {});
if (inputs.some((f) => f === "electron" || f.endsWith("/electron/index.js"))) {
  console.error("engine-server bundle pulled in electron");
  process.exit(1);
}

console.log(`built dist/engine-server.mjs`);
