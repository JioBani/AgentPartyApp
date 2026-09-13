import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import type { RemoteTransport } from "./remoteEngineClient";
import type { SshServerService } from "../../ssh/sshServerService";
import { shellQuote } from "../../ssh/sshTransport";
import { claudeAgentSdkSpec } from "../../claudeSdkVersion";
import { log } from "../../logger";

export interface SshEngineOptions {
  server: string;
  workspacePosix: string;
  serverBundlePath: string;
  codexMcpServerPath: string;
  service: SshServerService;
}

export interface SshEngineHandle { transport: Promise<RemoteTransport>; dispose(): void }

/** Provisions the app-private runtime and hosts the existing engine RPC over SSH stdio. */
export function spawnSshEngine(options: SshEngineOptions): SshEngineHandle {
  let stream: (Duplex & { stderr: Duplex }) | undefined;
  const transport = (async (): Promise<RemoteTransport> => {
    if (!options.workspacePosix.startsWith("/")) throw new Error(`${options.server} 의 작업 경로는 / 로 시작해야 합니다: ${options.workspacePosix}`);
    const connection = await options.service.runtimeConnection(options.server);
    const homeResult = await connection.exec("printf '%s' \"$HOME\"");
    if (homeResult.code !== 0 || !homeResult.stdout.startsWith("/")) throw new Error(`${options.server} 에서 홈 경로를 확인하지 못했습니다: ${homeResult.stderr || homeResult.stdout}`);
    const root = `${homeResult.stdout.trim()}/.agent_party_app`;
    const serverDir = `${root}/server`;
    const ready = await connection.exec(`umask 077; mkdir -p ${shellQuote(serverDir)}; chmod 700 ${shellQuote(root)}`);
    if (ready.code !== 0) throw new Error(`${options.server} 에서 실행 폴더를 만들지 못했습니다: ${ready.stderr}`);
    const lock = `${root}/provision.lock`;
    await acquireProvisionLock(connection, options.server, lock);
    let runtime: { pathExport: string };
    try {
      await uploadAtomically(connection, options.serverBundlePath, `${serverDir}/engine-server.mjs`);
      await uploadAtomically(connection, options.codexMcpServerPath, `${serverDir}/agentparty-codex-mcp-server.mjs`);
      runtime = await ensureNode(connection, options.server, root);
      await ensureSdk(connection, options.server, serverDir, runtime.pathExport);
    } finally {
      await connection.exec(`rmdir ${shellQuote(lock)} 2>/dev/null || true`).catch(() => undefined);
    }
    const command = [
      `cd ${shellQuote(serverDir)}`,
      runtime.pathExport,
      "export AGENTPARTY_REMOTE_HOST_KIND=ssh",
      `export AGENTPARTY_CODEX_MCP_SERVER=${shellQuote(`${serverDir}/agentparty-codex-mcp-server.mjs`)}`,
      `exec node engine-server.mjs --workspace ${shellQuote(options.workspacePosix)} --storage ${shellQuote(root)}`,
    ].filter(Boolean).join(" && ");
    stream = await connection.openProcess(command);
    await waitForReady(stream, options.server);
    log("info", "ssh-engine", "engine server ready", { server: options.server, workspace: options.workspacePosix });
    return { input: stream, output: stream };
  })();
  transport.catch(() => undefined);
  return {
    transport,
    dispose: () => {
      try { stream?.end(); } catch { /* channel already closed */ }
      try { stream?.destroy(); } catch { /* channel already closed */ }
    },
  };
}

async function uploadAtomically(
  connection: Awaited<ReturnType<SshServerService["runtimeConnection"]>>,
  localPath: string,
  remotePath: string,
): Promise<void> {
  const temporary = `${remotePath}.${randomUUID()}.tmp`;
  try {
    await connection.upload(localPath, temporary);
    const moved = await connection.exec(`chmod 600 ${shellQuote(temporary)} && mv -f ${shellQuote(temporary)} ${shellQuote(remotePath)}`);
    if (moved.code !== 0) throw new Error(moved.stderr || `could not replace ${remotePath}`);
  } catch (error) {
    await connection.exec(`rm -f ${shellQuote(temporary)}`).catch(() => undefined);
    throw error;
  }
}

