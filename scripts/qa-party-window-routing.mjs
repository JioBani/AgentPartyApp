/*
 * Focused AppController regression for party -> new-window routing.
 *
 * The full Electron E2E covers the user-visible workflow. This fast check uses
 * the production-built controller with a fake engine boundary so an invalid
 * workspace + party-id pair can never regress to opening an unrelated party.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { AppController } = require("../dist/main/application/appController.js");

const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "✓" : "✗"} ${message}`);
  if (!condition) failures.push(message);
};

const workspaceA = "C:\\qa\\workspace-a";
const workspaceB = "C:\\qa\\workspace-b";
const partyA = { id: "party-a", name: "DUPLICATE NAME" };
const partyB = { id: "party-b", name: "DUPLICATE NAME" };
const listings = new Map([
  [workspaceA, { parties: [partyA], currentPartyId: partyA.id, members: [], messages: [] }],
  [workspaceB, { parties: [partyB], currentPartyId: partyB.id, members: [], messages: [] }],
]);
const events = [];
let windowNumber = 0;

const controller = new AppController({
  engineRegistry: {
    forWorkspace(workspacePath) {
      return {
        async listParty() {
          events.push(`list:${workspacePath}`);
          return listings.get(workspacePath) || { parties: [], members: [], messages: [] };
        },
      };
    },
  },
  async openWindow(workspacePath) {
    events.push(`open:${workspacePath}`);
    return { id: `window-${++windowNumber}`, workspacePath, focused: false };
  },
  windowRegistry: {},
  sessionManager: {},
  getRouterBaseUrl: () => "",
  getAutomationBaseUrl: () => "",
  onSettingsChanged() {},
  onWorkspacesChanged() {},
});

console.log("\nParty window routing assertions:");
const opened = await controller.openWindow(workspaceA, partyA.id);
assert(opened.workspacePath === workspaceA, "valid pair opens the requested workspace");
assert(events.join("|") === `list:${workspaceA}|open:${workspaceA}`, "party membership is validated before the window opens");

const beforeMismatch = windowNumber;
let mismatchError = "";
try {
  await controller.openWindow(workspaceB, partyA.id);
} catch (error) {
  mismatchError = error instanceof Error ? error.message : String(error);
}
assert(/does not exist in workspace/.test(mismatchError), "cross-workspace party id fails visibly");
assert(windowNumber === beforeMismatch, "invalid pair creates no window");

const duplicateNameWindow = await controller.openWindow(workspaceB, partyB.id);
assert(duplicateNameWindow.workspacePath === workspaceB, "same-named party opens correctly when its id belongs to the workspace");

console.log("");
if (failures.length) {
  console.log(`PARTY WINDOW ROUTING FAILED: ${failures.length}`);
  process.exit(1);
}
console.log("PARTY WINDOW ROUTING PASSED");
