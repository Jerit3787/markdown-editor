// Per-request Content-Security-Policy for HTML responses.
//
// Delivered by src/worker.ts as a real response header (not <meta>)
// carrying a fresh `nonce` per request. Cloudflare's edge-injected
// JavaScript Detections script has an inline body that rotates every
// request (ray id + timestamp) and cannot be hash-pinned; Cloudflare
// stamps its injected <script> tags with the nonce it finds in this
// header, so JSD runs without a violation.
//
// client/index.html and legal/*.html keep their own static <meta> CSP
// as the policy enforced under `vite dev` (no Worker there). In
// production the Worker strips that <meta> and sets the header below.

/** A fresh CSP nonce: 16 random bytes, standard base64 (24 chars). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

/**
 * The app-shell policy. Identical to the v1.60.2 <meta> policy except
 * `script-src` swaps the inline-script hash for the per-request nonce.
 */
export function appCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com https://www.googletagmanager.com https://apis.google.com`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com https://www.googleapis.com",
    "frame-src https://challenges.cloudflare.com https://docs.google.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * The /privacy, /terms, and /home policy. Those pages ship zero script of their
 * own; `script-src 'nonce-…'` exists ONLY so Cloudflare's injected JSD
 * inline script is stamped and runs cleanly.
 */
export function legalCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
}
