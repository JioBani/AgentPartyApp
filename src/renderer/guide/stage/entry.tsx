/**
 * Stage iframe entry. Installs the fake bridge FIRST, then loads the app.
 *
 * The import of `StageRoot` is dynamic on purpose: it pulls in the whole `App`
 * module graph, and anything in there that reads `window.agentParty` while its
 * module body runs must find the fake one already in place.
 */
import { createFakeAgentParty } from "./fakeAgentParty";

const fake = createFakeAgentParty();
Object.defineProperty(window, "agentParty", { value: fake.api, configurable: true });

void import("./StageRoot").then(({ mountStage }) => mountStage(fake));
