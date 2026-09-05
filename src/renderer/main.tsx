import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ThemeProvider } from "./theme/ThemeProvider";
import { applyFontScale, readMirroredFontScale } from "./app/fontScaleStore";
import "./design-system.css";
import "./styles.css";

// Put the persisted transcript scale on the page before React renders so the
// first frame does not jump from 100% to the user's chosen size.
applyFontScale(readMirroredFontScale());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>,
);
