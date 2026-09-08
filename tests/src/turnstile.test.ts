import { describe, it, expect, vi, afterEach } from "vitest";
import { verifyTurnstileToken, mintJoinTicket, verifyJoinTicket, TICKET_TTL_MS } from "../../src/turnstile";

const SECRET = "test-session-secret-not-real";

describe("join ticket", () => {
  it("mint → verify round-trips for the same workspace within its TTL", async () => {
    const now = 1_000_000;
    const ticket = await mintJoinTicket("ws1", SECRET, now);
    expect(await verifyJoinTicket(ticket, "ws1", SECRET, now + TICKET_TTL_MS - 1)).toBe(true);
  });

  it("rejects a ticket minted for a different workspace", async () => {
    const ticket = await mintJoinTicket("ws1", SECRET, 0);
    expect(await verifyJoinTicket(ticket, "ws2", SECRET, 1)).toBe(false);
  });

  it("rejects an expired ticket", async () => {
    const ticket = await mintJoinTicket("ws1", SECRET, 0);
    expect(await verifyJoinTicket(ticket, "ws1", SECRET, TICKET_TTL_MS + 1)).toBe(false);
  });

  it("rejects a tampered signature or payload", async () => {
    const ticket = await mintJoinTicket("ws1", SECRET, 0);
    const [p, s] = ticket.split(".");
    const flip = (str: string) => str.slice(0, -1) + (str.at(-1) === "A" ? "B" : "A");
    expect(await verifyJoinTicket(`${p}.${flip(s!)}`, "ws1", SECRET, 1)).toBe(false);
    expect(await verifyJoinTicket(`${flip(p!)}.${s}`, "ws1", SECRET, 1)).toBe(false);
  });

  it("rejects garbage / null / malformed tickets", async () => {
    for (const bad of [null, "", "no-dot", "a.b.c", "!!!.???"]) {
      expect(await verifyJoinTicket(bad, "ws1", SECRET, 1)).toBe(false);
    }
  });

  it("rejects a ticket signed with a different secret", async () => {
    const ticket = await mintJoinTicket("ws1", SECRET, 0);
    expect(await verifyJoinTicket(ticket, "ws1", "other-secret", 1)).toBe(false);
  });
});

describe("verifyTurnstileToken", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(impl: () => Promise<Response>) {
    const fn = vi.fn(impl);
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("true only when Cloudflare returns success:true", async () => {
    stubFetch(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    expect(await verifyTurnstileToken("tok", "1.2.3.4", "sec")).toBe(true);
  });

  it("false on success:false", async () => {
    stubFetch(async () => new Response(JSON.stringify({ success: false }), { status: 200 }));
    expect(await verifyTurnstileToken("tok", null, "sec")).toBe(false);
  });

  it("false on a non-2xx response", async () => {
    stubFetch(async () => new Response("nope", { status: 500 }));
    expect(await verifyTurnstileToken("tok", null, "sec")).toBe(false);
  });

  it("false when fetch throws", async () => {
    stubFetch(async () => {
      throw new Error("network");
    });
    expect(await verifyTurnstileToken("tok", null, "sec")).toBe(false);
  });

  it("posts secret / response / remoteip in the form body", async () => {
    const fn = stubFetch(async () => new Response(JSON.stringify({ success: true }), { status: 200 }));
    await verifyTurnstileToken("the-token", "9.9.9.9", "the-secret");
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init.method).toBe("POST");
    const body = init.body as FormData;
    expect(body.get("secret")).toBe("the-secret");
    expect(body.get("response")).toBe("the-token");
    expect(body.get("remoteip")).toBe("9.9.9.9");
  });
});
