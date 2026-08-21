// @vitest-environment jsdom
// collab.ts registers a document.addEventListener("DOMContentLoaded", ...)
// at module load time — a static import of it needs a real `document`
// global to exist during that side effect, which the default node
// environment doesn't provide (localStorage, also touched transitively
// via stores/docs.ts -> stores/workspaces.ts, is covered by the project's
// vitest.setup.ts regardless of environment). init() itself never actually
// runs during these tests: DOMContentLoaded has already fired on jsdom's
// document by the time this module's listener is attached, so it's just a
// no-op registration — none of the tests below trigger it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import { decideShareTarget, decideJoinTarget, handleDocChanged, workspaceRoom } from "../../../client/src/collab";
import { docsStore } from "../../../client/src/stores/docs";
import { workspacesStore } from "../../../client/src/stores/workspaces";
import type { Doc, Workspace } from "../../../client/src/types";

function fakeDoc(overrides: Partial<Doc>): Doc {
  return { id: "d1", name: "Doc", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", ...overrides };
}
function fakeWorkspace(overrides: Partial<Workspace>): Workspace {
  return { id: "w1", name: "Workspace", createdAt: 0, updatedAt: 0, ...overrides };
}

describe("decideShareTarget", () => {
  it("shares directly when the workspace is already shared, even with siblings", () => {
    const doc = fakeDoc({ id: "d1", workspaceId: "w1" });
    const docs = [doc, fakeDoc({ id: "d2", workspaceId: "w1" })];
    const workspaces = [fakeWorkspace({ id: "w1", shared: true })];
    expect(decideShareTarget(doc, docs, workspaces)).toEqual({ kind: "direct" });
  });

  it("shares directly when the workspace is already shared and has no siblings", () => {
    const doc = fakeDoc({ id: "d1", workspaceId: "w1" });
    const workspaces = [fakeWorkspace({ id: "w1", shared: true })];
    expect(decideShareTarget(doc, [doc], workspaces)).toEqual({ kind: "direct" });
  });

  it("shares directly when not shared and the doc has no siblings", () => {
    const doc = fakeDoc({ id: "d1", workspaceId: "w1" });
    const workspaces = [fakeWorkspace({ id: "w1" })];
    expect(decideShareTarget(doc, [doc], workspaces)).toEqual({ kind: "direct" });
  });

  it("returns a choice decision when not shared and the doc has siblings", () => {
    const doc = fakeDoc({ id: "d1", name: "My Notes", workspaceId: "w1" });
    const docs = [doc, fakeDoc({ id: "d2", workspaceId: "w1" }), fakeDoc({ id: "d3", workspaceId: "w1" })];
    const workspaces = [fakeWorkspace({ id: "w1", name: "My Workspace" })];
    expect(decideShareTarget(doc, docs, workspaces)).toEqual({
      kind: "choice",
      docName: "My Notes",
      workspaceName: "My Workspace",
      docCount: 3,
    });
  });

  it("falls back to placeholder names if the doc/workspace name is empty", () => {
    const doc = fakeDoc({ id: "d1", name: "", workspaceId: "w1" });
    const docs = [doc, fakeDoc({ id: "d2", workspaceId: "w1" })];
    const workspaces = [fakeWorkspace({ id: "w1", name: "" })];
    const result = decideShareTarget(doc, docs, workspaces);
    expect(result).toEqual({ kind: "choice", docName: "Untitled", workspaceName: "Untitled workspace", docCount: 2 });
  });
});

describe("decideJoinTarget", () => {
  it("auto-lands a single document as its own new workspace, even with existing workspaces", () => {
    const result = decideJoinTarget([{ name: "Release Notes" }], 3);
    expect(result).toEqual({ kind: "auto", workspaceName: "Release Notes" });
  });

  it("auto-lands a single document as its own new workspace when the receiver has none", () => {
    const result = decideJoinTarget([{ name: "Release Notes" }], 0);
    expect(result).toEqual({ kind: "auto", workspaceName: "Release Notes" });
  });

  it("falls back to a placeholder name when the single document has no name", () => {
    const result = decideJoinTarget([{ name: "" }], 1);
    expect(result).toEqual({ kind: "auto", workspaceName: "Untitled" });
  });

  it("auto-lands a multi-document workspace when the receiver has zero workspaces", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 0);
    expect(result).toEqual({ kind: "auto", workspaceName: "Shared workspace" });
  });

  it("returns a choice decision for a multi-document workspace when the receiver has existing workspaces", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 2);
    expect(result).toEqual({ kind: "choice" });
  });

  it("treats zero valid documents as a multi-document share (no single doc to auto-land)", () => {
    const result = decideJoinTarget([], 0);
    expect(result).toEqual({ kind: "auto", workspaceName: "Shared workspace" });
  });
});

