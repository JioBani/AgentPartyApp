/*
 * Regression for Claude party tools being deferred behind ToolSearch.
 *
 * A sleeping member is recreated with its persisted Claude conversation id.
 * If the in-process agentparty-app server is deferred, ToolSearch may fail to
 * discover `send` and the model misreports that the message server is down.
 * Drive both a fresh and resumed real ClaudeAdapter against a recording SDK and
 * assert that every party tool is kept in the prompt from the first turn.
 */
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = qaTempDir();
const failures = [];
const check = (condition, message) => {
  console.log(`  ${condition ? "PASS" : "FAIL"} - ${message}`);
  if (!condition) failures.push(message);
};

const built = await build({
  entryPoints: [path.join(projectRoot, "src/core/claudeAdapter.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  external: ["electron", "@anthropic-ai/claude-agent-sdk"],
});
const adapterFile = path.join(outDir, "claude-adapter-party-tools.mjs");
writeFileSync(adapterFile, built.outputFiles[0].text);
const { ClaudeAdapter } = await import(pathToFileURL(adapterFile).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function recordingSdk(serverConfigs, queryOptions) {
  let closed = false;
  let release;
  return {
    createSdkMcpServer: (config) => {
      serverConfigs.push(config);
      return { type: "sdk", name: config.name, instance: {} };
    },
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    query: ({ options }) => {
      queryOptions.push(options);
      return {
        initializationResult: async () => ({ commands: [], models: [] }),
        supportedModels: async () => [],
        supportedCommands: async () => [],
        mcpServerStatus: async () => ({}),
        interrupt: async () => {},
        setModel: async () => {},
        applyFlagSettings: async () => {},
        close: () => {
          closed = true;
          release?.();
        },
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            await new Promise((resolve) => { release = resolve; });
          }
        },
      };
    },
  };
}

const bridge = new Proxy({}, {
  get: () => async () => ({ ok: true }),
});

async function verify(label, resumeSessionId) {
  const serverConfigs = [];
  const queryOptions = [];
  const sdk = recordingSdk(serverConfigs, queryOptions);
  const adapter = new ClaudeAdapter({
    id: `party-tools-${label}`,
    cwd: os.tmpdir(),
    model: "claude-opus-5[1m]",
    effort: "high",
    permissionMode: "auto",
    safeMode: true,
    debugEnabled: false,
    storageDir: path.join(outDir, "store"),
    customModelRoutes: [],
    routerBaseUrl: "http://127.0.0.1:3455",
    routerAuthToken: "",
    resumeSessionId,
    partyBridge: bridge,
    partyIdentity: { party: "party-qa", member: "explore" },
    sdkLoader: async () => sdk,
  });

  adapter.start();
  for (let attempt = 0; attempt < 20 && serverConfigs.length === 0; attempt += 1) {
    await sleep(10);
  }

  const server = serverConfigs[0];
  const options = queryOptions[0];
  check(Boolean(server), `${label}: agentparty-app server was created`);
  check(server?.alwaysLoad === true, `${label}: party tools bypass deferred ToolSearch`);
  check(server?.tools?.length === 15, `${label}: all 15 party tools are always available`);
  check(Boolean(options?.mcpServers?.["agentparty-app"]), `${label}: server was attached to the Claude query`);
  check((options?.resume ?? null) === (resumeSessionId ?? null), `${label}: expected conversation resume target was preserved`);
  adapter.dispose();
}

console.log("\nClaude party tool loading:");
await verify("fresh member");
await verify("woken/resumed member", "persisted-claude-thread");

console.log(failures.length ? `\n${failures.length} FAILED` : "\nClaude party tool loading: PASS");
process.exit(failures.length ? 1 : 0);
