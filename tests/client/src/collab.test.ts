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
//
// applyWorkspaceMeta's document-removal path (see the "incoming workspace
// meta sync" describe block below) goes through stores/docs.ts's
// removeDocById(), which fire-and-forgets a deleteHistory() call that
// opens a real IndexedDB database — unmocked by default under jsdom.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {
  decideShareTarget,
  decideJoinTarget,
  handleDocChanged,
  workspaceRoom,
  teardownWorkspace,
  setAccessMode,
  isIdentityUnverified,
  DEFAULT_ACCESS,
  pushWorkspaceRename,
  pushWorkspaceDocDelete,
  addPerson,
} from "../../../client/src/collab";
import { docsStore, activeIdStore } from "../../../client/src/stores/docs";
import { workspacesStore, activeWorkspaceIdStore } from "../../../client/src/stores/workspaces";
import { viewMode, viewModeLocked } from "../../../client/src/stores/view";
import { workspaceAccessDenied, identityUnverified } from "../../../client/src/stores/share";
import { getSuggestionsMap } from "../../../client/src/suggestions";
import type { Doc, Workspace } from "../../../client/src/types";

function fakeDoc(overrides: Partial<Doc>): Doc {
  return { id: "d1", name: "Doc", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", ...overrides };
}
function fakeWorkspace(overrides: Partial<Workspace>): Workspace {
  return { id: "w1", name: "Workspace", createdAt: 0, updatedAt: 0, ...overrides };
}

describe("isIdentityUnverified", () => {
  it("is true when there's no session and general access is 'anyone', even with the owner visible", () => {
    const access = { ...DEFAULT_ACCESS, owner: "alice", generalAccess: "anyone" as const };
    expect(isIdentityUnverified(access, null)).toBe(true);
  });

  // The real shape a genuinely anonymous visitor's own fetched AccessRecord
  // has: the server redacts `owner` to null for anyone authorize() doesn't
  // already recognize (see access-visibility.ts's redactAccessForOutsider)
  // — this is the actual case the function exists to catch, not an edge
  // case, and must not be confused with "never configured" (DEFAULT_ACCESS
  // itself has generalAccess: "restricted", so "anyone" here already
  // implies a real owner exists server-side, redacted or not).
  it("is true even when owner has been redacted to null, as long as general access is 'anyone'", () => {
    const access = { ...DEFAULT_ACCESS, owner: null, generalAccess: "anyone" as const };
    expect(isIdentityUnverified(access, null)).toBe(true);
  });

  it("is false when a session exists, even one that doesn't match the owner", () => {
    const access = { ...DEFAULT_ACCESS, owner: "alice", generalAccess: "anyone" as const };
    expect(isIdentityUnverified(access, "bob")).toBe(false);
  });

  it("is false when general access is restricted", () => {
    const access = { ...DEFAULT_ACCESS, owner: "alice", generalAccess: "restricted" as const };
    expect(isIdentityUnverified(access, null)).toBe(false);
  });
});

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
  it("auto-previews a single document when the receiver already has workspaces of their own", () => {
    const result = decideJoinTarget([{ name: "Release Notes" }], 3);
    expect(result).toEqual({ kind: "auto-preview", workspaceName: "Release Notes" });
  });

  it("auto-lands a single document permanently when the receiver has none", () => {
    const result = decideJoinTarget([{ name: "Release Notes" }], 0);
    expect(result).toEqual({ kind: "auto-permanent", workspaceName: "Release Notes" });
  });

  it("falls back to a placeholder name when the single document has no name", () => {
    const result = decideJoinTarget([{ name: "" }], 1);
    expect(result).toEqual({ kind: "auto-preview", workspaceName: "Untitled" });
  });

  it("auto-lands a multi-document workspace permanently when the receiver has zero workspaces", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 0);
    expect(result).toEqual({ kind: "auto-permanent", workspaceName: "Shared workspace" });
  });

  it("returns a choice decision for a multi-document workspace when the receiver has existing workspaces", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 2);
    expect(result).toEqual({ kind: "choice" });
  });

  it("treats zero valid documents as a multi-document share (no single doc to auto-land)", () => {
    const result = decideJoinTarget([], 0);
    expect(result).toEqual({ kind: "auto-permanent", workspaceName: "Shared workspace" });
  });

  it("uses the real remote workspace name for a multi-document permanent landing when provided", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 0, "Team Docs");
    expect(result).toEqual({ kind: "auto-permanent", workspaceName: "Team Docs" });
  });

  it("falls back to the 'Shared workspace' placeholder when no remote workspace name is provided", () => {
    const result = decideJoinTarget([{ name: "A" }, { name: "B" }], 0);
    expect(result).toEqual({ kind: "auto-permanent", workspaceName: "Shared workspace" });
  });

  it("names a single-doc share after the workspace, not the file, when the room has a real name", () => {
    expect(decideJoinTarget([{ name: "Release Notes" }], 3, "Team Docs")).toEqual({ kind: "auto-preview", workspaceName: "Team Docs" });
    expect(decideJoinTarget([{ name: "Release Notes" }], 0, "Team Docs")).toEqual({ kind: "auto-permanent", workspaceName: "Team Docs" });
  });

  it("still falls back to the single file's name when the room has no name of its own", () => {
    expect(decideJoinTarget([{ name: "Release Notes" }], 3)).toEqual({ kind: "auto-preview", workspaceName: "Release Notes" });
  });
});