async function acquireProvisionLock(
  connection: Awaited<ReturnType<SshServerService["runtimeConnection"]>>,
  server: string,
  lock: string,
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await connection.exec(
      `mkdir ${shellQuote(lock)} 2>/dev/null || { test -n "$(find ${shellQuote(lock)} -maxdepth 0 -mmin +5 -print 2>/dev/null)" && rmdir ${shellQuote(lock)} 2>/dev/null && mkdir ${shellQuote(lock)}; }`,
    );
    if (result.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${server} 에서 AgentParty 실행 환경 준비가 끝나지 않았습니다`);
}

async function ensureNode(connection: Awaited<ReturnType<SshServerService["runtimeConnection"]>>, server: string, root: string): Promise<{ pathExport: string }> {
  const native = await connection.exec("command -v node");
  if (native.code === 0) return { pathExport: "" };
  const runtime = `${root}/runtime`;
  const present = await connection.exec(`test -x ${shellQuote(`${runtime}/bin/node`)}`);
  if (present.code === 0) return { pathExport: `export PATH=${shellQuote(`${runtime}/bin`)}:\"$PATH\"` };
  const platform = await connection.exec("uname -s; uname -m");
  if (platform.code !== 0) throw new Error(`${server} 의 운영체제를 확인하지 못했습니다: ${platform.stderr}`);
  const [os, arch] = platform.stdout.trim().split(/\s+/);
  const artifact = nodeArtifact(os, arch);
  const archive = `${root}/${artifact}.tar.gz`;
  const checksums = `${root}/SHASUMS256.txt`;
  const install = await connection.exec([
    `mkdir -p ${shellQuote(runtime)}`,
    `curl --fail --location --silent --show-error ${shellQuote(`https://nodejs.org/dist/v22.17.1/${artifact}.tar.gz`)} -o ${shellQuote(archive)}`,
    `curl --fail --location --silent --show-error ${shellQuote("https://nodejs.org/dist/v22.17.1/SHASUMS256.txt")} -o ${shellQuote(checksums)}`,
    `cd ${shellQuote(root)}`,
    `grep ${shellQuote(`  ${artifact}.tar.gz`)} ${shellQuote(checksums)} | { if command -v sha256sum >/dev/null 2>&1; then sha256sum -c -; else shasum -a 256 -c -; fi; } >/dev/null`,
    `tar -xzf ${shellQuote(archive)} -C ${shellQuote(runtime)} --strip-components=1`,
    `rm -f ${shellQuote(archive)} ${shellQuote(checksums)}`,
  ].join(" && "));
  if (install.code !== 0) throw new Error(`${server} 에서 AgentParty 실행 환경을 준비하지 못했습니다: ${install.stderr}`);
  return { pathExport: `export PATH=${shellQuote(`${runtime}/bin`)}:\"$PATH\"` };
}

function nodeArtifact(os: string, arch: string): string {
  const platform = os === "Linux" ? "linux" : os === "Darwin" ? "darwin" : "";
  const cpu = arch === "x86_64" ? "x64" : arch === "aarch64" || arch === "arm64" ? "arm64" : "";
  if (!platform || !cpu) throw new Error(`${os} ${arch} 서버는 지원하지 않습니다. Linux 또는 macOS x64·arm64 서버가 필요합니다.`);
  return `node-v22.17.1-${platform}-${cpu}`;
}

async function ensureSdk(connection: Awaited<ReturnType<SshServerService["runtimeConnection"]>>, server: string, serverDir: string, pathExport: string): Promise<void> {
  const result = await connection.exec([
    `cd ${shellQuote(serverDir)}`,
    pathExport,
    `[ -d node_modules/@anthropic-ai/claude-agent-sdk ] || { npm init -y >/dev/null && npm install --no-audit --no-fund ${shellQuote(claudeAgentSdkSpec())} >/dev/null; }`,
  ].filter(Boolean).join(" && "));
  if (result.code !== 0) throw new Error(`${server} 에서 Claude Code 실행 환경을 준비하지 못했습니다: ${result.stderr}`);
}

function waitForReady(child: Duplex & { stderr: Duplex }, server: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    let settled = false;
    const done = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => done(new Error(`${server} 에서 AgentParty 실행 엔진이 시작되지 않았습니다${stderr ? `: ${stderr.slice(-2000)}` : ""}`)), 60_000);
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes("ENGINE_SERVER_READY")) done();
    });
    child.once("error", (error) => done(new Error(`${server} 의 AgentParty 연결이 끊겼습니다: ${error.message}`)));
    child.once("close", () => done(new Error(`${server} 의 AgentParty 실행 엔진이 준비 전에 종료됐습니다${stderr ? `: ${stderr.slice(-2000)}` : ""}`)));
  });
}
