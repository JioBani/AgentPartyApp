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
import { existsSync, lstatSync, rmSync, rmdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The package the pipe needs. Missing it is expected, not an error. */
export const MOBILE_PIPE_PACKAGE = "@agentparty/protocol";

const pipeLink = () => path.join(projectRoot, "node_modules", "@agentparty", "protocol");

/**
 * `existsSync` follows symlinks, and npm installs a local-path dependency AS a
 * symlink — so a link left dangling by a deleted sibling checkout reads as
 * missing here, which is what it is.
 */
export function mobilePipeAvailable() {
  return existsSync(path.join(pipeLink(), "package.json"));
}

/**
 * Removes the DANGLING symlink npm leaves behind for this package.
 *
 * npm links a local-path dependency by path, without requiring the target to
 * exist, so a machine without the AgentPartyServer checkout ends up with
 * `node_modules/@agentparty/protocol` pointing at nothing. `@electron/rebuild`
 * — which electron-builder runs before packaging — stats every entry under
 * node_modules and dies on it:
 *
 *   ⨯ ENOENT: no such file or directory, stat '…\node_modules\@agentparty\protocol'
 *
 * Deleting a link that resolves to nothing removes no information: it cannot be
 * read, imported, or packaged. It comes back on the next `npm install`, which is
 * why this runs as a build step rather than once by hand.
 *
 * Returns the removed path (for the caller to announce) or null.
 */
export function pruneBrokenPipeLink() {
  const link = pipeLink();
  let entry;
  try {
    entry = lstatSync(link);
  } catch {
    return null; // not installed at all — nothing to prune
  }
  // A real directory (someone copied the package in) or a live link: keep it.
  if (!entry.isSymbolicLink() || existsSync(link)) {
    return null;
  }
  rmSync(link, { force: true });
  // `rmdirSync` refuses a non-empty directory, which is exactly the guard we
  // want: the scope dir is npm's, and it goes only when this link emptied it.
  try { rmdirSync(path.dirname(link)); } catch { /* still holds something: leave it */ }
  return link;
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
