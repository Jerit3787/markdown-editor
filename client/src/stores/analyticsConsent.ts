import { writable } from "svelte/store";

export type Consent = "granted" | "denied" | "unset";
const KEY = "mde:analyticsConsent";

// Do-Not-Track / Global Privacy Control → treat as an explicit decline,
// no banner.
function browserOptOut(): boolean {
  try {
    return navigator.doNotTrack === "1" || (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
  } catch {
    return false;
  }
}

export function initialConsent(): Consent {
  if (browserOptOut()) return "denied";
  try {
    const v = localStorage.getItem(KEY);
    return v === "granted" || v === "denied" ? v : "unset";
  } catch {
    return "unset";
  }
}

export const analyticsConsent = writable<Consent>(initialConsent());

export function setConsent(next: "granted" | "denied"): void {
  analyticsConsent.set(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode — the in-memory store still drives this session */
  }
}
