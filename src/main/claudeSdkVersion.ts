/**
 * Which Claude Agent SDK THIS build ships, and what to install so a WSL distro
 * matches it.
 *
 * Its own module because two unrelated callers need the answer and must not
 * import each other: the WSL engine (which provisions the SDK inside a distro)
 * and the environment screen (which reports and repairs a mismatch).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "./logger";

/**
 * Read off disk rather than from `package.json`'s range: the range (`^0.3.x`)
 * is NOT what got installed, and every consumer here is comparing against a
 * concrete build.
 */
export function claudeSdkVersion(): string | undefined {
  for (const file of sdkPackageJsonCandidates()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // Try the next candidate; a missing file here is normal.
    }
  }
  log("warn", "environment", "could not read the Claude Agent SDK version from disk");
  return undefined;
}

/**
 * What to `npm install` inside a distro.
 *
 * Pinned to the app's EXACT version, not a range. The SDK pins its own native
 * binary to its exact version, so "same range" is not the same runtime — and a
 * range is what let a distro drift to 0.3.201 while the desktop ran 0.3.191,
 * silently, for as long as that distro lived. The range remains only as the
 * fallback for when the version cannot be read at all.
 */
export function claudeAgentSdkSpec(): string {
  const version = claudeSdkVersion();
  return `@anthropic-ai/claude-agent-sdk@${version || "^0.3.186"}`;
}

/** The SDK's `package.json`, wherever this process happens to be running from. */
export function sdkPackageJsonCandidates(): string[] {
  const relative = path.join("node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
  const roots: string[] = [];
  if (process.resourcesPath) {
    roots.push(path.join(process.resourcesPath, "app.asar.unpacked"), path.join(process.resourcesPath, "app.asar"));
  }
  for (let dir = __dirname; ; ) {
    roots.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots.map((root) => path.join(root, relative));
}
