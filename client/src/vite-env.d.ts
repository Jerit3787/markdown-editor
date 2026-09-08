/// <reference types="vite/client" />

// Optional GA4 measurement id, set in the production Cloudflare build
// only. Unset everywhere else → the analytics module is fully inert.
interface ImportMetaEnv {
  readonly VITE_GA_MEASUREMENT_ID?: string;
  // Cloudflare Turnstile site key, set in the production Cloudflare build
  // only. Unset → the client Turnstile module is inert and anonymous
  // joins skip the challenge. Pairs with the Worker's TURNSTILE_SECRET_KEY.
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}

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
