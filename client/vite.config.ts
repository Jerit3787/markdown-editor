import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFileSync } from "node:fs";

// Single source of truth for the version shown in the About panel — reads
// package.json directly rather than duplicating the number by hand, so it
// can't drift from what actually gets published in a release.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));

interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  url?: string;
}

// Same single-source-of-truth idea as __APP_VERSION__ above, extended to
// each direct dependency's own package.json — read from node_modules at
// build/dev-start time, so the About modal's license list can never
// drift from what's actually installed (this app has added/removed
// several dependencies over its lifetime; a hand-written list would
// already be stale).
function collectLicenses(): LicenseEntry[] {
  return Object.keys(pkg.dependencies ?? {}).map((name) => {
    const depPkg = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf-8"));
    const repoUrl = typeof depPkg.repository === "string" ? depPkg.repository : depPkg.repository?.url;
    const url = depPkg.homepage ?? repoUrl?.replace(/^git\+/, "").replace(/\.git$/, "");
    return { name, version: depPkg.version, license: depPkg.license ?? "Unknown", url };
  });
}

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
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __OSS_LICENSES__: JSON.stringify(collectLicenses()),
  },
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
