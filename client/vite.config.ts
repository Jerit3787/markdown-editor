import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Phase 3 of the approved TS+Svelte migration plan: individual UI regions
// (starting with the Settings modal) are converted to Svelte 5 components,
// mounted into their existing DOM slots, one at a time — the bulk of the
// app is still the plain vanilla-DOM code from phase 2 until each piece is
// converted. Dev requests to /api/* proxy to `wrangler dev` running
// separately on :8787.
export default defineConfig({
  // Explicit, not left to default-to-cwd: this config is invoked via
  // `--config client/vite.config.ts` from the repo root (see package.json
  // scripts), so Vite's normal "root = the config file's own directory"
  // default doesn't apply — it'd otherwise look for index.html in the repo
  // root instead of client/.
  root: import.meta.dirname,
  plugins: [svelte()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
    },
  },
});