describe("pushWorkspaceRename", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PUTs the new name to the workspace's room when the workspace is shared", () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    workspacesStore.set([fakeSharedWorkspace({ id: "ws1", remoteId: "remote-1" })]);

    pushWorkspaceRename("ws1", "New Name");

    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/remote-1/meta", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
  });

  it("does nothing for a workspace that was never shared", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    workspacesStore.set([fakeWorkspace({ id: "ws1" })]);

    pushWorkspaceRename("ws1", "New Name");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pushWorkspaceDocDelete", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("DELETEs the document from the workspace's room when the workspace is shared", () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    workspacesStore.set([fakeSharedWorkspace({ id: "ws1", remoteId: "remote-1" })]);

    pushWorkspaceDocDelete("doc1", "ws1");

    expect(fetchMock).toHaveBeenCalledWith("/api/workspace/remote-1/docs?docId=doc1", { method: "DELETE" });
  });

  it("does nothing for a workspace that was never shared", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    workspacesStore.set([fakeWorkspace({ id: "ws1" })]);

    pushWorkspaceDocDelete("doc1", "ws1");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("also destroys this session's own Yjs binding for the deleted document immediately", async () => {
    document.body.innerHTML = '<div id="shareBtn"></div><div id="shareDropdownBtn"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (url.includes("/access") && init?.method === "PUT") {
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }) };
        }
        if (url.includes("/docs")) return { ok: true, json: async () => [] };
        return { ok: false, json: async () => ({}) };
      }),
    );
    window.MDE = {
      enterCollabMode: vi.fn(),
      exitCollabMode: vi.fn(),
      setReadOnly: vi.fn(),
      getEditor: vi.fn(() => ({ state: { doc: { toString: () => "hello" } } })),
      githubUsername: "alice",
      githubSessionReady: Promise.resolve(),
      setDocImage: vi.fn(),
      setDocName: vi.fn(),
      requireGithubSignIn: vi.fn(),
    } as unknown as typeof window.MDE;
    handleDocChanged(undefined as unknown as Doc);
    workspacesStore.set([fakeWorkspace({ id: "ws1", name: "WS" })]);
    activeWorkspaceIdStore.set("ws1");
    docsStore.set([{ id: "doc1", name: "My Doc", content: "hello", updatedAt: 0, createdAt: 0, workspaceId: "ws1" }]);
    activeIdStore.set("doc1");

    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(workspaceRoom.docs.has("doc1")).toBe(true);

    pushWorkspaceDocDelete("doc1", "ws1");

    expect(workspaceRoom.docs.has("doc1")).toBe(false);
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
    // Deferred, not synchronous: connectWorkspace() assigns onopen/onmessage
    // right after `new WebSocket(...)` returns, in the same synchronous
    // block this constructor runs in — opening before that assignment
    // would silently drop the callback, same as a real socket never opens
    // truly synchronously either.
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    });
  }
  // collab.ts's bindActiveDoc now waits for a binding's whenSynced before
  // attaching yCollab (see the fix for content duplicating on refresh —
  // a rejoining client must not act on a doc's Y.Text until it's had a
  // real chance to hold the room's actual content). That promise only
  // resolves once a content-bearing MESSAGE_SYNC frame comes back over
  // this socket, so a mock that stayed a pure no-op would hang every
  // caller of handleDocChanged/bindActiveDoc forever. Reply to any
  // outgoing sync frame with an immediate step2 for the same docId —
  // same shape as WorkspaceRoom.handleMessage's own reply to a client's
  // step1 — using an empty Y.Doc, since these tests only care that the
  // handshake completes, not about specific synced content.
  send(data: Uint8Array) {
    const decoder = decoding.createDecoder(data);
    if (decoding.readVarUint(decoder) !== 0 /* MESSAGE_SYNC */) return;
    const docId = decoding.readVarString(decoder);
    queueMicrotask(() => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0 /* MESSAGE_SYNC */);
      encoding.writeVarString(encoder, docId);
      syncProtocol.writeSyncStep2(encoder, new Y.Doc());
      this.onmessage?.({ data: encoding.toUint8Array(encoder).buffer as ArrayBuffer });
    });
  }
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
    // fetchWorkspaceDocIds -> bindActiveDoc, the last of which now also
    // waits on a binding's whenSynced — itself resolved via MockWebSocket's
    // own queueMicrotask'd sync-step2 reply, a few more hops deep than a
    // single join alone needs) to fully settle.
    for (let i = 0; i < 40; i++) await Promise.resolve();

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

