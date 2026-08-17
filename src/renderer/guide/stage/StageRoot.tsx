import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../App";
import { ThemeProvider, useTheme } from "../../theme/ThemeProvider";
import type { FakeAgentParty } from "./fakeAgentParty";
import {
  GUIDE_STAGE_APPLY,
  GUIDE_STAGE_FAILED,
  GUIDE_STAGE_READY,
  GUIDE_STAGE_STAGED,
  type GuideStageMessage,
} from "../../../shared/guideStage";
import { runStageSteps } from "./steps";
import "../../design-system.css";
import "../../styles.css";

export function mountStage(fake: FakeAgentParty): void {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("가이드 무대의 #root 가 없습니다.");
  }
  refuseFocus();
  // No StrictMode here. Its double-mount would replay the slide's session events
  // twice, and the stage is a picture the user reads — it has to be exactly the
  // state the chrome asked for.
  createRoot(root).render(
    <ThemeProvider>
      <Stage fake={fake} />
    </ThemeProvider>,
  );
}

/**
 * The stage is a picture, so nothing in it may hold the caret.
 *
 * Real modals autofocus their first field (the party name, the wizard's name
 * box) and the composer takes focus on mount. Focus inside this iframe means
 * the arrow keys type into a text box in the demo instead of turning the slide
 * — the deck's key handler lives in the chrome document and never sees them.
 * Every focus attempt is therefore refused as it happens, whenever it happens.
 */
function refuseFocus(): void {
  document.addEventListener("focusin", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement) {
      target.blur();
    }
  }, true);
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
  // and re-subscribed — one tick later, same as a real event arriving. Then open
  // whatever real UI the slide is ABOUT (modal, wizard, menu); a step that finds
  // nothing is reported back so the chrome can say so on screen.
  useEffect(() => {
    if (generation < 0) {
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      fake.flushSideEffects();
      const steps = fake.getSnapshot().steps || [];
      void runStageSteps(steps).then((failures) => {
        if (cancelled) {
          return;
        }
        if (failures.length) {
          window.parent.postMessage({ type: GUIDE_STAGE_FAILED, generation, failures }, "*");
        }
        // Whatever the steps opened may have taken focus on its way in; the
        // chrome takes it back so the arrow keys still turn the page.
        window.parent.postMessage({ type: GUIDE_STAGE_STAGED, generation }, "*");
      });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [fake, generation]);

  if (generation < 0) {
    return null;
  }
  return <App key={generation} />;
}
