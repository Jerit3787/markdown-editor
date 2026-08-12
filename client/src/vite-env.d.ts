/// <reference types="vite/client" />

// Injected by client/vite.config.ts's `define` from package.json's version.
declare const __APP_VERSION__: string;

// Injected by client/vite.config.ts's `define` — one entry per direct
// dependency in package.json, read from each package's own
// node_modules/<name>/package.json at build time.
declare const __OSS_LICENSES__: {
  name: string;
  version: string;
  license: string;
  url?: string;
}[];