describe("workspaceAccessDenied", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="shareBtn"></div><div id="body"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    workspaceAccessDenied.set(null);
  });

  function stubDeniedFetch(access: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access")) return { ok: true, json: async () => access };
        if (url.includes("/docs")) return { ok: true, json: async () => ["docA"] };
        return { ok: false, json: async () => ({}) };
      }),
    );
  }

  function stubMDE(username: string | null) {
    window.MDE = {
      enterCollabMode: vi.fn(),
      exitCollabMode: vi.fn(),
      setReadOnly: vi.fn(),
      getEditor: vi.fn(() => ({ state: { doc: { toString: () => "" } } })),
      githubUsername: username,
      githubSessionReady: Promise.resolve(),
      setDocImage: vi.fn(),
      requireGithubSignIn: vi.fn(),
    } as unknown as typeof window.MDE;
  }

  function makeDoc(suffix: string) {
    const ws = fakeSharedWorkspace({ id: `ws-${suffix}`, remoteId: `remote-${suffix}` });
    workspacesStore.set([ws]);
    const doc = { id: `doc-${suffix}`, name: "A", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    docsStore.set([doc]);
    return doc;
  }

  it("sets 'no-session' and locks the view when rejoining with no session at all", async () => {
    stubMDE(null);
    stubDeniedFetch({ owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const doc = makeDoc("nosession");

    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(get(workspaceAccessDenied)).toBe("no-session");
    expect(window.MDE.setReadOnly).toHaveBeenLastCalledWith(true);
    expect(get(viewModeLocked)).toBe(true);
  });

  it("sets 'no-access' when signed in but not granted a role", async () => {
    stubMDE("carol");
    stubDeniedFetch({
      owner: "alice",
      generalAccess: "restricted",
      requireAccount: false,
      role: "viewer",
      invited: [{ username: "bob", role: "editor" }],
    });
    const doc = makeDoc("noaccess");

    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(get(workspaceAccessDenied)).toBe("no-access");
    expect(window.MDE.setReadOnly).toHaveBeenLastCalledWith(true);
  });

  it("clears once a subsequent rejoin resolves a real role", async () => {
    stubMDE(null);
    stubDeniedFetch({ owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const doc = makeDoc("recover");

    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(get(workspaceAccessDenied)).toBe("no-session");

    stubMDE("alice");
    stubDeniedFetch({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] });

    handleDocChanged(doc);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(get(workspaceAccessDenied)).toBeNull();
  });

  it("clears when switching away to an unrelated local doc", async () => {
    stubMDE(null);
    stubDeniedFetch({ owner: "alice", generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] });
    const doc = makeDoc("switchaway");

    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(get(workspaceAccessDenied)).toBe("no-session");

    handleDocChanged({ id: "local-doc", name: "Local", content: "", updatedAt: 0, createdAt: 0, workspaceId: "some-other-ws" });

    expect(get(workspaceAccessDenied)).toBeNull();
  });
});

// COLLAB-31 — regression coverage for bb938d9. A fresh join into a shared
// workspace fires handleDocChanged reactively more than once in quick
// succession (switching workspace and switching doc are separate store
// triggers), each going through teardownWorkspace() before the winning
// rejoinKnownWorkspace() resolves. teardownWorkspace() used to
// unconditionally reset identityUnverified to false — including on the
// redundant cycles that fire after the real rejoin already set the correct
// value, leaving an anonymous viewer's "identity unverified" flag stuck
// off (so the signed-out indicator never showed). The reset now lives only
// in the two handleDocChanged branches that leave shared context for good.
describe("identityUnverified lifecycle", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="shareBtn"></div><div id="shareDropdownBtn"></div><div id="body"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    identityUnverified.set(false);
    workspaceAccessDenied.set(null);
  });

  function stubMDE(username: string | null) {
    window.MDE = {
      enterCollabMode: vi.fn(),
      exitCollabMode: vi.fn(),
      setReadOnly: vi.fn(),
      getEditor: vi.fn(() => ({ state: { doc: { toString: () => "" } } })),
      githubUsername: username,
      githubSessionReady: Promise.resolve(),
      setDocImage: vi.fn(),
      requireGithubSignIn: vi.fn(),
    } as unknown as typeof window.MDE;
  }

  function stubAnyoneFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access"))
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }) };
        if (url.includes("/docs")) return { ok: true, json: async () => ["docA"] };
        return { ok: false, json: async () => ({}) };
      }),
    );
  }

  function makeSharedDoc(suffix: string) {
    const ws = fakeSharedWorkspace({ id: `ws-${suffix}`, remoteId: `remote-${suffix}` });
    workspacesStore.set([ws]);
    const doc = { id: `doc-${suffix}`, name: "A", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    docsStore.set([doc]);
    return doc;
  }

  it("teardownWorkspace() on its own does not reset identityUnverified (bb938d9)", () => {
    identityUnverified.set(true);
    teardownWorkspace();
    expect(get(identityUnverified)).toBe(true);
  });

  it("ends up true for an anonymous viewer on an anyone-link workspace, even through a redundant rejoin", async () => {
    stubMDE(null);
    stubAnyoneFetch();
    const doc = makeSharedDoc("anon");

    // The real double-fire: workspace-switch and doc-switch each trigger
    // handleDocChanged before the first rejoin's awaits settle. The second
    // teardown supersedes the first rejoin; only the winner decides the flag.
    handleDocChanged(doc);
    handleDocChanged(doc);
    for (let i = 0; i < 40; i++) await Promise.resolve();

    expect(get(identityUnverified)).toBe(true);
    expect(workspaceRoom.workspaceId).toBe("remote-anon");

    // A further redundant fire once connected must not zero it either.
    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(get(identityUnverified)).toBe(true);
  });

  it("resets to false when the active doc leaves shared context for a local one", async () => {
    stubMDE(null);
    stubAnyoneFetch();
    const doc = makeSharedDoc("leave");

    handleDocChanged(doc);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(get(identityUnverified)).toBe(true);

    handleDocChanged({ id: "local-doc", name: "Local", content: "", updatedAt: 0, createdAt: 0, workspaceId: "plain-ws" });
    expect(get(identityUnverified)).toBe(false);
  });
});

