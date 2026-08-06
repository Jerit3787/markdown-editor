import { defineConfig } from "vite";

// Plain static-site build (no framework yet — see docs/improvement.md #1 /
// the approved TS+Svelte migration plan, phase 2). Dev requests to /api/*
// proxy to `wrangler dev` running separately on :8787.
export default defineConfig({
  // Explicit, not left to default-to-cwd: this config is invoked via
  // `--config client/vite.config.ts` from the repo root (see package.json
  // scripts), so Vite's normal "root = the config file's own directory"
  // default doesn't apply — it'd otherwise look for index.html in the repo
  // root instead of client/.
  root: import.meta.dirname,
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
