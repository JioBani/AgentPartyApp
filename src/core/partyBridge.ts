import { z } from "zod";

// Boundary 2 of the party-communication design (docs/PARTY_COMMUNICATION.md):
// the seam through which an app-hosted member session reaches the app's party
// features. The handler implementations live in the main process
// (`PartyApplicationService`); this interface lets `core` build the in-process
// MCP tool surface without importing anything from `main`.
//
// A bridge instance is always paired with a `PartyIdentity` bound at session
// construction, so the agent never states (and cannot spoof) who it is — that is
// where "zero model-memory reliance" comes from.

export interface PartyIdentity {
  /** The party this session's member belongs to. */
  party: string;
  /** This session's member name — stamped as `from` on every send. */
  member: string;
}

export interface PartyToolResult {
  ok: boolean;
  /** Human-readable reason when `ok` is false (surfaced to the agent verbatim). */
  error?: string;
  /** Optional structured payload for info requests (list / listModels). */
  data?: unknown;
}

export interface PartyCreateMemberRequest {
  name: string;
  role: string;
  /** Harness id; `claude-code` is implemented, `codex` is accepted but rejected. */
  harness?: string;
  model?: string;
  /** Reasoning/thinking mode (adaptive|enabled|disabled) for the new member. */
  reasoning?: string;
  reasoningBudget?: number;
  effort?: string;
}

// The capability surface a hosted member can drive. Every method routes through
// the same `AppController`/`PartyApplicationService` path the UI and HTTP use,
// and resolves to a plain result (never throws) so tool handlers stay trivial.
export interface PartyBridge {
  /** Fire-and-forget send to another member; errors if target is off/missing. */
  send(from: string, to: string, content: string): Promise<PartyToolResult>;
  /** Create a member in the caller's own party and auto-start its session. */
  createMember(request: PartyCreateMemberRequest): Promise<PartyToolResult>;
  /** Remove a member from the caller's own party (cannot remove `main`). */
  removeMember(name: string): Promise<PartyToolResult>;
  /** List the caller's party members and their status. */
  list(): Promise<PartyToolResult>;
  /** Discover available harnesses + models + per-model reasoning options. */
  listModels(): Promise<PartyToolResult>;
}

/** MCP server name for the in-process party tool surface. */
export const PARTY_MCP_SERVER = "agentparty-app";
/** Namespaced prefix of the party tools as the agent sees them (mcp__<server>__<tool>). */
export const PARTY_TOOL_PREFIX = `mcp__${PARTY_MCP_SERVER}__`;

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}
/** Minimal structural type of the SDK's `tool(...)` factory (avoids importing the SDK here). */
type ToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<McpToolResult>,
) => unknown;

/**
 * Builds the party tool definitions for the in-process MCP server. Pure and
 * SDK-agnostic (the `tool` factory is injected), so it is unit-testable without
 * spawning a session: each returned def carries a `.handler` that routes to the
 * bridge with the caller's identity closure-bound (`from` is never agent input).
 */
export function buildPartyToolDefs(tool: ToolFactory, bridge: PartyBridge, identity: PartyIdentity): unknown[] {
  const envelope = (result: PartyToolResult): McpToolResult => ({
    content: [{ type: "text", text: JSON.stringify(result.data ?? { ok: result.ok, error: result.error }) }],
    isError: !result.ok,
  });
  return [
    tool(
      "send",
      "Send a message to another member of your party. Fire-and-forget: it delivers to the recipient's live session (their reply comes back later as their own message). Errors if the recipient is not running or does not exist.",
      { to: z.string().describe("Recipient member name in your party."), content: z.string().describe("Message body.") },
      async (args: { to: string; content: string }) => envelope(await bridge.send(identity.member, args.to, args.content)),
    ),
    tool(
      "member-create",
      "Create a new member in your party and start its session. You choose the harness, model, and reasoning — call list-models first to see valid options. harness='codex' is accepted but not implemented yet.",
      {
        name: z.string().describe("New member name (letters, digits, _ or -)."),
        role: z.string().describe("Short role description for the new member."),
        harness: z.string().optional().describe("Harness id (e.g. 'claude-code'). Defaults to claude-code."),
        model: z.string().optional().describe("Model id from list-models."),
        reasoning: z.string().optional().describe("Reasoning/thinking mode: adaptive | enabled | disabled."),
        reasoningBudget: z.number().optional().describe("Thinking token budget when applicable."),
        effort: z.string().optional().describe("Effort level: low | medium | high | xhigh | max."),
      },
      async (args: { name: string; role: string; harness?: string; model?: string; reasoning?: string; reasoningBudget?: number; effort?: string }) =>
        envelope(await bridge.createMember(args)),
    ),
    tool(
      "member-remove",
      "Remove a member from your party (cannot remove 'main'). Closes its session if running.",
      { name: z.string().describe("Member name to remove.") },
      async (args: { name: string }) => envelope(await bridge.removeMember(args.name)),
    ),
    tool("list", "List your party's members and their current status.", {}, async () => envelope(await bridge.list())),
    tool(
      "list-models",
      "Discover the harnesses and models available for member-create, including each model's reasoning options, performance, cost, and context window.",
      {},
      async () => envelope(await bridge.listModels()),
    ),
  ];
}
