import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";

const KEY = "mde:analyticsConsent";

async function freshModule() {
  vi.resetModules();
  return import("../../../../client/src/stores/analyticsConsent");
}

describe("analyticsConsent", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, "doNotTrack", { value: null, configurable: true });
    delete (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl;
  });
  afterEach(() => vi.resetModules());

  it("is 'unset' with nothing stored and no privacy signal", async () => {
    const m = await freshModule();
    expect(m.initialConsent()).toBe("unset");
  });

  it("reads a stored 'granted' / 'denied'", async () => {
    localStorage.setItem(KEY, "granted");
    expect((await freshModule()).initialConsent()).toBe("granted");
    localStorage.setItem(KEY, "denied");
    vi.resetModules();
    expect((await freshModule()).initialConsent()).toBe("denied");
  });

  it("treats a garbage stored value as 'unset'", async () => {
    localStorage.setItem(KEY, "maybe");
    expect((await freshModule()).initialConsent()).toBe("unset");
  });

  it("Do-Not-Track forces 'denied' regardless of storage", async () => {
    localStorage.setItem(KEY, "granted");
    Object.defineProperty(navigator, "doNotTrack", { value: "1", configurable: true });
    expect((await freshModule()).initialConsent()).toBe("denied");
  });

  it("Global Privacy Control forces 'denied'", async () => {
    (navigator as unknown as { globalPrivacyControl?: boolean }).globalPrivacyControl = true;
    expect((await freshModule()).initialConsent()).toBe("denied");
  });

  it("setConsent updates the store and persists", async () => {
    const m = await freshModule();
    m.setConsent("granted");
    expect(get(m.analyticsConsent)).toBe("granted");
    expect(localStorage.getItem(KEY)).toBe("granted");
  });

  it("setConsent survives a localStorage failure", async () => {
    const m = await freshModule();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => m.setConsent("denied")).not.toThrow();
    expect(get(m.analyticsConsent)).toBe("denied");
    spy.mockRestore();
  });
});
