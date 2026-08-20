import type { AgentPartyApi } from "../preload/preload";
import type { AppearanceBoot } from "../shared/appTheme";

declare global {
  interface Window {
    agentParty: AgentPartyApi;
    agentPartyAppearanceBoot?: AppearanceBoot;
  }
}
