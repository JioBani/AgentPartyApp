import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../App";
import { ThemeProvider, useTheme } from "../../theme/ThemeProvider";
import type { FakeAgentParty } from "./fakeAgentParty";
import {
  GUIDE_STAGE_APPLY,
  GUIDE_STAGE_READY,
  type GuideStageMessage,
} from "../../../shared/guideStage";
import "../../design-system.css";
import "../../styles.css";

export function mountStage(fake: FakeAgentParty): void {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("가이드 무대의 #root 가 없습니다.");
  }
  // No StrictMode here. Its double-mount would replay the slide's session events
  // twice, and the stage is a picture the user reads — it has to be exactly the
  // state the chrome asked for.
  createRoot(root).render(
    <ThemeProvider>
      <Stage fake={fake} />
    </ThemeProvider>,
  );
}

function Stage({ fake }: { fake: FakeAgentParty }) {
  const { setTheme } = useTheme();
  const [generation, setGeneration] = useState(-1);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) {
        return;
      }
      const message = event.data as GuideStageMessage | undefined;
      if (!message || message.type !== GUIDE_STAGE_APPLY) {
        return;
      }
      fake.applySnapshot(message.snapshot);
      setTheme(message.themeId);
      setGeneration(message.generation);
    };
    window.addEventListener("message", onMessage);
    // The chrome may have had a slide ready before this document finished
    // loading, so the stage announces itself instead of waiting to be found.
    window.parent.postMessage({ type: GUIDE_STAGE_READY }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, [fake, setTheme]);

  // Replay the slide's view / session events / QA opens AFTER `App` remounted
  // and re-subscribed — one tick later, same as a real event arriving.
  useEffect(() => {
    if (generation < 0) {
      return;
    }
    const id = window.setTimeout(() => fake.flushSideEffects(), 0);
    return () => window.clearTimeout(id);
  }, [fake, generation]);

  if (generation < 0) {
    return null;
  }
  return <App key={generation} />;
}
