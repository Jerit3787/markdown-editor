// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";

// vi.resetModules() gives each test a fresh module graph so drive-files.ts
// re-runs its top-level side effects — which means every store singleton
// it touches is fresh too, so they must be re-imported from the same fresh
// graph inside each test rather than bound once at file scope.
async function load() {
  const mod = await import("../../../client/src/drive-files");
  const { driveConnected, driveImportBusyLabel, driveExportBusyLabel } = await import("../../../client/src/stores/driveSync");
  const { driveExportRequest } = await import("../../../client/src/stores/driveExport");
  const { docsStore, activeIdStore } = await import("../../../client/src/stores/docs");
  const { workspacesStore } = await import("../../../client/src/stores/workspaces");
  return { mod, driveConnected, driveImportBusyLabel, driveExportBusyLabel, driveExportRequest, docsStore, activeIdStore, workspacesStore };
}

beforeEach(() => {
  vi.resetModules();
  // createDoc persists into localStorage, and persistDocs merges external
  // docs back in — clear it so one test's imported docs can't inflate the
  // next test's store.
  localStorage.clear();
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
        if (u.includes("/picker-token")) return new Response(JSON.stringify({ token: "t", apiKey: "k", appId: "999" }), { status: 200 });
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

    (mod as any).__setPickerForTest((_t: string, _k: string, _appId: string, onPicked: (f: { id: string; name: string }[]) => void) =>
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
    // A no-op seam: if a later test's auth-success message reaches this
    // module instance's listener, it must not throw out of the async
    // resume path (this test itself returns before the picker is used).
    (mod as any).__setPickerForTest(() => {});

    await (window as any).MDE.importMarkdownFromDrive();
    expect(connectSpy).toHaveBeenCalled();
    expect(get(docsStore)).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("resumes the pending import when the connect popup reports success", async () => {
    let pickerTokenCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/picker-token")) {
          pickerTokenCalls++;
          if (pickerTokenCalls === 1) return new Response("Reconnect", { status: 401 });
          return new Response(JSON.stringify({ token: "t", apiKey: "k", appId: "999" }), { status: 200 });
        }
        if (u.includes("/api/drive/import")) {
          return new Response(JSON.stringify({ results: [{ fileId: "a", name: "Todo.md", contentBase64: btoa("# Todo"), ok: true }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ connected: false }), { status: 200 });
      }),
    );
    const { mod, docsStore, workspacesStore } = await load();
    workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
    docsStore.set([]);
    const connectSpy = vi.fn();
    (window as any).MDE.connectGoogleDrive = connectSpy;
    let pickerOpened = false;
    (mod as any).__setPickerForTest((_t: string, _k: string, _a: string, onPicked: (f: { id: string; name: string }[]) => void) => {
      pickerOpened = true;
      onPicked([{ id: "a", name: "Todo.md" }]);
    });

    await (window as any).MDE.importMarkdownFromDrive();
    expect(connectSpy).toHaveBeenCalled();
    expect(pickerOpened).toBe(false);

    // The OAuth popup reports success after the user finishes consent.
    window.dispatchEvent(new MessageEvent("message", { origin: location.origin, data: { type: "mde-google-auth", ok: true } }));

    await vi.waitFor(() => expect(pickerOpened).toBe(true));
    await vi.waitFor(() => expect(get(docsStore)).toHaveLength(1));
    vi.unstubAllGlobals();
  });
});

