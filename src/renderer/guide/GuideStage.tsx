import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import type { GuideSnapshot } from "../../shared/guide";
import {
  GUIDE_STAGE_APPLY,
  GUIDE_STAGE_READY,
  type GuideStageMessage,
} from "../../shared/guideStage";

/**
 * The stage: the REAL workbench, running against a fake bridge, in an iframe.
 *
 * It has to be a separate document. `window.agentParty` is one global per
 * document, and the guide now lives inside the main window where that global is
 * the real bridge — there is no way to scope a fake one to a React subtree. The
 * iframe gives the demo its own document, its own global, and (see its inline
 * script) its own localStorage, so nothing it does can touch the user's app.
 */
const STAGE_URL = "./guide/stage/index.html";

export function GuideStage({ snapshot, generation }: { snapshot: GuideSnapshot; generation: number }) {
  const { themeId } = useTheme();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as GuideStageMessage | undefined;
      if (!message || message.type !== GUIDE_STAGE_READY) {
        return;
      }
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }
      setReady(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    frameRef.current?.contentWindow?.postMessage(
      { type: GUIDE_STAGE_APPLY, snapshot, themeId, generation } satisfies GuideStageMessage,
      "*",
    );
  }, [ready, snapshot, themeId, generation]);

  return <iframe ref={frameRef} className="guide-stage-frame" src={STAGE_URL} title="가이드 무대" />;
}