// Regression coverage for "shared document name sync" (IMPROVEMENTS.md
// Phase 2): the document name now rides the same Y.Doc as its content, as
// a third top-level type ("meta") alongside ytext/imagesMap — the exact
// pattern imagesMap already established. These tests exercise both
// directions: a local rename pushed into the shared doc, and a remote
// rename applied back onto docsStore/the docTitle input.
describe("shared document name sync", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="shareBtn"></div><div id="shareDropdownBtn"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string }) => {
        if (url.includes("/access") && init?.method === "PUT") {
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }) };
        }
        if (url.includes("/docs")) {
          return { ok: true, json: async () => [] };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    window.MDE = {
      enterCollabMode: vi.fn(),
      exitCollabMode: vi.fn(),
      setReadOnly: vi.fn(),
      getEditor: vi.fn(() => ({ state: { doc: { toString: () => "hello" } } })),
      githubUsername: "alice",
      githubSessionReady: Promise.resolve(),
      setDocImage: vi.fn(),
      setDocName: vi.fn(),
      setDocMetadata: vi.fn(),
      setDocCitations: vi.fn(),
      requireGithubSignIn: vi.fn(),
    } as unknown as typeof window.MDE;

    // workspaceRoom is a module-level singleton shared across every test
    // in this file — reset it in case an earlier describe block (e.g.
    // "join-generation race" above) left it connected to its own
    // workspace, which would otherwise make setAccessMode below see
    // workspaceRoom.workspaceId already set and skip joining entirely.
    handleDocChanged(undefined as unknown as Doc);

    const ws = fakeWorkspace({ id: "ws1", name: "WS" });
    workspacesStore.set([ws]);
    activeWorkspaceIdStore.set("ws1");
    docsStore.set([{ id: "doc1", name: "My Doc", content: "hello", updatedAt: 0, createdAt: 0, workspaceId: "ws1" }]);
    activeIdStore.set("doc1");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("seeds the shared doc's current name into its Y.Doc meta map when sharing for the first time", async () => {
    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const binding = workspaceRoom.docs.get("doc1");
    expect(binding?.metaMap.get("name")).toBe("My Doc");
  });

  // Regression test: sharing a workspace for the first time seeded every
  // document's content and per-doc name but never pushed the WORKSPACE's
  // own name to the server, so WorkspaceRoom.name stayed "" — every
  // collaborator opening the share link then saw decideJoinTarget's
  // literal "Shared workspace" fallback (and applyWorkspaceMeta's
  // `if (name)` guard never healed it), including in JoinWorkspaceModal's
  // "<name> is shared with you" copy.
  it("pushes the workspace's own name to the server when sharing for the first time", async () => {
    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const calls = (fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }?][] } }).mock.calls;
    const metaPut = calls.find(([url, init]) => url === "/api/workspace/ws1/meta" && init?.method === "PUT");
    expect(metaPut).toBeTruthy();
    expect(JSON.parse(metaPut![1]!.body!)).toEqual({ name: "WS" });
  });

  it("applies a remote rename on the active doc via MDE.setDocName", async () => {
    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const binding = workspaceRoom.docs.get("doc1")!;
    binding.ydoc.transact(() => binding.metaMap.set("name", "Renamed By Collaborator"), "server");

    expect(window.MDE.setDocName).toHaveBeenCalledWith("doc1", "Renamed By Collaborator");
  });

  it("seeds the shared doc's current metadata into its Y.Doc meta map when sharing for the first time", async () => {
    docsStore.set([
      { id: "doc1", name: "My Doc", content: "hello", updatedAt: 0, createdAt: 0, workspaceId: "ws1", metadata: [{ key: "Title", value: "My Doc" }] },
    ]);
    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const binding = workspaceRoom.docs.get("doc1");
    expect(JSON.parse(binding?.metaMap.get("metadata") ?? "[]")).toEqual([{ key: "Title", value: "My Doc" }]);
  });

  it("applies a remote metadata change on the active doc via MDE.setDocMetadata", async () => {
    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const binding = workspaceRoom.docs.get("doc1")!;
    binding.ydoc.transact(() => binding.metaMap.set("metadata", JSON.stringify([{ key: "Title", value: "Remote" }])), "server");

    expect(window.MDE.setDocMetadata).toHaveBeenCalledWith("doc1", [{ key: "Title", value: "Remote" }]);
  });

  it("seeds the shared doc's current citations into its Y.Doc meta map when sharing for the first time", async () => {
    const citations = {
      prefs: { markerStyle: "pandoc" as const, bibliographySource: "structured" as const, displayStyle: "numbered" as const },
      bibliography: [{ key: "A", author: "Alpha", year: "2020", text: "Alpha (2020)." }],
    };
    docsStore.set([{ id: "doc1", name: "My Doc", content: "hello", updatedAt: 0, createdAt: 0, workspaceId: "ws1", citations }]);
    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const binding = workspaceRoom.docs.get("doc1");
    expect(JSON.parse(binding?.metaMap.get("citations") ?? "null")).toEqual(citations);
  });

  it("applies a remote citations change on the active doc via MDE.setDocCitations", async () => {
    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const binding = workspaceRoom.docs.get("doc1")!;
    const remote = {
      prefs: { markerStyle: "multimarkdown" as const, bibliographySource: "text" as const, displayStyle: "numbered" as const },
      bibliography: [],
    };
    binding.ydoc.transact(() => binding.metaMap.set("citations", JSON.stringify(remote)), "server");

    expect(window.MDE.setDocCitations).toHaveBeenCalledWith("doc1", remote);
  });

  // Regression test: sharing a workspace for the first time only ever
  // seeded the currently active document into the newly-created room —
  // any sibling document already in that local workspace was silently
  // left unsynced, so a collaborator joining afterward only ever saw the
  // one document the sharer happened to have open at share time.
  it("also seeds every other local document already in the workspace when sharing for the first time", async () => {
    docsStore.set([
      { id: "doc1", name: "My Doc", content: "hello", updatedAt: 0, createdAt: 0, workspaceId: "ws1" },
      { id: "doc2", name: "Sibling Doc", content: "sibling content", updatedAt: 0, createdAt: 0, workspaceId: "ws1" },
    ]);
    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const sibling = workspaceRoom.docs.get("doc2");
    expect(sibling).toBeDefined();
    expect(sibling?.ytext.toString()).toBe("sibling content");
    expect(sibling?.metaMap.get("name")).toBe("Sibling Doc");
  });

  // Regression test: a brand-new room's very first connection is greeted
  // with its current docIds synchronously, at accept time — before this
  // client has sent anything of its own over the socket (its own
  // sync-step1 burst only goes out once the socket's own onopen fires,
  // strictly later). Without registering every document via POST /docs
  // first, that first greeting's docOrder would still be empty, and this
  // same client's own applyWorkspaceMeta (see the "incoming workspace
  // meta sync" describe block) would read that as every document —
  // including the one just being seeded here — having just been deleted.
  it("registers the active document and every sibling with the room via POST /docs before sharing connects", async () => {
    docsStore.set([
      { id: "doc1", name: "My Doc", content: "hello", updatedAt: 0, createdAt: 0, workspaceId: "ws1" },
      { id: "doc2", name: "Sibling Doc", content: "sibling content", updatedAt: 0, createdAt: 0, workspaceId: "ws1" },
    ]);
    const fetchCalls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        fetchCalls.push({ url, method: init?.method, body: init?.body });
        if (url.includes("/access") && init?.method === "PUT") {
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }) };
        }
        if (url.includes("/docs")) {
          return { ok: true, json: async () => [] };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const postedIds = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/docs")).map((c) => JSON.parse(c.body ?? "{}").docId);
    expect(postedIds).toEqual(expect.arrayContaining(["doc1", "doc2"]));
  });

  // Regression test: the same first-share seeding, but reached via
  // addPerson (inviting someone by username) instead of setAccessMode
  // (flipping on "anyone with the link"). addPerson had its own,
  // narrower first-share block that only seeded the active document —
  // so inviting a collaborator into a multi-document workspace left
  // every sibling unregistered, and the room's first workspace-meta
  // greeting (docOrder = [active doc only]) made this same client's
  // applyWorkspaceMeta delete every sibling document locally. Data loss.
  it("also seeds every sibling document when the workspace is first shared by inviting a person", async () => {
    docsStore.set([
      { id: "doc1", name: "My Doc", content: "hello", updatedAt: 0, createdAt: 0, workspaceId: "ws1" },
      { id: "doc2", name: "Sibling Doc", content: "sibling content", updatedAt: 0, createdAt: 0, workspaceId: "ws1" },
    ]);
    const fetchCalls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        fetchCalls.push({ url, method: init?.method, body: init?.body });
        if (url.includes("/access") && init?.method === "PUT") {
          return {
            ok: true,
            json: async () => ({
              owner: "alice",
              generalAccess: "restricted",
              requireAccount: false,
              role: "viewer",
              invited: [{ username: "bob", role: "editor" }],
            }),
          };
        }
        if (url.includes("/docs")) {
          return { ok: true, json: async () => [] };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );

    await addPerson("bob");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const postedIds = fetchCalls.filter((c) => c.method === "POST" && c.url.includes("/docs")).map((c) => JSON.parse(c.body ?? "{}").docId);
    expect(postedIds).toEqual(expect.arrayContaining(["doc1", "doc2"]));

    const sibling = workspaceRoom.docs.get("doc2");
    expect(sibling).toBeDefined();
    expect(sibling?.ytext.toString()).toBe("sibling content");
    expect(sibling?.metaMap.get("name")).toBe("Sibling Doc");
  });

  // Regression: bindActiveDoc reconciles the editor against a freshly-
  // seeded (empty) ytext right after awaiting whenSynced but BEFORE
  // yCollab attaches. Content typed into the editor during that window
  // used to be wiped by the reconcile and never reached the Y.Doc, so a
  // collaborator saw an empty document. A locally-seeded binding whose
  // ytext is still empty must instead push the editor's content INTO
  // ytext.
  it("keeps content typed into a just-created shared doc before its binding attaches", async () => {
    await setAccessMode("anyone-link", "editor");
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // A brand-new doc: its stored content is "", so seedNewDocBinding
    // seeds an empty ytext. The user then types into the editor before
    // bindActiveDoc's async reconcile runs — model that by having the
    // editor mock report the typed content.
    let editorContent = "";
    (window.MDE.getEditor as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      state: { doc: { toString: () => editorContent }, readOnly: false },
      dispatch: vi.fn(),
    }));
    docsStore.update((docs) => [...docs, { id: "doc-race", name: "Raced", content: "", updatedAt: 0, createdAt: 0, workspaceId: "ws1" }]);
    activeIdStore.set("doc-race");
    editorContent = "typed before the binding attached";
    handleDocChanged({ id: "doc-race", name: "Raced", content: "", updatedAt: 0, createdAt: 0, workspaceId: "ws1" });
    for (let i = 0; i < 20; i++) await Promise.resolve();

    const raced = workspaceRoom.docs.get("doc-race");
    expect(raced).toBeDefined();
    expect(raced?.ytext.toString()).toBe("typed before the binding attached");
  });
});

