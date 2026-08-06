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
import { qaTempDir } from "./lib/qaTemp.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const assert = (c, m) => { console.log(`  ${c ? "✓" : "✗"} ${m}`); if (!c) failures.push(m); };

const outDir = qaTempDir();

async function load(entry, name) {
  const r = await build({ entryPoints: [path.join(projectRoot, entry)], bundle: true, format: "esm", platform: "node", write: false, external: ["electron"] });
  const file = path.join(outDir, name); writeFileSync(file, r.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const { buildTranscriptSave, applyEvents, appendBlock } = await load("src/shared/transcriptEvents.ts", "transcript-events.mjs");
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

// ============ 3) streamed text survives a user message mid-turn ([#14]) ======
// The renderer inserts the user's own message straight into the transcript, so
// it can land BETWEEN two deltas of one reply. The reply must keep filling the
// same block; splitting it left a markdown fence opened in one block and closed
// in another, which renders as broken prose instead of a code block.
console.log("\nappendText across an interjected user message (#14):");
{
  const sid = "s1";
  const deltas = (state, ...texts) => texts.reduce((acc, text) => applyEvents(acc, sid, [{ type: "assistant_text_delta", text }]), state);
  const userTurn = (state, text) => appendBlock(state, sid, { id: "u-" + text, kind: "user", text });

  // The user's turn lands twice: the app's optimistic echo AND the harness's own
  // "sent" status (every adapter emits one — claudeAdapter.ts, codexAdapter.ts).
  // Both must be transparent to the stream; the real app only broke because the
  // second one was not.
  let state = deltas({}, "여기 있습니다:\n\n```ts\nconst a = 1;\n");
  state = userTurn(state, "타입도 붙여줘");
  state = applyEvents(state, sid, [{ type: "status", status: "sent", detail: "타입도 붙여줘" }]);
  state = deltas(state, "const b = 2;\n```\n끝났습니다.");

  const blocks = state[sid];
  const assistants = blocks.filter((b) => b.kind === "assistant");
  assert(assistants.length === 1, "the interrupted reply stays ONE assistant block");
  const fences = (assistants[0].text.match(/```/g) || []).length;
  assert(fences === 2, `the code fence is opened and closed in the same block (found ${fences} markers)`);
  assert(assistants[0].text.includes("const a = 1;") && assistants[0].text.includes("const b = 2;"), "both sides of the interruption are in that block");
  assert(blocks.filter((b) => b.kind === "user").length === 1, "the user's message is still in the transcript, where it was sent");

  // A turn boundary must still close the block, or two replies would merge.
  let next = applyEvents(state, sid, [{ type: "turn_complete", result: "ok" }]);
  next = userTurn(next, "다음 질문");
  next = deltas(next, "새 답변입니다.");
  const replies = next[sid].filter((b) => b.kind === "assistant");
  assert(replies.length === 2, "a completed turn closes the block — the next reply starts a new one");
  assert(replies[1].text === "새 답변입니다.", "…and carries only its own text");

  // Any other block between deltas ends the block exactly as before.
  let tooled = deltas({}, "확인해보겠습니다.");
  tooled = applyEvents(tooled, sid, [{ type: "tool_call", id: "t1", name: "read_file", status: "completed" }]);
  tooled = deltas(tooled, "찾았습니다.");
  assert(tooled[sid].filter((b) => b.kind === "assistant").length === 2, "a tool call between deltas still splits the reply (unchanged)");

  // Only the SENT status is transparent — an ordinary status line is not.
  let noticed = deltas({}, "시작합니다.");
  noticed = applyEvents(noticed, sid, [{ type: "status", status: "interrupted" }]);
  noticed = deltas(noticed, "다시 시작합니다.");
  assert(noticed[sid].filter((b) => b.kind === "assistant").length === 2, "an ordinary status line still splits the reply (only 'sent' is transparent)");
}

console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
