import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { localTools } from "./vite.preview.ts";

export default defineConfig({
  root: import.meta.dir,
  plugins: [react(), tailwindcss(), localTools()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    outDir: "../../dist/build/ui",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: false,
    cssCodeSplit: false,
    // The MCP host loads one self-contained HTML resource.
    chunkSizeWarningLimit: 1000,
    rolldownOptions: { output: { codeSplitting: false } },
  },
  server: { host: "127.0.0.1" },
});