describe("saveToDrive", () => {
  const utf8b64 = (text: string) => btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""));

  it("creates the file on first save, stores the Drive id/name, and toasts", async () => {
    const exportBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/api/drive/export")) {
          exportBodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ fileId: "file-1", name: "Notes.md", webViewLink: "https://drive.google.com/file/d/file-1/view" }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ connected: true }), { status: 200 });
      }),
    );
    const { driveConnected, driveExportRequest, docsStore, activeIdStore, workspacesStore } = await load();
    driveConnected.set(true);
    workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
    docsStore.set([{ id: "d1", name: "Notes", content: "", updatedAt: 1, createdAt: 1, workspaceId: "w1" }]);
    activeIdStore.set("d1");
    (window as any).MDE.getEditor = () => ({ state: { doc: { toString: () => "# Notes — café" } } });

    const pending = (window as any).MDE.saveToDrive();
    await vi.waitFor(() => expect(get(driveExportRequest)).not.toBeNull());
    get(driveExportRequest)!.resolve({ name: "Notes.md" });
    await pending;

    expect(exportBodies).toHaveLength(1);
    expect(exportBodies[0]).toMatchObject({ name: "Notes.md", contentBase64: utf8b64("# Notes — café") });
    expect(get(docsStore).find((d) => d.id === "d1")?.driveExportId).toBe("file-1");
    expect(get(docsStore).find((d) => d.id === "d1")?.driveExportName).toBe("Notes.md");
    vi.unstubAllGlobals();
  });

  it("updates the existing Drive file on later saves without opening the dialog", async () => {
    const exportBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/api/drive/export")) {
          exportBodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ fileId: "file-1", name: "Notes.md", webViewLink: "" }), { status: 200 });
        }
        return new Response(JSON.stringify({ connected: true }), { status: 200 });
      }),
    );
    const { driveConnected, driveExportRequest, docsStore, activeIdStore, workspacesStore } = await load();
    driveConnected.set(true);
    workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
    docsStore.set([
      { id: "d1", name: "Notes", content: "", updatedAt: 1, createdAt: 1, workspaceId: "w1", driveExportId: "file-1", driveExportName: "Notes.md" },
    ]);
    activeIdStore.set("d1");
    (window as any).MDE.getEditor = () => ({ state: { doc: { toString: () => "changed" } } });

    await (window as any).MDE.saveToDrive();

    expect(get(driveExportRequest)).toBeNull();
    expect(exportBodies).toHaveLength(1);
    expect(exportBodies[0]).toMatchObject({ fileId: "file-1", name: "Notes.md" });
    vi.unstubAllGlobals();
  });

  it("resumes the save after connecting when Drive wasn't connected", async () => {
    const exportBodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/api/drive/export")) {
          exportBodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ fileId: "file-1", name: "Notes.md" }), { status: 200 });
        }
        return new Response(JSON.stringify({ connected: false }), { status: 200 });
      }),
    );
    const { driveConnected, driveExportRequest, docsStore, activeIdStore, workspacesStore } = await load();
    driveConnected.set(false);
    workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
    docsStore.set([{ id: "d1", name: "Notes", content: "", updatedAt: 1, createdAt: 1, workspaceId: "w1" }]);
    activeIdStore.set("d1");
    (window as any).MDE.getEditor = () => ({ state: { doc: { toString: () => "body" } } });
    const connectSpy = vi.fn();
    (window as any).MDE.connectGoogleDrive = connectSpy;

    await (window as any).MDE.saveToDrive();
    expect(connectSpy).toHaveBeenCalled();

    // The OAuth popup reports success; the pending save resumes and asks
    // for the first-save filename.
    window.dispatchEvent(new MessageEvent("message", { origin: location.origin, data: { type: "mde-google-auth", ok: true } }));
    await vi.waitFor(() => expect(get(driveExportRequest)).not.toBeNull());
    get(driveExportRequest)!.resolve({ name: "Notes.md" });

    await vi.waitFor(() => expect(exportBodies).toHaveLength(1));
    expect(exportBodies[0]).toMatchObject({ name: "Notes.md" });
    vi.unstubAllGlobals();
  });

  it("clears a stale Drive id and retries as a create when the file was deleted in Drive", async () => {
    const exportBodies: Record<string, unknown>[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).includes("/api/drive/export")) {
          exportBodies.push(JSON.parse(String(init?.body)));
          calls++;
          if (calls === 1) return new Response(JSON.stringify({ error: "not-found" }), { status: 404 });
          return new Response(JSON.stringify({ fileId: "file-2", name: "Notes.md", webViewLink: "" }), { status: 200 });
        }
        return new Response(JSON.stringify({ connected: true }), { status: 200 });
      }),
    );
    const { driveConnected, docsStore, activeIdStore, workspacesStore } = await load();
    driveConnected.set(true);
    workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
    docsStore.set([
      { id: "d1", name: "Notes", content: "", updatedAt: 1, createdAt: 1, workspaceId: "w1", driveExportId: "gone", driveExportName: "Notes.md" },
    ]);
    activeIdStore.set("d1");
    (window as any).MDE.getEditor = () => ({ state: { doc: { toString: () => "body" } } });

    await (window as any).MDE.saveToDrive();

    expect(exportBodies).toHaveLength(2);
    expect(exportBodies[0]).toMatchObject({ fileId: "gone" });
    expect(exportBodies[1]!.fileId).toBeUndefined();
    expect(get(docsStore).find((d) => d.id === "d1")?.driveExportId).toBe("file-2");
    vi.unstubAllGlobals();
  });
});
