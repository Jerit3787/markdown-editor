// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";

// Turnstile enabled + the visitor dismissing the challenge is the one path
// that used to leave workspaceRoom configured as "connected" with no
// socket. Mocking the module (rather than stubbing import.meta.env after
// import) is what lets this file force that branch — collab.ts reads
// turnstileEnabled at module load.
vi.mock("../../../client/src/turnstile", () => ({
  turnstileEnabled: true,
  getJoinTicket: vi.fn(async () => {
    throw new Error("challenge dismissed");
  }),
  clearJoinTicket: vi.fn(),
}));

import { handleDocChanged, workspaceRoom } from "../../../client/src/collab";
import { docsStore, activeIdStore } from "../../../client/src/stores/docs";
import { workspacesStore } from "../../../client/src/stores/workspaces";
import { workspaceAccessDenied } from "../../../client/src/stores/share";

describe("Turnstile dismissal", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="shareBtn"></div>';
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("/access")) {
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }) };
        }
        if (String(url).includes("/docs")) return { ok: true, json: async () => [] };
        return { ok: true, json: async () => ({}) };
      }),
    );
    window.MDE = {
      enterCollabMode: vi.fn(),
      exitCollabMode: vi.fn(),
      setReadOnly: vi.fn(),
      getEditor: vi.fn(() => ({ state: { doc: { toString: () => "" } }, dispatch: vi.fn() })),
      githubUsername: null, // anonymous — the only sessions that see Turnstile
      githubSessionReady: Promise.resolve(),
      setDocImage: vi.fn(),
      requireGithubSignIn: vi.fn(),
      updatePreview: vi.fn(),
    } as unknown as typeof window.MDE;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tears the room down instead of leaving a phantom connected workspace", async () => {
    const ws = { id: "w-turnstile", name: "W", createdAt: 0, updatedAt: 0, shared: true, remoteId: "remote-turnstile" };
    workspacesStore.set([ws]);
    const doc = { id: "d-turnstile", name: "D", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    docsStore.set([doc]);
    activeIdStore.set(doc.id);

    handleDocChanged(doc);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(workspaceRoom.workspaceId).toBeNull();
    expect(get(workspaceAccessDenied)).toBe("no-session");
  });
});
