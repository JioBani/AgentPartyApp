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
        guide: path.join(here, "src/renderer/guide/index.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
