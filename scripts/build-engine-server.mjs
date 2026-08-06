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

// The engine server must never LOAD Electron — it runs under a distro's node,
// where `electron` does not resolve at all.
//
// Checked on the bundle's own imports, not its inputs: `external: ["electron"]`
// means electron is never an input, so an inputs-only check could never fire.
// It didn't — a top-level `import { clipboard } from "electron"` in
// appController.ts shipped and broke every WSL workspace with
// `WSL engine exited before ready (code 1)`.
//
// A `dynamic-import` is allowed: it only resolves if that code path actually
// runs, so a desktop-only feature can keep its Electron call as long as the
// module graph does not need Electron to LOAD.
const output = result.metafile.outputs[Object.keys(result.metafile.outputs)[0]];
const eager = (output.imports || []).filter((entry) => entry.path === "electron" && entry.kind !== "dynamic-import");
if (eager.length > 0) {
  console.error(`engine-server bundle loads electron eagerly (${eager.map((entry) => entry.kind).join(", ")}) — it must run under a distro's plain node.`);
  console.error("Move the electron use into the method that needs it (`await import(\"electron\")`).");
  process.exit(1);
}

console.log(`built dist/engine-server.mjs`);
