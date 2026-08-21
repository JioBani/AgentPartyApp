/*
 * Member list grouping, provider resolution and tool-outcome mapping.
 *
 * All three are pure functions behind the UI that changed, so they are exercised
 * directly rather than through the DOM: what matters here is that a WSL member
 * never lands under Windows, that the icon beside a member names the company
 * whose model is answering, and that a refused tool call can never come out as
 * a success. The rendering itself is covered by qa-render.mjs.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (condition, message) => {
  console.log(`  ${condition ? "\u2713" : "\u2717"} ${message}`);
  if (!condition) failures.push(message);
};

const outDir = qaTempDir();
async function load(entry, name) {
  const result = await build({
    entryPoints: [path.join(projectRoot, entry)],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  const file = path.join(outDir, name);
  writeFileSync(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const groups = await load("src/renderer/workbench/memberGroups.ts", "member-groups.mjs");
const provider = await load("src/renderer/workbench/modelProvider.ts", "model-provider.mjs");
const outcome = await load("src/renderer/workbench/toolOutcome.ts", "tool-outcome.mjs");

const member = (name, location) => ({ name, member: location === undefined ? {} : { location } });

console.log("\nhost / cwd grouping:");
{
  const tree = groups.groupMembersByLocation([
    member("api", "C:\\Project\\App"),
    member("web", "c:\\project\\app"),
    member("svc", "wsl+Ubuntu-24.04:/srv/app"),
    member("legacy", undefined),
    member("docs", "C:\\Project\\Docs"),
  ]);
  assert(tree.map((host) => host.host).join(",") === "windows,wsl,unknown", "hosts come out in a fixed order, unknown last");
  const windows = tree[0];
  assert(windows.count === 3, "the host section counts every member under it");
  assert(windows.groups.length === 2, "two Windows directories, not three");
  const app = windows.groups.find((group) => group.cwd.toLowerCase().endsWith("app"));
  assert(app.members.map((view) => view.name).join(",") === "api,web", "case differences are one Windows directory, and member order is preserved");
  assert(tree[1].groups[0].distro === "Ubuntu-24.04", "a WSL group carries the distro a POSIX path alone cannot identify");
  assert(tree[2].groups[0].members[0].name === "legacy", "a member with no stored location still appears, under its own bucket");
}
{
  const same = (a, b) => groups.cwdGroupId(a) === groups.cwdGroupId(b);
  assert(same({ env: "windows", cwd: "C:\\Proj\\" }, { env: "windows", cwd: "c:\\proj" }), "trailing separators and case do not split a Windows directory");
  assert(!same({ env: "wsl", cwd: "/srv/A", distro: "U" }, { env: "wsl", cwd: "/srv/a", distro: "U" }), "\u2026but a distro's filesystem stays case-sensitive");
  assert(!same({ env: "windows", cwd: "/srv/app" }, { env: "wsl", cwd: "/srv/app", distro: "U" }), "the same path on two hosts is two groups");
}
{
  const { head, tail } = groups.splitPathTail("C:\\Users\\Dev\\AppData\\Roaming\\AgentParty\\worktrees\\member-cwd-groups");
  assert(tail === "member-cwd-groups", "the directory name is split off so truncation cannot eat it");
  assert(head === "C:\\\u2026\\", `a deep prefix is shortened here, not left for CSS to clip to a fragment (got ${head})`);
  assert(groups.splitPathTail("C:\\Project\\App").head === "C:\\\u2026\\", "every shortened prefix is the same width, so CSS never clips one to a bare drive letter");
  assert(groups.splitPathTail("C:\\App").head === "C:\\", "a path with no ancestors keeps its root as-is");
  assert(groups.splitPathTail("/home/dev/services/gateway").head === "/\u2026/", "a posix prefix shortens the same way, keeping its root slash");
  assert(groups.splitPathTail("/srv/app").head === "/…/", "…and the posix form matches it");
  assert(groups.splitPathTail("/srv").tail === "srv", "a one-segment posix path is all tail");
  assert(groups.splitPathTail("").tail === "", "an empty path does not throw");
}

console.log("\nmodel provider (the icon names the model's company, not the harness):");
{
  const routes = [
    { harnessId: "codex", providerId: "openai", model: "gpt-5.6" },
    { harnessId: "codex", providerId: "openai", modelProvider: "deepseek", model: "deepseek-v4" },
    { harnessId: "claude-code", providerId: "anthropic", model: "claude-opus-5" },
  ];
  assert(provider.providerForModel("claude-opus-5", routes) === "anthropic", "an Anthropic model resolves to Anthropic");
  assert(provider.providerForModel("gpt-5.6", routes) === "openai", "an OpenAI model resolves to OpenAI");
  assert(provider.providerForModel("deepseek-v4", routes) === "deepseek", "a Codex custom provider outranks the route's own account provider");
  assert(provider.providerForModel("something-nobody-has-heard-of", routes) === undefined, "an unknown model resolves to nothing rather than to the nearest brand");
  assert(provider.providerForModel(undefined, routes) === undefined, "no model, no provider");
  assert(provider.providerForModel("claude-opus-5") === "anthropic", "the catalog answers even before any route list arrives");
  assert(provider.providerLabel(undefined) === "Unknown provider", "the fallback still has a name for its tooltip");
  assert(provider.providerLabel("xai") === "xAI" && provider.providerLabel("openai") === "OpenAI", "labels name the company, not the subscription");
}

console.log("\ntool outcome (a refusal must never render as success):");
{
  const of = outcome.toolOutcomeOf;
  assert(of({ status: "started" }) === "running", "an issued call is running");
  assert(of({ status: "completed" }) === "ok", "a call that closed with nothing reported is a success");
  assert(of({ status: "completed", exitCode: 0 }) === "ok", "exit 0 is a success");
  assert(of({ status: "completed", exitCode: 2 }) === "failed", "a non-zero exit is a failure even though the call 'completed'");
  assert(of({ status: "failed" }) === "failed", "a reported error is a failure");
  assert(of({ status: "denied" }) === "denied", "a refusal is its own outcome, not a failure");
  assert(of({}) === "ok", "a block with no status at all falls back to the neutral finished state");
  assert(of({ status: "denied", result: "The tool use was rejected" }) === "denied", "the outcome comes from the status field, never from the message text");
  assert(outcome.isToolProblem("denied") && outcome.isToolProblem("failed"), "both non-success outcomes are marked as problems");
  assert(!outcome.isToolProblem("ok") && !outcome.isToolProblem("running"), "\u2026and neither success nor progress is");
}

console.log(failures.length ? `\nFAILED: ${failures.length} assertion(s)` : "\nAll member grouping / provider / tool outcome assertions passed");
process.exit(failures.length ? 1 : 0);
