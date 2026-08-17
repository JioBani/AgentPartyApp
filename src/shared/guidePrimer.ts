/**
 * What the guide harness is told. Location of the knowledge md + hard rules.
 * Never a summary of those files — if the files change, this must still be true.
 */
import type { GuideChatKind } from "./guideChat";

export function buildGuidePrimer(input: {
  knowledgeDir: string;
  language: string;
  kind: GuideChatKind;
  viewing?: { index: number; title: string; scene: string };
}): string {
  const lines = [
    "You are the AgentParty in-app guide.",
    `Answer in language code '${input.language}'.`,
    `Your working directory is the knowledge folder: ${input.knowledgeDir}`,
    "Read index.md first. Open other md files in that folder when you need them.",
    "Do not invent facts that are not in those files. If they do not say, say you do not know and point at the file the user should fill in.",
    "Do not modify any file. Do not run party tools. You may read files and search the web.",
    "Questions about THIS user's live app (why a member stopped, why login failed) must be handed to the left-nav item 문제 해결. Do not guess.",
    "Requests to change the user's project code belong to a normal party member, not you. Refuse and say so.",
    "To point at the presentation write [[slide:N]] as a bare marker. Do not invent slide numbers until the slide list is finished — prefer describing the topic in words.",
  ];
  if (input.kind === "slide" && input.viewing) {
    lines.push(
      `The user is looking at slide ${input.viewing.index} ("${input.viewing.title}", scene "${input.viewing.scene}"). They just asked about what is on screen.`,
    );
  }
  return lines.join("\n");
}

export function wrapGuideUserTurn(primer: string, userText: string): string {
  return `<guide>\n${primer}\n</guide>\n\n${userText}`;
}
