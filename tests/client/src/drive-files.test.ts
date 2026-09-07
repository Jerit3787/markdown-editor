// @vitest-environment jsdom
// drive-files.ts assigns window.MDE.* at module top level (like gist.ts) —
// a static import needs window.MDE to exist by then, which only app.ts
// provides in production. Dynamic-import once after stubbing window.MDE +
// fetch, the same pattern gist.test.ts uses. No vi.resetModules() — that
// would give the dynamically-imported module a *different* driveSync
// store instance than the one imported statically here.
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { driveConnected, driveConfigured } from "../../../client/src/stores/driveSync";
import { docsStore, activeIdStore } from "../../../client/src/stores/docs";
import { workspacesStore } from "../../../client/src/stores/workspaces";

let checkSession: typeof import("../../../client/src/drive-files").checkSession;
let __setPickerForTest: typeof import("../../../client/src/drive-files").__setPickerForTest;

beforeAll(async () => {
  (window as unknown as { MDE: Record<string, unknown> }).MDE = {};
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ connected: false }), { status: 200 })),
  );
  const mod = await import("../../../client/src/drive-files");
  checkSession = mod.checkSession;
  __setPickerForTest = mod.__setPickerForTest;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  driveConnected.set(false);
  driveConfigured.set(true);
  __setPickerForTest(null);
});

describe("drive-files connection lifecycle", () => {
  it("hydrates driveConnected from /api/auth/google/status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ connected: true }), { status: 200 })),
    );
    await checkSession();
    expect(get(driveConnected)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("marks the feature unconfigured when status returns 503", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    await checkSession();
    expect(get(driveConfigured)).toBe(false);
    expect(get(driveConnected)).toBe(false);
    vi.unstubAllGlobals();
  });

  it("disconnectGoogleDrive posts to the endpoint and clears driveConnected", async () => {
    driveConnected.set(true);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await (window as unknown as { MDE: { disconnectGoogleDrive: () => Promise<void> } }).MDE.disconnectGoogleDrive();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/google/disconnect", expect.objectContaining({ method: "POST" }));
    expect(get(driveConnected)).toBe(false);
    vi.unstubAllGlobals();
  });

  it("re-checks the session on a { type: mde-google-auth, ok } window message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ connected: true }), { status: 200 })),
    );
    window.dispatchEvent(new MessageEvent("message", { data: { type: "mde-google-auth", ok: true }, origin: window.location.origin }));
    await vi.waitFor(() => expect(get(driveConnected)).toBe(true));
    vi.unstubAllGlobals();
  });
});

describe("importMarkdownFromDrive", () => {
  it("creates docs in the current workspace from the picked files", async () => {
    workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
    docsStore.set([]);
    activeIdStore.set(null);
    driveConnected.set(true);

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
        return new Response("?", { status: 404 });
      }),
    );

    __setPickerForTest((_t: string, _k: string, onPicked: (f: { id: string; name: string }[]) => void) =>
      onPicked([
        { id: "a", name: "Todo.md" },
        { id: "b", name: "Ideas.md" },
      ]),
    );

    await (window as unknown as { MDE: { importMarkdownFromDrive: () => Promise<void> } }).MDE.importMarkdownFromDrive();

    const docs = get(docsStore);
    expect(docs.map((d) => d.name).sort()).toEqual(["Ideas", "Todo"]);
    expect(docs.find((d) => d.name === "Todo")!.content).toBe("# Todo\n- x");
    expect(docs.every((d) => d.workspaceId === "w1")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("connects first when picker-token 401s, and does not import", async () => {
    workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
    docsStore.set([]);
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/picker-token")) return new Response("no", { status: 401 });
        return new Response(JSON.stringify({ connected: false }), { status: 200 });
      }),
    );
    await (window as unknown as { MDE: { importMarkdownFromDrive: () => Promise<void> } }).MDE.importMarkdownFromDrive();
    expect(openSpy).toHaveBeenCalledWith("/api/auth/google/connect", expect.any(String), expect.any(String));
    expect(get(docsStore)).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
