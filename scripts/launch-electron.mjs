/*
 * Launches the Electron app with a clean environment.
 *
 * VSCode / Claude Code integrated terminals export `ELECTRON_RUN_AS_NODE=1`,
 * which makes the `electron` binary boot as plain Node — so `require('electron')`
 * in the main process returns a path string and `app` is undefined
 * (`Cannot read properties of undefined (reading 'whenReady')`). Stripping the
 * var here lets `npm start` work from those terminals. Harmless elsewhere.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// When imported from Node, the electron module resolves to the binary path.
const electronBinary = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronBinary, ["."], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  console.error("Failed to launch Electron:", error);
  process.exit(1);
});
