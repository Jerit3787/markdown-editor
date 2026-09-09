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

describe("client turnstile — enabled (site key stubbed)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubEnv("VITE_TURNSTILE_SITE_KEY", "0x_test_site_key");
    document.body.innerHTML = '<div id="turnstile-widget"></div>';
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    delete (window as unknown as { turnstile?: unknown }).turnstile;
  });

  it("coalesces concurrent getJoinTicket calls — one widget render, one POST", async () => {
    let renders = 0;
    (window as unknown as { turnstile: unknown }).turnstile = {
      render: (_el: unknown, opts: { callback: (t: string) => void }) => {
        renders++;
        queueMicrotask(() => opts.callback("widget-token"));
        return "wid-1";
      },
      remove: () => {},
    };
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ticket: "TICKET-A" }) }));
    vi.stubGlobal("fetch", fetchMock);

    const m = await freshModule();
    const [a, b, c] = await Promise.all([m.getJoinTicket("wsX"), m.getJoinTicket("wsX"), m.getJoinTicket("wsX")]);

    expect([a, b, c]).toEqual(["TICKET-A", "TICKET-A", "TICKET-A"]);
    expect(renders).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits for the widget container to render before calling turnstile.render()", async () => {
    // The modal / #turnstile-widget div lands a few frames after
    // turnstilePromptOpen flips — solveTurnstile must poll for it rather
    // than assume it's already there.
    document.body.innerHTML = ""; // container absent at solve time
    let renders = 0;
    (window as unknown as { turnstile: unknown }).turnstile = {
      render: (_el: unknown, opts: { callback: (t: string) => void }) => {
        renders++;
        queueMicrotask(() => opts.callback("late-token"));
        return "wid-late";
      },
      remove: () => {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ ticket: "LATE-TICKET" }) })),
    );
    const m = await freshModule();
    const p = m.getJoinTicket("wsLate");
    // Container appears ~50ms later, the way an async Svelte render would.
    setTimeout(() => {
      const d = document.createElement("div");
      d.id = "turnstile-widget";
      document.body.appendChild(d);
    }, 50);

    expect(await p).toBe("LATE-TICKET");
    expect(renders).toBe(1);
  });

  it("gives up (does not hang) when the widget container never appears", async () => {
    document.body.innerHTML = "";
    (window as unknown as { turnstile: unknown }).turnstile = { render: () => "x", remove: () => {} };
    const m = await freshModule();
    await expect(m.getJoinTicket("wsGone")).rejects.toThrow();
  }, 3000);

  it("a second call after the first settles is a fresh solve (in-flight entry cleared)", async () => {
    let renders = 0;
    (window as unknown as { turnstile: unknown }).turnstile = {
      render: (_el: unknown, opts: { callback: (t: string) => void }) => {
        renders++;
        queueMicrotask(() => opts.callback("tok"));
        return "wid";
      },
      remove: () => {},
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })), // no ticket in the response → not cached
    );
    const m = await freshModule();
    await m.getJoinTicket("wsY");
    await m.getJoinTicket("wsY");
    expect(renders).toBe(2);
  });
});
