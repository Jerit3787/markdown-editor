import { get } from "svelte/store";
import { analyticsConsent, browserOptOut, type Consent } from "./stores/analyticsConsent";

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;

// The banner and the Settings row key off this — nothing analytics-shaped
// renders when GA isn't configured for this build.
export const analyticsAvailable = !!GA_ID;

interface GtagWindow {
  dataLayer?: unknown[];
  gtag?: (...args: unknown[]) => void;
}

// gtag.js ONLY processes commands pushed to dataLayer as the raw
// `arguments` object — a plain array (`dataLayer.push(["consent", ...])`)
// is silently ignored, so consent / config / event never take effect.
// This mirrors Google's canonical snippet exactly; `gtag()` below always
// goes through window.gtag so the pushed value is a real `arguments`.
function ensureGtag(): (...args: unknown[]) => void {
  const w = window as unknown as GtagWindow;
  w.dataLayer = w.dataLayer || [];
  if (!w.gtag) {
    // Must push the raw `arguments` object here — not a rest-param array.
    w.gtag = function gtag() {
      w.dataLayer!.push(arguments);
    };
  }
  return w.gtag;
}

function gtag(...args: unknown[]): void {
  const fn = (window as unknown as GtagWindow).gtag;
  if (fn) fn(...args);
}

let scriptLoaded = false;

function loadGaScript(): void {
  if (scriptLoaded || !GA_ID) return;
  scriptLoaded = true;
  const g = ensureGtag();
  g("js", new Date());
  const appVersion = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
  g("config", GA_ID, { anonymize_ip: true, app_version: appVersion });
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(s);
}

function applyConsent(c: Consent): void {
  if (!scriptLoaded) return;
  gtag("consent", "update", {
    analytics_storage: c === "granted" ? "granted" : "denied",
  });
}

// Call once at startup. Unless the browser sends a hard opt-out signal
// (DNT / GPC), gtag.js loads immediately in Consent Mode v2's
// denied-by-default state: anonymous, cookieless pings (no client id, no
// cross-session identity) that Google only uses for aggregate modelling.
// Accepting the banner upgrades that to full, cookie-backed measurement.
export function initAnalytics(): void {
  if (!GA_ID || browserOptOut()) return;
  const g = ensureGtag();
  const initial = get(analyticsConsent);
  g("consent", "default", {
    analytics_storage: initial === "granted" ? "granted" : "denied",
    wait_for_update: 500,
  });
  loadGaScript();
  analyticsConsent.subscribe(applyConsent); // fires immediately with current value
}

export type AnalyticsEvent = "shared_workspace" | "published_gist" | "linked_repo" | "exported_doc" | "opened_command_palette";

// Fires whenever analytics is active for this session (configured + not a
// hard browser opt-out). Consent Mode decides cookie vs cookieless — the
// event is sent either way. Never accepts or forwards identifying content.
export function track(event: AnalyticsEvent): void {
  if (!scriptLoaded) return;
  gtag("event", event);
}

export function setSignedIn(signedIn: boolean): void {
  if (!scriptLoaded) return;
  gtag("set", "user_properties", { signed_in: signedIn ? "yes" : "no" });
}
