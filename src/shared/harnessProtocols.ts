import type { HarnessId } from "./types";

/**
 * The conversation/tool wire contract belongs to the harness, never the model.
 * A provider destination may translate this contract internally, but selecting a
 * GPT/Claude/OpenRouter model must not change the protocol emitted by the harness.
 *
 * Adding a future harness requires one protocol registration plus its adapter;
 * model/provider catalog entries stay independent of that addition.
 */
export const HARNESS_PROTOCOLS = {
  "claude-code": {
    id: "anthropic-messages",
    wireApi: "messages",
    endpoint: "messages",
  },
  codex: {
    id: "openai-responses",
    wireApi: "responses",
    endpoint: "responses",
  },
  cursor: {
    id: "cursor-agent-ndjson",
    wireApi: "cursor-agent",
    endpoint: "cli",
  },
} as const satisfies Record<HarnessId, {
  id: string;
  wireApi: string;
  endpoint: string;
}>;

export type HarnessProtocol = (typeof HARNESS_PROTOCOLS)[HarnessId];

export function harnessProtocolFor(harnessId: HarnessId): HarnessProtocol {
  return HARNESS_PROTOCOLS[harnessId];
}
