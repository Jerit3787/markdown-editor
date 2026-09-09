import { turnstilePromptOpen, turnstilePromptError } from "./stores/turnstile";

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
export const turnstileEnabled = !!SITE_KEY;

const CACHE_TTL_MS = 14 * 60 * 1000;
const cacheKey = (remoteId: string) => `mde:joinTicket:${remoteId}`;

function readCachedTicket(remoteId: string): string | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(remoteId));
    if (!raw) return null;
    const { ticket, exp } = JSON.parse(raw) as { ticket?: unknown; exp?: unknown };
    return typeof ticket === "string" && typeof exp === "number" && exp > Date.now() + 30_000 ? ticket : null;
  } catch {
    return null;
  }
}

export function clearJoinTicket(remoteId: string): void {
  try {
    sessionStorage.removeItem(cacheKey(remoteId));
  } catch {
    /* private mode — nothing to clear */
  }
}

let scriptPromise: Promise<void> | null = null;
function loadTurnstileScript(): Promise<void> {
  if ((window as unknown as { turnstile?: unknown }).turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile script failed to load"));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

interface TurnstileApi {
  render: (
    el: string | HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      "error-callback": () => void;
      "expired-callback": () => void;
      appearance?: string;
    },
  ) => string;
  remove: (id: string) => void;
}

// TurnstilePrompt.svelte renders the <div id="turnstile-widget"> in
// reaction to turnstilePromptOpen — an async render. When Cloudflare's
// api.js is already cached, loadTurnstileScript() resolves in the same
// microtask and the container isn't in the DOM yet, so poll briefly for
// it rather than giving up (an anonymous share-link join would then land
// in read-only preview with a dead challenge modal — the bug this fixes).
async function acquireWidgetContainer(): Promise<HTMLElement | null> {
  for (let i = 0; i < 60; i++) {
    const el = document.getElementById("turnstile-widget");
    if (el) return el;
    await new Promise((r) => setTimeout(r, 16));
  }
  return null;
}

// Opens the prompt modal, renders the widget, resolves with the token.
// Rejects on widget error/expiry (leaving the prompt open in its error
// state) or if the user cancels (TurnstilePrompt clears turnstilePromptOpen).
async function solveTurnstile(): Promise<string> {
  if (!SITE_KEY) throw new Error("turnstile not configured");
  turnstilePromptError.set(false);
  turnstilePromptOpen.set(true);
  await loadTurnstileScript();
  const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
  const container = await acquireWidgetContainer();
  if (!api || !container) {
    turnstilePromptError.set(true);
    throw new Error("turnstile unavailable");
  }
  // Cloudflare rejects a second render() into a container that already
  // holds a widget ("Turnstile has already been rendered…") — clear any
  // leftover from a previous attempt (a cancelled/errored solve, or a
  // Retry) before rendering a fresh one.
  container.replaceChildren();
  return new Promise<string>((resolve, reject) => {
    let widgetId: string | null = null;
    const cleanup = () => {
      if (widgetId) {
        try {
          api.remove(widgetId);
        } catch {
          /* already gone */
        }
      }
    };
    widgetId = api.render(container, {
      sitekey: SITE_KEY,
      appearance: "interaction-only",
      callback: (token) => {
        cleanup();
        turnstilePromptOpen.set(false);
        resolve(token);
      },
      "error-callback": () => {
        cleanup();
        turnstilePromptError.set(true);
        reject(new Error("turnstile error"));
      },
      "expired-callback": () => {
        cleanup();
        turnstilePromptError.set(true);
        reject(new Error("turnstile expired"));
      },
    });
  });
}

// Concurrent callers for the same workspace share one solve — the widget
// is a single DOM element and Cloudflare rejects a second render() into
// it. Keyed by remoteId; cleared when the request settles.
const inFlight = new Map<string, Promise<string | null>>();

// For an anonymous connection to an "anyone with the link" workspace,
// return a valid join ticket — reusing a cached one, else solving a fresh
// Turnstile challenge and exchanging the widget token at the Worker.
// null when Turnstile is unconfigured or the server says to skip
// (signed-in) — the caller then connects without a ticket.
export async function getJoinTicket(remoteId: string): Promise<string | null> {
  if (!turnstileEnabled) return null;
  const cached = readCachedTicket(remoteId);
  if (cached) return cached;

  const existing = inFlight.get(remoteId);
  if (existing) return existing;
  const run = requestJoinTicket(remoteId).finally(() => inFlight.delete(remoteId));
  inFlight.set(remoteId, run);
  return run;
}

async function requestJoinTicket(remoteId: string): Promise<string | null> {
  const token = await solveTurnstile();
  const res = await fetch(`/api/workspace/${encodeURIComponent(remoteId)}/join-ticket`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    turnstilePromptError.set(true);
    turnstilePromptOpen.set(true);
    return null;
  }
  const data = (await res.json()) as { ticket?: string; skip?: boolean; enabled?: boolean };
  if (data.enabled === false || data.skip) return null;
  if (typeof data.ticket === "string") {
    try {
      sessionStorage.setItem(cacheKey(remoteId), JSON.stringify({ ticket: data.ticket, exp: Date.now() + CACHE_TTL_MS }));
    } catch {
      /* private mode — the returned ticket still works for this connection */
    }
    return data.ticket;
  }
  return null;
}
