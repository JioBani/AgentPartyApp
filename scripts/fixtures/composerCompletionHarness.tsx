import { Composer } from "../../src/renderer/workbench/Composer";
import { usePublishModelRoutes } from "../../src/renderer/app/modelRoutePrefs";
import { usePublishPartyMembers } from "../../src/renderer/app/partyMemberPrefs";
import type { RouteLike } from "../../src/renderer/workbench/routes";
import type { MentionCandidate } from "../../src/renderer/workbench/mentionModel";
export { MessageText } from "../../src/renderer/workbench/messageTokens";

export function ComposerCompletionHarness(props: {
  members: MentionCandidate[];
  routes: RouteLike[];
  view: Parameters<typeof Composer>[0]["view"];
  actions: Parameters<typeof Composer>[0]["actions"];
  commandUi: Parameters<typeof Composer>[0]["commandUi"];
}) {
  usePublishPartyMembers(props.members);
  usePublishModelRoutes(props.routes);
  return <Composer view={props.view} density="wide" actions={props.actions} commandUi={props.commandUi} />;
}
