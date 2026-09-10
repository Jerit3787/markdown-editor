// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

// vi.resetModules() gives each test a fresh module graph so drive-files.ts
// re-runs its top-level side effects — which means the `driveConnected`
// store instance is fresh too, so it must be re-imported from the same
// fresh graph inside each test rather than bound once at file scope.
async function load() {
  const mod = await import("../../../client/src/drive-files");
  const { driveConnected } = await import("../../../client/src/stores/driveSync");
  return { mod, driveConnected };
}

beforeEach(() => {
  vi.resetModules();
  (window as any).MDE = {};
});

describe("drive-files connection lifecycle", () => {
  it("hydrates driveConnected from /api/auth/google/status on import", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ connected: true }), { status: 200 })),
    );
    const { driveConnected } = await load();
    await vi.waitFor(() => expect(get(driveConnected)).toBe(true));
    vi.unstubAllGlobals();
  });

  it("disconnectGoogleDrive posts to the endpoint and clears driveConnected", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { driveConnected } = await load();
    driveConnected.set(true);
    await (window as any).MDE.disconnectGoogleDrive();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/google/disconnect", expect.objectContaining({ method: "POST" }));
    expect(get(driveConnected)).toBe(false);
    vi.unstubAllGlobals();
  });

  it("the mde-google-auth message flips driveConnected and chains onGoogleAuthComplete", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ connected: false }), { status: 200 })),
    );
    const chained = vi.fn();
    (window as any).MDE.onGoogleAuthComplete = chained;
    const { driveConnected } = await load();
    window.dispatchEvent(new MessageEvent("message", { origin: location.origin, data: { type: "mde-google-auth", ok: true } }));
    expect(get(driveConnected)).toBe(true);
    expect(chained).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