describe("suggestion-mode role wiring", () => {
  // Distinct remoteId/docId per test — workspaceRoom.docs caches bindings
  // by docId for the lifetime of the module (createDocBinding returns the
  // existing binding if one's already there), and this file's tests all
  // share that one singleton, so reusing "docA"/the default remoteId
  // across these three role variants would silently reuse the FIRST
  // test's cached binding (and its role) for the other two.
  function setupWithRole(role: "reviewer" | "viewer" | "editor", suffix: string) {
    document.body.innerHTML = '<div id="shareBtn"></div><div id="body"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access")) {
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role, invited: [] }) };
        }
        if (url.includes("/docs")) {
          return { ok: true, json: async () => [`doc-${suffix}`] };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    const mde = {
      enterCollabMode: vi.fn(),
      exitCollabMode: vi.fn(),
      setReadOnly: vi.fn(),
      getEditor: vi.fn(() => ({ state: { doc: { toString: () => "" } } })),
      githubUsername: "bob",
      githubSessionReady: Promise.resolve(),
      setDocImage: vi.fn(),
      requireGithubSignIn: vi.fn(),
      updatePreview: vi.fn(),
    } as unknown as typeof window.MDE;
    window.MDE = mde;

    const ws = fakeSharedWorkspace({ id: `local-ws-${suffix}`, remoteId: `remote-${suffix}` });
    workspacesStore.set([ws]);
    const doc = { id: `doc-${suffix}`, name: "A", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    docsStore.set([doc]);
    return { mde, doc };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a reviewer's editor surface is NOT read-only (unlike today)", async () => {
    const { mde, doc } = setupWithRole("reviewer", "reviewer");
    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(mde.setReadOnly).toHaveBeenLastCalledWith(false);
  });

  it("a viewer's editor surface stays read-only", async () => {
    const { mde, doc } = setupWithRole("viewer", "viewer");
    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(mde.setReadOnly).toHaveBeenLastCalledWith(true);
  });

  it("a viewer's view mode is locked to Preview-only", async () => {
    const { doc } = setupWithRole("viewer", "viewer-lock");
    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(get(viewModeLocked)).toBe(true);
    expect(get(viewMode)).toBe("preview");
  });

  it("an editor's view mode is not locked", async () => {
    const { doc } = setupWithRole("editor", "editor-lock");
    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(get(viewModeLocked)).toBe(false);
  });

  it("an editor's editor surface stays writable", async () => {
    const { mde, doc } = setupWithRole("editor", "editor");
    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(mde.setReadOnly).toHaveBeenLastCalledWith(false);
  });

  // Regression: a delete suggestion is blocked from ever touching ytext
  // (that's the whole point — the text stays until an editor resolves it),
  // so CodeMirror's own docChanged never fires and app.ts's usual
  // updatePreview() trigger (EditorView.updateListener, gated on
  // update.docChanged) never runs. The same gap hits accepting an insert
  // or rejecting a delete — both just drop the suggestions-map entry
  // without touching ytext. Preview must instead refresh off the
  // suggestions map itself, the one thing every one of those cases does
  // change.
  it("a suggestions-map-only change (no ytext change) still refreshes Preview", async () => {
    const { mde, doc } = setupWithRole("reviewer", "preview-refresh");
    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const binding = workspaceRoom.docs.get(doc.id)!;
    (mde.updatePreview as ReturnType<typeof vi.fn>).mockClear();
    getSuggestionsMap(binding.ydoc).set("s1", {
      kind: "delete",
      author: "bob",
      createdAt: Date.now(),
      from: { type: {}, tname: null, item: null, assoc: 0 },
      to: { type: {}, tname: null, item: null, assoc: -1 },
    });
    // The refresh is deferred to a microtask (see collab.ts) to avoid
    // doing expensive work synchronously inside a Y.Doc transaction.
    await Promise.resolve();

    expect(mde.updatePreview).toHaveBeenCalled();
  });
});

