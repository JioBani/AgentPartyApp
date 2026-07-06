/*
 * LIVE full-stack e2e against the RUNNING AgentParty app (not in the suite —
 * billed; needs the app launched on the WSL QA workspace). Drives only the
 * public HTTP automation API, exactly as an external QA agent would, and
 * verifies the in-process party tools end to end through the real application:
 *
 *   main (real session) --list-models--> catalog
 *                        --member-create--> reviewer (auto-started real session)
 *                        --send----------> reviewer
 *   reviewer (real session) --send--------> main (PONG)
 *
 * Asserts via party state (GET /api/party): reviewer is created with the chosen
 * model + reasoning, the main->reviewer message is delivered, and reviewer
 * replies back to main — the whole loop, in the actual app.
 */
import { firstBaseUrl } from "./lib/discovery.mjs";

// Drive whichever app is serving the QA workspace (per-workspace discovery).
const workspace = process.env.QA_WS || `wsl+${process.env.QA_WSL_DISTRO || "Ubuntu-22.04"}:${process.env.QA_WSL_WS || "/home/dev/agentparty-wsl-e2e"}`;
const baseUrl = process.env.QA_BASE || firstBaseUrl(workspace);
if (!baseUrl) { console.error(`No running AgentParty found for ${workspace}. Open it first (agent-party) or set QA_BASE.`); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const assert = (cond, msg) => { console.log(`  ${cond ? "✓" : "✗"} ${msg}`); if (!cond) failures.push(msg); };

const get = (p) => fetch(baseUrl + p).then((r) => r.json());
const post = (p, body) => fetch(baseUrl + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) => r.json());

console.log(`Full-stack party e2e against running app @ ${baseUrl}:`);

// Clean any leftover reviewer from a previous run, then start main fresh.
await post("/api/party/members/reviewer/remove", {}).catch(() => {});
const started = await post("/api/party/members/main/start", { model: "sonnet", effort: "low", permissionMode: "default" });
const mainSession = started?.session?.id;
assert(Boolean(mainSession), `main session started (${mainSession})`);

const instruction =
  "You are 'main' in an Agent Party. Use your agentparty-app party tools to do EXACTLY this, in order:\n" +
  "1) Call list-models.\n" +
  "2) member-create with: name='reviewer', role='Code reviewer', harness='claude-code', model='sonnet', reasoning='enabled'.\n" +
  "3) send to 'reviewer' the content: \"Reply to main now by using YOUR send tool to message 'main' with exactly the text PONG.\"\n" +
  "4) Reply to me with DONE.\n" +
  "Actually call the tools — do not simulate or describe.";
await post("/api/party/messages", { to: "main", from: "user", content: instruction });
console.log("  instruction delivered to main; awaiting the real tool loop (up to 180s)…\n");

let reviewer = null;
let mainToReviewer = false;
let reviewerToMain = null;
for (let i = 0; i < 180; i++) {
  const party = await get("/api/party").catch(() => null);
  const members = party?.members || [];
  const messages = party?.messages || [];
  reviewer = members.find((m) => m.name === "reviewer") || reviewer;
  mainToReviewer = mainToReviewer || messages.some((m) => m.from === "main" && m.to === "reviewer");
  reviewerToMain = reviewerToMain || messages.find((m) => m.from === "reviewer" && m.to === "main");
  if (reviewer && mainToReviewer && reviewerToMain) break;
  if (i % 10 === 0) process.stdout.write(`    · t=${i}s members=[${members.map((m) => m.name + ":" + m.status).join(", ")}] msgs=${messages.length}\n`);
  await sleep(1000);
}

const finalParty = await get("/api/party");
console.log("\n  final messages:");
for (const m of finalParty.messages || []) console.log(`    ${m.from} -> ${m.to}: ${JSON.stringify(String(m.content).slice(0, 60))}${m.delivered ? "" : " (queued)"}`);
console.log("");

assert(Boolean(reviewer), "member-create created 'reviewer' via the party tool");
assert(reviewer?.model === "sonnet", `reviewer was created with the chosen model (got ${reviewer?.model})`);
assert(reviewer?.reasoning === "enabled", `reviewer was created with the chosen reasoning (got ${reviewer?.reasoning})`);
assert(["running", "missing_session", "opened"].includes(reviewer?.status), `reviewer session was auto-started (status ${reviewer?.status})`);
assert(mainToReviewer, "main delivered a message to reviewer (send tool)");
assert(Boolean(reviewerToMain), "reviewer replied back to main (bidirectional send loop)");
assert(/pong/i.test(reviewerToMain?.content || ""), `reviewer's reply contained PONG (got ${JSON.stringify(reviewerToMain?.content?.slice(0, 40))})`);

// Cleanup so re-runs start clean.
await post("/api/party/members/reviewer/remove", {}).catch(() => {});

console.log(failures.length ? `\nAPP PARTY e2e FAILED (${failures.length})` : "\nAPP PARTY e2e PASSED (full loop ran in the real app)");
process.exit(failures.length ? 1 : 0);
