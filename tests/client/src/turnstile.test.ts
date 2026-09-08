// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

async function freshModule() {
  vi.resetModules();
  return import("../../../client/src/turnstile");
}

describe("client turnstile — disabled (the test / self-host default)", () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("turnstileEnabled is false with no VITE_TURNSTILE_SITE_KEY", async () => {
    expect((await freshModule()).turnstileEnabled).toBe(false);
  });

  it("getJoinTicket returns null and never touches fetch / the DOM", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const m = await freshModule();
    expect(await m.getJoinTicket("ws1")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.querySelector("script[src*='challenges.cloudflare.com']")).toBeNull();
  });

  it("clearJoinTicket removes the cache entry for that workspace only", async () => {
    const m = await freshModule();
    sessionStorage.setItem("mde:joinTicket:ws1", "whatever");
    sessionStorage.setItem("mde:joinTicket:ws2", "keep-me");
    m.clearJoinTicket("ws1");
    expect(sessionStorage.getItem("mde:joinTicket:ws1")).toBeNull();
    expect(sessionStorage.getItem("mde:joinTicket:ws2")).toBe("keep-me");
  });

  it("clearJoinTicket is safe when sessionStorage throws", async () => {
    const m = await freshModule();
    const spy = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    expect(() => m.clearJoinTicket("ws1")).not.toThrow();
    spy.mockRestore();
  });
});
