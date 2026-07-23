import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2099.01.01-fake\n");
  process.exit(0);
}
if (args.includes("--list-models")) {
  process.stdout.write([
    "cursor-grok-4.5-low - Cursor Grok 4.5 Low",
    "cursor-grok-4.5-medium - Cursor Grok 4.5 Medium",
    "cursor-grok-4.5-high - Cursor Grok 4.5",
  ].join("\n") + "\n");
  process.exit(0);
}

if (process.env.AGENTPARTY_FAKE_CURSOR_ARGS_OUT) {
  fs.appendFileSync(process.env.AGENTPARTY_FAKE_CURSOR_ARGS_OUT, JSON.stringify(args) + "\n");
}

const resumeAt = args.indexOf("--resume");
const sessionId = resumeAt >= 0 ? args[resumeAt + 1] : "cursor-fake-session";
const emit = (value) => process.stdout.write(JSON.stringify({ ...value, session_id: sessionId }) + "\n");
emit({ type: "system", subtype: "init", model: "Cursor Grok 4.5 High", permissionMode: "default" });
emit({ type: "thinking", subtype: "delta", text: "checking" });

if (process.env.AGENTPARTY_FAKE_CURSOR_NAMED_ERROR === "1") {
  process.stdout.write("ActionRequiredError: Named models unavailable Free plans can only use Auto.\n");
  process.exit(1);
}

if (process.env.AGENTPARTY_FAKE_CURSOR_MCP === "1") {
  emit({
    type: "tool_call",
    subtype: "completed",
    call_id: "tool-mcp",
    tool_call: {
      mcpToolCall: {
        args: { serverIdentifier: "plugin-agentparty-session-agentparty-app", toolName: "list" },
        result: { success: { content: "{\"ok\":true}" } },
      },
      toolCallId: "tool-mcp",
    },
  });
}

emit({
  type: "tool_call",
  subtype: "started",
  call_id: "tool-1",
  tool_call: { readToolCall: { args: { path: "package.json" } }, toolCallId: "tool-1" },
});
emit({
  type: "tool_call",
  subtype: "completed",
  call_id: "tool-1",
  tool_call: { readToolCall: { args: { path: "package.json" }, result: { success: { content: "{}" } } }, toolCallId: "tool-1" },
});
emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "CURSOR_FAKE_OK" }] } });
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "CURSOR_FAKE_OK",
  usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 },
});

const exitDelayMs = Number(process.env.AGENTPARTY_FAKE_CURSOR_EXIT_DELAY_MS || 0);
if (Number.isFinite(exitDelayMs) && exitDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, exitDelayMs));
}
