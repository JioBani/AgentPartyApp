import { createRoot } from "react-dom/client";
import { Studio } from "./StudioShell";

/**
 * Its own document, like the preview: the studio must NOT boot the app
 * (no `window.agentParty`), so a design page can be opened with nothing running.
 */
createRoot(document.getElementById("studio")!).render(<Studio />);
