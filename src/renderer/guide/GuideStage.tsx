import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import type { GuideSnapshot } from "../../shared/guide";
import {
  GUIDE_STAGE_APPLY,
  GUIDE_STAGE_FAILED,
  GUIDE_STAGE_READY,
  GUIDE_STAGE_STAGED,
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

export function GuideStage({ snapshot, generation, onStaged }: {
  snapshot: GuideSnapshot;
  generation: number;
  /** Called once a slide is fully staged — the chrome takes focus back then. */
  onStaged?: () => void;
}) {
  const { themeId } = useTheme();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);
  // A slide whose modal/menu never opened. Shown ON the stage rather than logged:
  // the picture would otherwise look finished while missing its subject.
  const [failure, setFailure] = useState<{ generation: number; text: string } | undefined>();
  // Held in a ref so the message listener is installed once and still calls the
  // current callback — re-subscribing would miss a message posted in between.
  const onStagedRef = useRef(onStaged);
  onStagedRef.current = onStaged;

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const message = event.data as GuideStageMessage | undefined;
      if (!message || event.source !== frameRef.current?.contentWindow) {
        return;
      }
      if (message.type === GUIDE_STAGE_READY) {
        setReady(true);
      } else if (message.type === GUIDE_STAGE_FAILED) {
        setFailure({ generation: message.generation, text: message.failures.join(" · ") });
      } else if (message.type === GUIDE_STAGE_STAGED) {
        onStagedRef.current?.();
      }
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

  return (
    <>
      <iframe ref={frameRef} className="guide-stage-frame" src={STAGE_URL} title="가이드 무대" />
      {failure?.generation === generation && <div className="guide-stage-error">{failure.text}</div>}
    </>
  );
}
