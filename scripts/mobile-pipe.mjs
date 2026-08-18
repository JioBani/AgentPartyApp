/*
 * Is the optional mobile pipe part of this build?
 *
 * `src/main/mobile/` needs `@agentparty/protocol`, which package.json points at
 * a sibling checkout (`file:../AgentPartyServer/packages/protocol`). npm cannot
 * fetch that from a registry, so on a machine without the server repo the
 * package is simply absent — and the desktop app must still build and run,
 * minus the mobile link.
 *
 * One place decides, so the type check, the compile and the packaging script
 * can never disagree about which build they are producing.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The package the pipe needs. Missing it is expected, not an error. */
export const MOBILE_PIPE_PACKAGE = "@agentparty/protocol";

/**
 * `existsSync` follows symlinks, and npm installs a local-path dependency AS a
 * symlink — so a link left dangling by a deleted sibling checkout reads as
 * missing here, which is what it is.
 */
export function mobilePipeAvailable() {
  return existsSync(path.join(projectRoot, "node_modules", "@agentparty", "protocol", "package.json"));
}

/** The main-process tsconfig for this machine. */
export function mainTsconfig() {
  return mobilePipeAvailable() ? "tsconfig.main.json" : "tsconfig.main.no-mobile.json";
}

/** One line for the build log, so a reduced build is never a silent one. */
export function mobilePipeNotice() {
  return mobilePipeAvailable()
    ? null
    : `${MOBILE_PIPE_PACKAGE} 없음 → 모바일 연결을 뺀 빌드로 진행합니다 (앱의 나머지 기능은 그대로).`;
}
