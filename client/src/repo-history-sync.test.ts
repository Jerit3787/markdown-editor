import { describe, it, expect, vi, afterEach } from "vitest";
import "fake-indexeddb/auto";
import { fetchAndMergeRepoHistory, resetFetchedHistoryCache } from "./repo-history-sync";
import { docsStore } from "./stores/docs";
import { createWorkspace, setWorkspaceRepoLink } from "./stores/workspaces";
import { getHistory } from "./history";
import type { Doc } from "./types";

afterEach(() => {
  vi.unstubAllGlobals();
  resetFetchedHistoryCache();
});

// Every test uses its own docId (see history.test.ts's own comment for
// why: sharing one id across tests would leak fake-indexeddb state
// between them, since nothing here resets that shared database).
function linkedDoc(id: string, overrides: Partial<Doc> = {}): Doc {
  const ws = createWorkspace("Linked");
  setWorkspaceRepoLink(ws.id, { owner: "acme", repo: "docs", branch: "main" });
  const doc: Doc = { id, name: "notes", content: "hi", updatedAt: 1, createdAt: 1, workspaceId: ws.id, repoPath: "notes.md", ...overrides };
  docsStore.set([doc]);
  return doc;
}

describe("fetchAndMergeRepoHistory", () => {
  it("does nothing for a doc with no repoPath", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await fetchAndMergeRepoHistory({ id: "doc-no-repopath", name: "n", content: "", updatedAt: 1, createdAt: 1, workspaceId: "w1" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("merges remote snapshots and notes on a successful fetch", async () => {
    const doc = linkedDoc("doc-merge-success");
    const remote = {
      snapshots: [{ id: "remote-snap", timestamp: 500, content: "old" }],
      notes: [{ id: "remote-note", from: 0, to: 2, quote: "hi", orphaned: false, body: "b", createdAt: 500 }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ content: btoa(JSON.stringify(remote)), encoding: "base64" }), { status: 200 })),
    );
    await fetchAndMergeRepoHistory(doc);
    expect((await getHistory("doc-merge-success")).map((s) => s.id)).toEqual(["remote-snap"]);
    // mergeDocNotes writes into docsStore directly — read it back the same way
    let notes: { id: string }[] | undefined;
    docsStore.subscribe((docs) => (notes = docs.find((d) => d.id === "doc-merge-success")?.notes))();
    expect(notes?.map((n) => n.id)).toEqual(["remote-note"]);
  });

  it("does nothing (no throw) on a 404 — no companion file pushed yet", async () => {
    const doc = linkedDoc("doc-404");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    await expect(fetchAndMergeRepoHistory(doc)).resolves.toBeUndefined();
    expect(await getHistory("doc-404")).toEqual([]);
  });

  it("only fetches once per doc per session even if called again", async () => {
    const doc = linkedDoc("doc-fetch-once");
    const remote = { snapshots: [], notes: [] };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ content: btoa(JSON.stringify(remote)), encoding: "base64" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchAndMergeRepoHistory(doc);
    await fetchAndMergeRepoHistory(doc);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
