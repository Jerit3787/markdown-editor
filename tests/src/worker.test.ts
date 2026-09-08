import { describe, it, expect, vi } from "vitest";
import worker from "../../src/worker";
import type { Env } from "../../src/env";

// SHELL-21 — worker.ts's own fetch entry point: which requests dispatch to
// a Durable Object, which to an auth/gist/repo handler, and which fall
// through to the static-asset (SPA) handler.

function fakeEnv() {
  const assetsFetch = vi.fn(async () => new Response("<!doctype html><title>app</title>", { status: 200, headers: { "Content-Type": "text/html" } }));
  const doFetch = vi.fn(async () => new Response("from DO", { status: 200 }));
  const stub = { fetch: doFetch };
  const ns = { idFromName: (name: string) => ({ name }), get: () => stub };
  const env = {
    ASSETS: { fetch: assetsFetch },
    WORKSPACE_ROOM: ns,
    COLLAB_ROOM: ns,
    SESSION_SECRET: "test-secret-at-least-32-bytes-long!!",
  } as unknown as Env;
  return { env, assetsFetch, doFetch };
}

describe("worker routing", () => {
  it("serves the built SPA for a non-API path", async () => {
    const { env, assetsFetch } = fakeEnv();
    const res = await worker.fetch(new Request("https://app.example.com/some/client/route"), env);
    expect(assetsFetch).toHaveBeenCalledTimes(1);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("falls through to the SPA handler for an unknown /api/* path (there is no hard 404 here)", async () => {
    const { env, assetsFetch, doFetch } = fakeEnv();
    await worker.fetch(new Request("https://app.example.com/api/does-not-exist"), env);
    expect(doFetch).not.toHaveBeenCalled();
    expect(assetsFetch).toHaveBeenCalledTimes(1);
  });

  it("dispatches /api/workspace/:id/access to the WorkspaceRoom DO", async () => {
    const { env, doFetch, assetsFetch } = fakeEnv();
    await worker.fetch(new Request("https://app.example.com/api/workspace/ws123/access"), env);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(assetsFetch).not.toHaveBeenCalled();
  });

  it("dispatches /api/collab/:id/comments/... to the CollabRoom DO", async () => {
    const { env, doFetch } = fakeEnv();
    await worker.fetch(new Request("https://app.example.com/api/collab/room1/comments/t1/reply", { method: "POST" }), env);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("a non-websocket request to the bare workspace path is 426, not a DO call", async () => {
    const { env, doFetch } = fakeEnv();
    const res = await worker.fetch(new Request("https://app.example.com/api/workspace/ws1"), env);
    expect(res.status).toBe(426);
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("routes /api/auth/github/me to its handler (returns connected:false when signed out)", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(new Request("https://app.example.com/api/auth/github/me"), env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { connected: boolean }).connected).toBe(false);
  });

  it("passes /privacy and /terms straight through to the asset layer (no worker rewrite)", async () => {
    // client/public/{privacy,terms}.html are served at the clean URLs by
    // Cloudflare's html_handling. A worker rewrite to `.html` would be
    // 307'd back and loop — so the worker must NOT touch these, just fall
    // through with the original request unchanged.
    for (const path of ["/privacy", "/terms"]) {
      const { env, assetsFetch, doFetch } = fakeEnv();
      await worker.fetch(new Request(`https://app.example.com${path}`), env);
      expect(doFetch).not.toHaveBeenCalled();
      expect(assetsFetch).toHaveBeenCalledTimes(1);
      expect(((assetsFetch.mock.calls[0] as unknown[])[0] as Request).url).toBe(`https://app.example.com${path}`);
    }
  });
});
