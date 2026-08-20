/**
 * Which host this process can start a harness on.
 *
 * The desktop can spawn in a Windows directory. An engine running inside a WSL
 * distro can spawn in that distro's filesystem — and only that one. A member
 * carries an execution location, so somebody has to answer "can I run this
 * here?", and the answer must not be guessed from the path: `/srv/app` is a
 * real directory in every distro, so a member pinned to `Ubuntu-24.04` would
 * otherwise start happily on the `Ubuntu-22.04` engine and report success.
 *
 * The desktop leaves this unset; the engine server sets it from `--distro`.
 */

let hostDistro: string | undefined;

/** Names the distro this process serves. Called once, at engine startup. */
export function setHostDistro(distro: string | undefined): void {
  hostDistro = distro?.trim() || undefined;
}

/** The distro this process serves, or `undefined` on the desktop. */
export function getHostDistro(): string | undefined {
  return hostDistro;
}

/** Distro names are compared case-insensitively, as `wsl.exe` treats them. */
export function isHostDistro(distro: string | undefined): boolean {
  return Boolean(hostDistro && distro && hostDistro.toLowerCase() === distro.toLowerCase());
}
