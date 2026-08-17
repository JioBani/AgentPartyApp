import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: "src/renderer",
  base: "./",
  build: {
    outDir: "../../dist-renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.join(here, "src/renderer/index.html"),
        // The guide's STAGE only. The guide screen itself is part of the main
        // bundle now; this second document exists so the demo can own its
        // `window.agentParty` without touching the real one.
        guideStage: path.join(here, "src/renderer/guide/stage/index.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