// Regression coverage: a not-yet-bound document introduced while a
// workspace is already connected used to derive its role by reading
// *some other* binding's own .role (falling back to "editor" the moment
// that lookup came up empty) instead of using this session's own
// resolved connection role — a real bug, not just theoretical, since
// bindActiveDoc's own whenSynced await means workspaceRoom.activeDocId
// can still be null well after the session's real role is already known.
describe("connection-level role fallback (not derived from another binding)", () => {
  function setupViewerWithOneDoc(suffix: string) {
    document.body.innerHTML = '<div id="shareBtn"></div><div id="body"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access")) {
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "viewer", invited: [] }) };
        }
        if (url.includes("/docs")) {
          return { ok: true, json: async () => [`doc-${suffix}-a`] };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    window.MDE = {
      enterCollabMode: vi.fn(),
      exitCollabMode: vi.fn(),
      setReadOnly: vi.fn(),
      getEditor: vi.fn(() => ({ state: { doc: { toString: () => "" } } })),
      githubUsername: "bob",
      githubSessionReady: Promise.resolve(),
      setDocImage: vi.fn(),
      requireGithubSignIn: vi.fn(),
      updatePreview: vi.fn(),
    } as unknown as typeof window.MDE;

    const ws = fakeSharedWorkspace({ id: `local-ws-${suffix}`, remoteId: `remote-${suffix}` });
    workspacesStore.set([ws]);
    const docA = { id: `doc-${suffix}-a`, name: "A", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    const docB = { id: `doc-${suffix}-b`, name: "B", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    docsStore.set([docA, docB]);
    return { docA, docB };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("still resolves a viewer's own role for a second document even when activeDocId is null", async () => {
    const { docA, docB } = setupViewerWithOneDoc("rolefix");
    handleDocChanged(docA);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(workspaceRoom.role).toBe("viewer");
    // Forces the exact race this test guards against: bindActiveDoc only
    // sets activeDocId after its own whenSynced await settles, so there's
    // a real window where it's still null despite the session's role
    // already being fully known.
    workspaceRoom.activeDocId = null;

    handleDocChanged(docB);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const binding = workspaceRoom.docs.get(docB.id);
    expect(binding?.role).toBe("viewer");
  });
});

// Regression coverage for the mid-session doc-discovery gap: an
// already-connected collaborator previously had no way to learn about a
// document another collaborator created after they joined — the server
// already broadcasts every document's updates to every connected session
// (see workspace-room.ts's handleDocUpdate), but the client silently
// dropped any MESSAGE_SYNC/MESSAGE_AWARENESS frame for a docId it didn't
// already have a binding for.
describe("discovering a document created by another collaborator", () => {
  // Mirrors collab.ts's own (unexported) MESSAGE_SYNC/MESSAGE_AWARENESS
  // wire constants — these tests build raw frames by hand to exercise
  // handleServerMessage's decoding path directly, the same way a real
  // incoming WebSocket frame would.
  const MESSAGE_SYNC = 0;
  const MESSAGE_AWARENESS = 1;

  // Distinct remoteId/workspace id per test isn't enough on its own —
  // workspaceRoom.docs caches bindings by docId for the lifetime of the
  // module (see "suggestion-mode role wiring" above for the same note),
  // so this returns a fresh, uniquely-suffixed setup each time.
  async function setup(suffix: string) {
    document.body.innerHTML = '<div id="shareBtn"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access")) {
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }) };
        }
        if (url.includes("/docs")) {
          return { ok: true, json: async () => [`doc-${suffix}-a`] };
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

    const ws = fakeSharedWorkspace({ id: `local-ws-${suffix}`, remoteId: `remote-${suffix}` });
    workspacesStore.set([ws]);
    const doc = { id: `doc-${suffix}-a`, name: "A", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    docsStore.set([doc]);

    handleDocChanged(doc);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    return { ws };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sendRawSyncUpdate(docId: string, sourceDoc: Y.Doc) {
    const update = Y.encodeStateAsUpdate(sourceDoc);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    syncProtocol.writeUpdate(encoder, update);
    const buffer = encoding.toUint8Array(encoder).buffer;
    MockWebSocket.instances[0].onmessage!({ data: buffer } as MessageEvent);
  }

  function sendRawAwarenessFrame(docId: string) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarString(encoder, docId);
    encoding.writeVarUint8Array(encoder, new Uint8Array([1, 2, 3]));
    const buffer = encoding.toUint8Array(encoder).buffer;
    MockWebSocket.instances[0].onmessage!({ data: buffer } as MessageEvent);
  }

  it("creates a local document the first time a MESSAGE_SYNC frame arrives for an unrecognized docId", async () => {
    const { ws } = await setup("disc1");
    const sourceDoc = new Y.Doc();
    sourceDoc.getText("content").insert(0, "content from bob");
    sourceDoc.getMap<string>("meta").set("name", "Bob's New Doc");

    sendRawSyncUpdate("doc-disc1-b", sourceDoc);

    expect(workspaceRoom.docs.has("doc-disc1-b")).toBe(true);
    const localDoc = get(docsStore).find((d) => d.id === "doc-disc1-b");
    expect(localDoc?.name).toBe("Bob's New Doc");
    expect(localDoc?.content).toBe("content from bob");
    expect(localDoc?.workspaceId).toBe(ws.id);
  });

  it("falls back to 'Untitled' when the first frame carries no name yet", async () => {
    await setup("disc2");
    const sourceDoc = new Y.Doc();
    sourceDoc.getText("content").insert(0, "no name yet");

    sendRawSyncUpdate("doc-disc2-b", sourceDoc);

    const localDoc = get(docsStore).find((d) => d.id === "doc-disc2-b");
    expect(localDoc?.name).toBe("Untitled");
  });

  it("does not create a binding or a local document for a bare MESSAGE_AWARENESS frame naming an unrecognized docId", async () => {
    await setup("disc3");

    sendRawAwarenessFrame("doc-disc3-b");

    expect(workspaceRoom.docs.has("doc-disc3-b")).toBe(false);
    expect(get(docsStore).find((d) => d.id === "doc-disc3-b")).toBeUndefined();
  });

  it("does not re-import a document that's already locally known", async () => {
    const { ws } = await setup("disc4");
    docsStore.update((docs) => [...docs, { id: "doc-disc4-b", name: "Already Here", content: "existing", updatedAt: 0, createdAt: 0, workspaceId: ws.id }]);
    const countBefore = get(docsStore).length;

    const sourceDoc = new Y.Doc();
    sourceDoc.getText("content").insert(0, "server content");
    sourceDoc.getMap<string>("meta").set("name", "Server Name");
    sendRawSyncUpdate("doc-disc4-b", sourceDoc);

    expect(get(docsStore).length).toBe(countBefore);
    const localDoc = get(docsStore).find((d) => d.id === "doc-disc4-b");
    expect(localDoc?.name).toBe("Already Here");
  });
});

