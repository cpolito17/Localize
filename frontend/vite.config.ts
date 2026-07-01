import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  // Served under charliepolito.com/localize/. This makes all asset URLs and
  // import.meta.env.BASE_URL resolve under /localize/.
  base: "/localize/",
  plugins: [react()],
  build: {
    // Emit into dist/localize so built paths mirror the /localize/ prefix; the
    // Worker's [assets] directory points at dist. See wrangler.toml.
    outDir: "dist/localize",
    emptyOutDir: true,
  },
  server: {
    // Dev only: proxy API calls to a locally running `wrangler dev` (:8787).
    proxy: {
      "/localize/api": "http://localhost:8787",
    },
  },
});
