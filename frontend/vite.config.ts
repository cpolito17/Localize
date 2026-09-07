import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  // Production lives beside the portfolio, not at the domain root. Keep dev
  // at / so Vite's proxy and local URLs stay convenient.
  base: command === "build" ? "/localize/" : "/",
  plugins: [react()],
  build: {
    // Match the public URL so Workers Static Assets can resolve
    // /localize/assets/* directly from the emitted directory tree.
    outDir: "dist/localize",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8000",
    },
  },
}));