describe("incoming workspace meta sync (rename + document removal)", () => {
  const MESSAGE_WORKSPACE_META = 3;

  function sendWorkspaceMeta(name: string, docOrder: string[]) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_WORKSPACE_META);
    encoding.writeVarString(encoder, name);
    encoding.writeVarUint(encoder, docOrder.length);
    for (const id of docOrder) encoding.writeVarString(encoder, id);
    const buffer = encoding.toUint8Array(encoder).buffer;
    MockWebSocket.instances[0].onmessage!({ data: buffer } as MessageEvent);
  }

  async function setup(suffix: string) {
    document.body.innerHTML = '<div id="shareBtn"></div>';
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/access")) {
          return { ok: true, json: async () => ({ owner: "alice", generalAccess: "anyone", requireAccount: false, role: "editor", invited: [] }) };
        }
        if (url.includes("/docs")) {
          return { ok: true, json: async () => [`doc-${suffix}-a`, `doc-${suffix}-b`] };
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

    const ws = fakeSharedWorkspace({ id: `local-ws-${suffix}`, remoteId: `remote-${suffix}`, name: "Old Name" });
    workspacesStore.set([ws]);
    const docA = { id: `doc-${suffix}-a`, name: "A", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    const docB = { id: `doc-${suffix}-b`, name: "B", content: "", updatedAt: 0, createdAt: 0, workspaceId: ws.id };
    docsStore.set([docA, docB]);

    handleDocChanged(docA);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    return { ws, docA, docB };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates the local workspace's name when a non-empty name arrives", async () => {
    const { ws, docA, docB } = await setup("meta1");
    sendWorkspaceMeta("Renamed By Owner", [docA.id, docB.id]);

    expect(get(workspacesStore).find((w) => w.id === ws.id)?.name).toBe("Renamed By Owner");
  });

  it("leaves the local workspace's name alone when the incoming name is empty", async () => {
    const { ws } = await setup("meta2");
    sendWorkspaceMeta("", [`doc-meta2-a`, `doc-meta2-b`]);

    expect(get(workspacesStore).find((w) => w.id === ws.id)?.name).toBe("Old Name");
  });

  // Self-heal for workspaces shared before first-share pushed the name:
  // an editor receiving an empty-name meta frame contributes its own
  // local name back to the room instead of leaving it "" forever.
  it("pushes this editor's local name back to the room when the incoming name is empty", async () => {
    await setup("meta2b");
    (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length = 0;
    sendWorkspaceMeta("", [`doc-meta2b-a`, `doc-meta2b-b`]);

    const calls = (fetch as unknown as { mock: { calls: [string, { method?: string; body?: string }?][] } }).mock.calls;
    const metaPut = calls.find(([url, init]) => url === "/api/workspace/remote-meta2b/meta" && init?.method === "PUT");
    expect(metaPut).toBeTruthy();
    expect(JSON.parse(metaPut![1]!.body!)).toEqual({ name: "Old Name" });
  });

  it("removes a local document whose id is missing from the incoming docOrder, tearing down its binding", async () => {
    const { docB } = await setup("meta3");
    sendWorkspaceMeta("Old Name", [`doc-meta3-a`]);

    expect(get(docsStore).find((d) => d.id === docB.id)).toBeUndefined();
    expect(workspaceRoom.docs.has(docB.id)).toBe(false);
  });

  it("leaves a document alone whose id is still present in docOrder", async () => {
    const { docA, docB } = await setup("meta4");
    sendWorkspaceMeta("Old Name", [docA.id, docB.id]);

    expect(get(docsStore).find((d) => d.id === docA.id)).toBeDefined();
    expect(get(docsStore).find((d) => d.id === docB.id)).toBeDefined();
    expect(workspaceRoom.docs.has(docB.id)).toBe(true);
  });
});
