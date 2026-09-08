// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
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
