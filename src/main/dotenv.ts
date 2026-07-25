import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Loads `KEY=value` lines from a `.env` next to the app source, for development
 * and QA only. Values already present in the environment WIN — a shell export or
 * a QA script must never be shadowed by a stale file.
 *
 * Production credentials belong in settings.json (outside the repo); this exists
 * so a dev machine can hold e.g. DISCORD_BOT_TOKEN without pasting it into the UI
 * on every fresh workspace. Which keys were picked up is returned so the caller
 * can log the source — a credential whose origin is a mystery is a debugging trap.
 */
export function loadDotEnv(dir: string = process.cwd()): string[] {
  const file = path.join(dir, ".env");
  let text: string;
  try {
    if (!fs.existsSync(file)) {
      return [];
    }
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const applied: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    const value = raw.replace(/^["']|["']$/g, "");
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}