// Regression test for a real bug reported live: repeatedly clicking between
// documents in a shared workspace made the presence avatar count creep up
// before eventually dropping back down. One of three contributing root
// causes (this one client-side): rejoinKnownWorkspace/joinWorkspace are
// async and fire-and-forget from handleDocChanged with no cancellation
// guard, so a doc switch that lands while the FIRST switch's network round
// trip (fetchWorkspaceAccess) is still in flight starts a second, fully
// independent join attempt — each with its own fresh Y.Doc/Awareness
// objects and its own WebSocket connection. Whichever attempt happens to
// finish last "wins", regardless of which document the user actually
// clicked last, and the loser's connection/bindings can be left dangling.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  url: string;
  binaryType = "";
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  send(_data: unknown) {}
  close() {
    this.closed = true;
    this.readyState = 3;
  }
}

// Resolves once released — lets the test hold both attempts' access-fetch
// calls open simultaneously, then release them together, reproducing the
// exact interleaving the real bug needs (both switches landing while the
// first is still mid-flight, before workspaceRoom.workspaceId is set).
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeSharedWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return { id: "local-ws", name: "Shared", createdAt: 0, updatedAt: 0, shared: true, remoteId: "remote-1", ...overrides };
}

describe("join-generation race (rapid doc switching in a shared workspace)", () => {
  const accessGate = deferred<void>();

  beforeEach(() => {
    // syncShareStores() (called at the end of rejoinKnownWorkspace) touches
    // #shareBtn unconditionally — a bare jsdom document has no such element.
    document.body.innerHTML = '<div id="shareBtn"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access")) {
          await accessGate.promise;
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }) };
        }
        if (url.includes("/docs")) {
          return { ok: true, json: async () => ["docA", "docB"] };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    window.MDE = {
      enterCollabMode: vi.fn(),
      exitCollabMode: vi.fn(),
      setReadOnly: vi.fn(),
      getEditor: vi.fn(() => ({ state: { doc: { toString: () => "" } } })),
      githubUsername: "alice",
      githubSessionReady: Promise.resolve(),
      setDocImage: vi.fn(),
      requireGithubSignIn: vi.fn(),
    } as unknown as typeof window.MDE;

    const ws = fakeSharedWorkspace();
    workspacesStore.set([ws]);
    docsStore.set([
      { id: "docA", name: "A", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id },
      { id: "docB", name: "B", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id },
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a second doc switch landing mid-flight supersedes the first instead of racing it", async () => {
    const docA = get(docsStore).find((d) => d.id === "docA")!;
    const docB = get(docsStore).find((d) => d.id === "docB")!;

    // Click docA, then click docB before docA's access fetch resolves —
    // both handleDocChanged calls run their synchronous portion
    // (teardownWorkspace + fire-and-forget rejoinKnownWorkspace) before
    // either's network round trip settles.
    handleDocChanged(docA);
    handleDocChanged(docB);

    // Release both attempts' held access fetches together.
    accessGate.resolve();
    // Flush the microtask queue enough times for both async chains
    // (githubSessionReady -> fetchWorkspaceAccess -> joinWorkspace ->
    // fetchWorkspaceDocIds -> bindActiveDoc) to fully settle.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // The superseded first attempt must never reach connectWorkspace() —
    // exactly one connection for the whole race, not one leaked per click.
    expect(MockWebSocket.instances.length).toBe(1);
    // The user's actual last click (docB) must be what's showing, not
    // whichever attempt happened to finish its network round trip last.
    expect(workspaceRoom.activeDocId).toBe("docB");
    expect(workspaceRoom.workspaceId).toBe("remote-1");
    expect(workspaceRoom.docs.size).toBe(2);
  });
});
