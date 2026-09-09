// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { analyticsAvailable, initAnalytics, track, setSignedIn } from "../../../client/src/analytics";

describe("analytics (unconfigured — the test/self-host default)", () => {
  beforeEach(() => {
    delete (window as unknown as { dataLayer?: unknown[] }).dataLayer;
    document.head.querySelectorAll("script[src*='googletagmanager']").forEach((s) => s.remove());
  });

  it("reports itself unavailable when no measurement id is set", () => {
    expect(analyticsAvailable).toBe(false);
  });

  it("initAnalytics / track / setSignedIn are all no-ops — no dataLayer, no script", () => {
    initAnalytics();
    track("exported_doc");
    setSignedIn(true);
    expect((window as unknown as { dataLayer?: unknown[] }).dataLayer).toBeUndefined();
    expect(document.head.querySelector("script[src*='googletagmanager']")).toBeNull();
  });
});

function dl(): unknown[] {
  return (window as unknown as { dataLayer?: unknown[] }).dataLayer ?? [];
}
// window.gtag pushes the raw `arguments` object (array-*like*, not a real
// Array), so normalise each entry to an array before matching the command.
function calls(cmd: string): unknown[][] {
  return dl()
    .map((a) => (a && typeof a === "object" && "length" in (a as object) ? Array.from(a as ArrayLike<unknown>) : [a]))
    .filter((a) => a[0] === cmd);
}

describe("analytics (configured — cookieless by default)", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_GA_MEASUREMENT_ID", "G-TESTID000");
    localStorage.clear();
    delete (window as unknown as { dataLayer?: unknown[] }).dataLayer;
    document.head.querySelectorAll("script[src*='googletagmanager']").forEach((s) => s.remove());
    Object.defineProperty(navigator, "doNotTrack", { value: "0", configurable: true });
    delete (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function fresh() {
    vi.resetModules();
    return import("../../../client/src/analytics");
  }

  it("loads gtag.js and sets Consent Mode denied-by-default when consent is unset", async () => {
    const m = await fresh();
    expect(m.analyticsAvailable).toBe(true);
    m.initAnalytics();
    expect(document.head.querySelector("script[src*='googletagmanager.com/gtag/js']")).not.toBeNull();
    const def = calls("consent").filter((a) => a[1] === "default");
    expect(def).toHaveLength(1);
    expect((def[0]![2] as { analytics_storage?: string }).analytics_storage).toBe("denied");
    // config still fires → the automatic page_view
    expect(calls("config").some((a) => a[1] === "G-TESTID000")).toBe(true);
  });

  it("track / setSignedIn fire even while consent is unset (cookieless events)", async () => {
    const m = await fresh();
    m.initAnalytics();
    m.track("exported_doc");
    m.setSignedIn(true);
    expect(calls("event").some((a) => a[1] === "exported_doc")).toBe(true);
    expect(calls("set").some((a) => a[1] === "user_properties")).toBe(true);
  });

  it("accepting sends a consent update to granted", async () => {
    const m = await fresh();
    const { setConsent } = await import("../../../client/src/stores/analyticsConsent");
    m.initAnalytics();
    setConsent("granted");
    const upd = calls("consent").filter((a) => a[1] === "update");
    expect(upd.at(-1)).toBeTruthy();
    expect((upd.at(-1)![2] as { analytics_storage?: string }).analytics_storage).toBe("granted");
  });

  it("a GPC / DNT browser signal → gtag.js never loads, nothing is sent", async () => {
    Object.defineProperty(navigator, "doNotTrack", { value: "1", configurable: true });
    const m = await fresh();
    m.initAnalytics();
    m.track("exported_doc");
    expect(document.head.querySelector("script[src*='googletagmanager']")).toBeNull();
    expect((window as unknown as { dataLayer?: unknown[] }).dataLayer).toBeUndefined();
  });
});
