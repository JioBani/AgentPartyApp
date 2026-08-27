import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ThemeProvider } from "./theme/ThemeProvider";
import { applyFontScale, readMirroredFontScale } from "./app/fontScaleStore";
import "./design-system.css";
import "./styles.css";

// Transcript font scale goes on the page before React renders — see
// fontScaleStore.ts for why applying it after first paint blurs text.
applyFontScale(readMirroredFontScale());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
