/*
 * Incremental transcript persistence — unit test of the append protocol.
 *
 * The renderer used to ship a member's ENTIRE transcript on every debounced
 * save. On a WSL workspace those saves share one stdio RPC pipe with
 * `sendUserTurn`, so a 25 MB transcript queued ahead of a user turn delayed it
 * by 33 s (no reasoning shown — the turn had not reached the harness yet).
 * Saves are now anchored appends. This locks in both halves:
 *   1) buildTranscriptSave  — renderer-side delta from the identity-equal prefix,
 *   2) writeTranscript      — engine-side anchoring, including the cases where an
 *                             append MUST be refused rather than misapplied.
 * No Electron, no model — pure logic + fs.
 */
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };
const outDir = path.join(projectRoot, "node_modules/.qa"); mkdirSync(outDir, { recursive: true });

async function load(entry, name) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
  const file = path.join(outDir, name); writeFileSync(file, r.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const { buildTranscriptSave } = await load("src/renderer/app/transcriptEvents.ts", "transcript-events.mjs");
const { PartyRepository } = await load("src/main/partyRepository.ts", "party-repo-append.mjs");

const block = (id, text) => ({ id, kind: "assistant", text });

// ============ 1) renderer-side delta ============
console.log("\nbuildTranscriptSave (renderer delta):");
{
  const a = block("a", "1"), b = block("b", "2"), c = block("c", "3");

  const first = buildTranscriptSave(undefined, [a, b]);
  assert(first.afterId === undefined && first.blocks.length === 2, "no persisted history → full save");

  const appended = buildTranscriptSave([a, b], [a, b, c]);
  assert(appended.afterId === "b", "append anchors on the last persisted block");
  assert(appended.blocks.length === 1 && appended.blocks[0].id === "c", "append ships ONLY the new block");

  // A streamed block is rebuilt immutably, so identity — not id — marks the change.
  const bGrown = { ...b, text: "2 more" };
  const mutated = buildTranscriptSave([a, b], [a, bGrown, c]);
  assert(mutated.afterId === "a", "a mutated block breaks the prefix at its own index");
  assert(mutated.blocks.length === 2, "the mutated block is resent along with what follows");

  const unchanged = buildTranscriptSave([a, b], [a, b]);
  assert(unchanged.afterId === "b" && unchanged.blocks.length === 0, "no change → empty append, not a full resend");

  const truncated = buildTranscriptSave([a, b, c], [a]);
  assert(truncated.afterId === "a" && truncated.blocks.length === 0, "a shrunk transcript truncates from the shared prefix");

  const idless = buildTranscriptSave([{ kind: "assistant", text: "x" }], [{ kind: "assistant", text: "x" }, c]);
  assert(idless.afterId === undefined, "an anchor block without an id falls back to a full save");
}

// ============ 2) engine-side anchoring ============
console.log("\nwriteTranscript (engine anchoring):");
{
  const ws = path.join(os.tmpdir(), `ap-transcript-append-${process.pid}`);
  rmSync(ws, { recursive: true, force: true });
  mkdirSync(path.join(ws, ".agent_party_app"), { recursive: true });
  const repo = new PartyRepository();
  const read = () => repo.readTranscript(ws, "p1", "main");

  repo.writeTranscript(ws, "p1", "main", { blocks: [block("a", "1"), block("b", "2")] });
  assert(read().length === 2, "full save writes the whole transcript");

  const ok = repo.writeTranscript(ws, "p1", "main", { afterId: "b", blocks: [block("c", "3")] });
  assert(ok.applied === true, "append with a valid anchor is applied");
  assert(read().map((x) => x.id).join(",") === "a,b,c", "append preserves history and adds the new block");

  const replaced = repo.writeTranscript(ws, "p1", "main", { afterId: "a", blocks: [block("b2", "new")] });
  assert(replaced.applied === true && read().map((x) => x.id).join(",") === "a,b2", "append REPLACES everything after the anchor");

  const bad = repo.writeTranscript(ws, "p1", "main", { afterId: "nope", blocks: [block("z", "9")] });
  assert(bad.applied === false, "an unanchorable append is refused");
  assert(read().map((x) => x.id).join(",") === "a,b2", "a refused append leaves the stored transcript untouched");

  // The refusal must not be a silent full-write: that would persist a fragment
  // as the whole history — the SEL-6910 conversation-loss shape.
  assert(read().length === 2, "a refused append never truncates history to the fragment");

  // Anchoring must survive a cold cache (a fresh process re-reads the file).
  const cold = new PartyRepository();
  const coldOk = cold.writeTranscript(ws, "p1", "main", { afterId: "b2", blocks: [block("d", "4")] });
  assert(coldOk.applied === true, "a cold repository anchors by reading the file");
  assert(cold.readTranscript(ws, "p1", "main").map((x) => x.id).join(",") === "a,b2,d", "cold-cache append is correct");

  rmSync(ws, { recursive: true, force: true });
}

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
