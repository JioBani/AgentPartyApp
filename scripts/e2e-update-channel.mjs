/* Real Electron product E2E: HTTP and the visible Versions tab both drive the
 * same AppController channel switch and persist it to isolated settings.json. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElectronE2eApp, delay, removePath } from "./lib/electron-e2e.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = path.join(os.tmpdir(), `agentparty-update-channel-${process.pid}`);
const workspace = path.join(base, "workspace");
const userData = path.join(base, "user-data");
const port = 49100 + (process.pid % 400);
const app = createElectronE2eApp({ root, workspace, userData, port, env: { AGENTPARTY_E2E: "1" } });

try {
  await app.prepare();
  await app.launch();
  const spec = await app.get("/api/spec");
  for (const endpoint of ["GET /api/update/channel", "POST /api/update/channel"]) {
    if (!spec.endpoints.includes(endpoint)) throw new Error(`${endpoint} is not registered`);
  }

  const initial = await app.get("/api/update/channel");
  if (initial.channel !== "stable") throw new Error(`new installs must default stable: ${JSON.stringify(initial)}`);

  const beta = await app.post("/api/update/channel", { channel: "beta" });
  if (beta.channel !== "beta" || beta.update.channel !== "beta") throw new Error(`beta switch failed: ${JSON.stringify(beta)}`);
  const storedBeta = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
  if (storedBeta.updateChannel !== "beta") throw new Error("beta channel was not persisted");

  const invalidResponse = await fetch(`${app.baseUrl}/api/update/channel`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: "nightly" }),
  });
  const invalidText = await invalidResponse.text();
  if (invalidResponse.ok || !invalidText.includes("stable") || !invalidText.includes("beta")) {
    throw new Error(`invalid channel did not fail visibly: ${invalidResponse.status} ${invalidText}`);
  }

  await app.post("/api/navigation", { view: "runtime", tab: "versions" });
  await waitForChecked(app, "[data-ver=\"channel-beta\"]", "true");
  const screenshot = path.join(os.tmpdir(), `agentparty-update-channel-ui-${process.pid}.png`);
  await app.post("/api/capture", { path: screenshot });
  if (!fs.existsSync(screenshot) || fs.statSync(screenshot).size < 1_000) throw new Error("Versions tab capture was not written");
  console.log(`UI capture: ${screenshot}`);
  await app.post("/api/capture", { click: "[data-ver=\"channel-stable\"]" });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await app.get("/api/update/channel")).channel === "stable") break;
    await delay(200);
  }
  if ((await app.get("/api/update/channel")).channel !== "stable") throw new Error("visible stable selector did not change the channel");
  await waitForChecked(app, "[data-ver=\"channel-stable\"]", "true");
  const storedStable = JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8"));
  if (storedStable.updateChannel !== "stable") throw new Error("visible channel switch was not persisted");

  console.log("UPDATE CHANNEL E2E PASSED");
  await app.close();
} catch (error) {
  app.kill();
  throw error;
} finally {
  await removePath(base).catch(() => {});
}

async function waitForChecked(app, selector, expected) {
  let last;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      last = await app.post("/api/measure", { selector, attributes: ["aria-checked"] });
      if (last.elements?.[0]?.attributes?.["aria-checked"] === expected) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`selector did not render selected: ${selector} ${JSON.stringify(last)}`);
}
