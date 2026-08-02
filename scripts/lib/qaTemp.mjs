/*
 * Where a QA script puts the bundle it is about to import.
 *
 * The unit tests can't import TypeScript, so each one bundles the module under
 * test on the fly, writes it next to nothing in particular, and imports the
 * result. The name of that file is fixed per script — `message-queue.mjs`,
 * `engine-host-mock.mjs` — which is fine, right up until two of them exist.
 *
 * They used to be written under `node_modules/`, and `node_modules/` is SHARED
 * between every worktree on this machine (each worktree's copy is a link to one
 * install). So two lanes running their unit tests at the same time wrote the
 * same path: whoever finished last decided what the other one imported. The
 * losing lane tested the winner's code and saw green. Read mid-write, it saw a
 * half-file instead.
 *
 * That failure is invisible from inside the test — the assertions pass, the
 * summary is green, and nothing anywhere says which source it actually ran
 * against. Four times in one day this project has believed a green that came
 * from someone else's code. This is the fourth.
 *
 * So the bundle goes in the worktree, which is the thing a lane actually owns.
 * Node still resolves bare imports from here: it walks up and finds the
 * worktree's own `node_modules` link.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** This checkout's root — the worktree, not whatever it shares. */
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Directory for this worktree's QA bundles, created on demand.
 *
 * Deliberately NOT under `node_modules`: that is a shared install, and writing
 * build output into it makes one lane's test another lane's input. It is also
 * governed by the "only one person touches dependencies" rule, so anything
 * living there is at risk from a routine cleanup — which is how these bundles
 * were silently deleted once already.
 */
export function qaTempDir() {
  const dir = path.join(projectRoot, ".qa");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Full path for one named bundle in this worktree. */
export function qaTempFile(name) {
  return path.join(qaTempDir(), name);
}
