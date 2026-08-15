/*
 * Every route in the capability table must be documented in docs/API.md.
 *
 * HTTP↔mobile parity is guaranteed by construction — one table entry serves
 * both transports — but DOCUMENTATION is not, and an undocumented endpoint is
 * invisible to the agents and to the mobile member writing a client against it.
 * Three had already slipped through before this check existed.
 *
 * Run: node scripts/qa-api-doc-coverage.mjs   (after `npm run build`)
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { methodRoutes } = require(path.join(root, "dist", "main", "api", "methodRoutes.js"));
const { QA_ENDPOINTS } = require(path.join(root, "dist", "main", "automation", "qaRoutes.js"));
const doc = fs.readFileSync(path.join(root, "docs", "API.md"), "utf8");

/**
 * A path counts as documented when it appears in a heading. The verb is NOT
 * required to sit next to it: several endpoints are documented as one combined
 * section (`### \`GET\` / \`POST /api/party/layout\``), and splitting those to
 * satisfy a checker would make the document worse.
 */
const headings = doc.split("\n").filter((line) => line.startsWith("#")).join("\n");

const missing = [];
for (const route of [...methodRoutes.routes.map((r) => r.http), ...QA_ENDPOINTS]) {
  const [, endpointPath] = route.split(" ");
  if (!headings.includes(endpointPath)) {
    missing.push(route);
  }
}

const total = methodRoutes.routes.length + QA_ENDPOINTS.length;
if (missing.length) {
  console.error(`✗ ${missing.length} of ${total} endpoints are not documented in docs/API.md:`);
  for (const route of missing) console.error(`  - ${route}`);
  console.error("\nAdd a `### `<VERB> <path>`` section for each, then re-run.");
  process.exit(1);
}
console.log(`✓ all ${total} endpoints are documented in docs/API.md`);
