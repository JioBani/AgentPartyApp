/*
 * Rebuilds a readable AgentParty transcript from a surviving Claude/Codex JSONL
 * session. The existing transcript is backed up and its newer tail is retained.
 *
 * Usage:
 *   node scripts/recover-transcript-from-harness.mjs \
 *     --kind claude --member main --source <session.jsonl> --target <transcript.json>
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = parseArgs(process.argv.slice(2));
for (const required of ["kind", "member", "source", "target"]) {
  if (!args[required]) throw new Error(`Missing --${required}`);
}
if (args.kind !== "claude" && args.kind !== "codex") {
  throw new Error("--kind must be claude or codex");
}
if (!fs.existsSync(args.source)) throw new Error(`Source does not exist: ${args.source}`);
if (!fs.existsSync(args.target)) throw new Error(`Target does not exist: ${args.target}`);

const recovered = [];
let lineNumber = 0;
const input = readline.createInterface({ input: fs.createReadStream(args.source, { encoding: "utf8" }), crlfDelay: Infinity });
for await (const line of input) {
  lineNumber += 1;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    continue;
  }
  if (args.kind === "claude") recoverClaude(record, lineNumber, recovered);
  else recoverCodex(record, lineNumber, recovered);
}

const existingDocument = JSON.parse(fs.readFileSync(args.target, "utf8"));
const existing = Array.isArray(existingDocument?.blocks) ? existingDocument.blocks : [];
const recoveredIds = new Set(recovered.map((block) => block.id));
const retained = existing.filter((block) => !recoveredIds.has(block?.id));
const blocks = [...recovered, ...retained].slice(-800);
if (!blocks.some((block) => block.kind === "user" || block.kind === "assistant" || block.kind === "channel")) {
  throw new Error(`Recovery produced no conversation blocks for ${args.member}`);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${args.target}.recovery-backup-${stamp}`;
const temp = `${args.target}.recovery-${process.pid}.tmp`;
fs.copyFileSync(args.target, backup, fs.constants.COPYFILE_EXCL);
fs.writeFileSync(temp, JSON.stringify({ version: 1, blocks }, null, 2) + "\n", "utf8");
JSON.parse(fs.readFileSync(temp, "utf8"));
fs.renameSync(temp, args.target);

console.log(JSON.stringify({
  ok: true,
  member: args.member,
  kind: args.kind,
  source: args.source,
  target: args.target,
  backup,
  recoveredBlocks: recovered.length,
  retainedBlocks: retained.length,
  writtenBlocks: blocks.length,
}, null, 2));

function recoverClaude(record, line, blocks) {
  if ((record.type !== "user" && record.type !== "assistant") || record.isMeta || record.isSidechain) return;
  const role = record.type;
  const content = record.message?.content;
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const id = String(part?.id || `${record.uuid || `claude-${line}`}:${index}`);
    if (part?.type === "text") {
      appendTextOrChannel(blocks, role, part.text, id, record.timestamp);
    } else if (role === "assistant" && part?.type === "tool_use") {
      appendPartyTool(blocks, part.name, part.input, id, record.timestamp);
    }
  }
}

function recoverCodex(record, line, blocks) {
  if (record.type !== "event_msg") return;
  const payload = record.payload || {};
  if (payload.type === "user_message") {
    appendTextOrChannel(blocks, "user", payload.message, `codex-user-${line}`, record.timestamp);
  } else if (payload.type === "agent_message") {
    appendTextOrChannel(blocks, "assistant", payload.message, `codex-agent-${line}`, record.timestamp);
  } else if (payload.type === "mcp_tool_call_end" && payload.invocation?.server === "agentparty-app") {
    appendPartyTool(
      blocks,
      `mcp__agentparty-app__${payload.invocation.tool || ""}`,
      payload.invocation.arguments,
      String(payload.call_id || `codex-tool-${line}`),
      record.timestamp,
    );
  }
}

function appendTextOrChannel(blocks, role, rawText, id, timestamp) {
  const text = cleanText(rawText);
  if (!text) return;
  const channel = parseChannel(text);
  if (channel) {
    blocks.push({
      id,
      kind: "channel",
      direction: "in",
      source: channel.source,
      from: channel.from,
      to: channel.to || args.member,
      text: channel.text,
      at: displayTime(timestamp),
    });
    return;
  }
  const kind = role === "assistant" ? "assistant" : "user";
  const prior = blocks.at(-1);
  if (prior?.kind === kind) {
    prior.text = `${prior.text}\n\n${text}`;
    return;
  }
  blocks.push({ id, kind, text, at: displayTime(timestamp) });
}

function appendPartyTool(blocks, name, input, id, timestamp) {
  const tool = String(name || "");
  const value = input && typeof input === "object" ? input : {};
  if (tool === "mcp__agentparty-app__send" && typeof value.to === "string" && typeof value.content === "string") {
    blocks.push({ id, kind: "channel", direction: "out", from: "", to: value.to, text: value.content, at: displayTime(timestamp) });
  } else if ((tool === "mcp__agentparty-app__member-create" || tool === "mcp__agentparty-app__member-remove") && typeof value.name === "string") {
    blocks.push({
      id,
      kind: "partyAction",
      action: tool.endsWith("member-create") ? "create" : "remove",
      member: value.name,
      role: stringValue(value.role),
      model: stringValue(value.model),
      harness: stringValue(value.harness),
      at: displayTime(timestamp),
    });
  }
}

function cleanText(value) {
  if (typeof value !== "string") return "";
  let text = value;
  // Codex's first user event contains the full AgentParty primer followed by
  // the actual channel turn. The primer is model context, not conversation.
  if (text.startsWith("# AgentParty — party member session")) {
    const channelStart = text.lastIndexOf("<channel source=");
    if (channelStart < 0) return "";
    text = text.slice(channelStart);
    if (/^<channel source="[^"]+" from="…"/.test(text)) return "";
  }
  return text
    .replace(/\n?<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/\n?<agentparty_role[\s\S]*$/g, "")
    .trim();
}

function parseChannel(text) {
  const match = /^<channel source="(agentparty|discord)" from="([^"]*)"(?: to="([^"]*)")?>\s*([\s\S]*?)\s*<\/channel>/.exec(text);
  if (!match) return undefined;
  return { source: match[1], from: unescapeAttr(match[2]), to: unescapeAttr(match[3] || ""), text: match[4] };
}

function unescapeAttr(value) {
  return value.replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function displayTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function stringValue(value) {
  return typeof value === "string" && value ? value : undefined;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = String(values[index] || "").replace(/^--/, "");
    result[key] = values[index + 1];
  }
  return result;
}
