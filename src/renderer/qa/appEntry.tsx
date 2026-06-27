// Headless QA entry: mounts the real App tree so a jsdom smoke test can verify
// the renderer mounts and paints without a full Electron shell. Not shipped in
// the production build (only index.html is an esbuild/vite entry).
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../App";
import { ThemeProvider } from "../theme/ThemeProvider";

export function mount(el: HTMLElement): void {
  createRoot(el).render(createElement(ThemeProvider, null, createElement(App)));
}
