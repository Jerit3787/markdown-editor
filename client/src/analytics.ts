import { get } from "svelte/store";
import { analyticsConsent, type Consent } from "./stores/analyticsConsent";

const GA_ID = import.meta.env.VITE_GA_MEASUREMENT_ID as string | undefined;

// The banner and the Settings row key off this — nothing analytics-shaped
// renders when GA isn't configured for this build.
export const analyticsAvailable = !!GA_ID;

type GtagArgs = [string, ...unknown[]];
function gtag(...args: GtagArgs): void {
  (window as unknown as { dataLayer?: unknown[] }).dataLayer?.push(args);
}

let scriptLoaded = false;

function loadGaScript(): void {
  if (scriptLoaded || !GA_ID) return;
  scriptLoaded = true;
  (window as unknown as { dataLayer: unknown[] }).dataLayer ??= [];
  gtag("js", new Date());
  gtag("config", GA_ID, { anonymize_ip: true, app_version: __APP_VERSION__ });
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(s);
}

function applyConsent(c: Consent): void {
  if (!GA_ID) return;
  (window as unknown as { dataLayer: unknown[] }).dataLayer ??= [];
  gtag("consent", "update", {
    analytics_storage: c === "granted" ? "granted" : "denied",
  });
  if (c === "granted") loadGaScript();
}

// Call once at startup. Sets Consent Mode's denied-by-default baseline,
// then reacts to the stored/updated choice.
export function initAnalytics(): void {
  if (!GA_ID) return;
  (window as unknown as { dataLayer: unknown[] }).dataLayer ??= [];
  gtag("consent", "default", {
    analytics_storage: "denied",
    wait_for_update: 500,
  });
  analyticsConsent.subscribe(applyConsent); // fires immediately with current value
}

export type AnalyticsEvent = "shared_workspace" | "published_gist" | "linked_repo" | "exported_doc" | "opened_command_palette";

// No-ops unless GA is configured AND consent is granted. Never accepts
// or forwards a payload with identifying content.
export function track(event: AnalyticsEvent): void {
  if (!GA_ID || get(analyticsConsent) !== "granted") return;
  gtag("event", event);
}

export function setSignedIn(signedIn: boolean): void {
  if (!GA_ID || get(analyticsConsent) !== "granted") return;
  gtag("set", "user_properties", { signed_in: signedIn ? "yes" : "no" });
}
