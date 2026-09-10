// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

// vi.resetModules() gives each test a fresh module graph so drive-files.ts
// re-runs its top-level side effects — which means every store singleton
// it touches is fresh too, so they must be re-imported from the same fresh
// graph inside each test rather than bound once at file scope.
async function load() {
  const mod = await import("../../../client/src/drive-files");
  const { driveConnected, driveImportBusyLabel } = await import("../../../client/src/stores/driveSync");
  const { docsStore, activeIdStore } = await import("../../../client/src/stores/docs");
  const { workspacesStore } = await import("../../../client/src/stores/workspaces");
  return { mod, driveConnected, driveImportBusyLabel, docsStore, activeIdStore, workspacesStore };
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

describe("importMarkdownFromDrive", () => {
  it("creates docs in the current workspace from the picked files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/picker-token")) return new Response(JSON.stringify({ token: "t", apiKey: "k" }), { status: 200 });
        if (u.includes("/api/drive/import")) {
          return new Response(
            JSON.stringify({
              results: [
                { fileId: "a", name: "Todo.md", contentBase64: btoa("# Todo\n- x"), ok: true },
                { fileId: "b", name: "Ideas.md", contentBase64: btoa("# Ideas"), ok: true },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ connected: true }), { status: 200 });
      }),
    );
    const { mod, docsStore, activeIdStore, workspacesStore } = await load();
    workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
    docsStore.set([]);
    activeIdStore.set(null);

    (mod as any).__setPickerForTest((_t: string, _k: string, onPicked: (f: { id: string; name: string }[]) => void) =>
      onPicked([
        { id: "a", name: "Todo.md" },
        { id: "b", name: "Ideas.md" },
      ]),
    );

    await (window as any).MDE.importMarkdownFromDrive();
    await vi.waitFor(() => expect(get(docsStore)).toHaveLength(2));

    const docs = get(docsStore);
    expect(docs.map((d) => d.name).sort()).toEqual(["Ideas", "Todo"]);
    expect(docs.find((d) => d.name === "Todo")!.content).toBe("# Todo\n- x");
    expect(docs.every((d) => d.workspaceId === "w1")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("prompts a connect and imports nothing on a 401 from picker-token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/picker-token")) return new Response("Reconnect", { status: 401 });
        return new Response(JSON.stringify({ connected: false }), { status: 200 });
      }),
    );
    const { mod, docsStore, workspacesStore } = await load();
    workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
    docsStore.set([]);
    const connectSpy = vi.fn();
    (window as any).MDE.connectGoogleDrive = connectSpy;
    (mod as any).__setPickerForTest(() => {
      throw new Error("picker should not open");
    });

    await (window as any).MDE.importMarkdownFromDrive();
    expect(connectSpy).toHaveBeenCalled();
    expect(get(docsStore)).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
