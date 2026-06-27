import type { AgentPartyApi } from "../preload/preload";

declare global {
  interface Window {
    agentParty: AgentPartyApi;
  }
}
