import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import {
  maybeSnapshotVersion,
  listVersions,
  getVersionContent,
  getVersionImages,
  restoreLocalVersion,
  deleteHistory,
  getHistory,
  mergeSnapshotsFromRepo,
} from "../../../client/src/history";

// Every test uses its own docId (rather than resetting the shared fake
// IndexedDB database between tests) so tests can't leak state into each
// other — simpler than depending on fake-indexeddb's internal reset
// mechanism, which this codebase has no prior usage of to model against.

describe("local version history", () => {
  it("creates a snapshot the first time a document is seen", async () => {
    await maybeSnapshotVersion("doc-first", "hello", 1_000);
    const versions = await listVersions("doc-first");
    expect(versions).toHaveLength(1);
  });

  it("does not snapshot before the throttle window elapses", async () => {
    await maybeSnapshotVersion("doc-throttle-skip", "hello", 1_000);
    await maybeSnapshotVersion("doc-throttle-skip", "hello world", 1_000 + 20 * 1000);
    expect(await listVersions("doc-throttle-skip")).toHaveLength(1);
  });

  it("keeps every snapshot within a still-open session", async () => {
    await maybeSnapshotVersion("doc-open-session", "v0", 1_000);
    await maybeSnapshotVersion("doc-open-session", "v1", 1_000 + 35 * 1000);
    await maybeSnapshotVersion("doc-open-session", "v2", 1_000 + 70 * 1000);
    expect(await listVersions("doc-open-session")).toHaveLength(3);
  });

  it("collapses a closed session to its final snapshot once a new session starts", async () => {
    await maybeSnapshotVersion("doc-closed-session", "v0", 1_000);
    await maybeSnapshotVersion("doc-closed-session", "v1", 1_000 + 35 * 1000);
    await maybeSnapshotVersion("doc-closed-session", "v2", 1_000 + 70 * 1000);
    // A gap over 30 minutes closes the session "v0, v1, v2" belong to.
    await maybeSnapshotVersion("doc-closed-session", "v3", 1_000 + 70 * 1000 + 31 * 60 * 1000);
    const versions = await listVersions("doc-closed-session");
    // listVersions reverses to newest-first.
    expect(versions.map((v) => v.id).length).toBe(2);
    expect(await getVersionContent("doc-closed-session", versions[1]!.id)).toBe("v2");
    expect(await getVersionContent("doc-closed-session", versions[0]!.id)).toBe("v3");
  });

  it("snapshots again once the throttle window elapses and content changed", async () => {
    await maybeSnapshotVersion("doc-throttle-elapsed", "hello", 1_000);
    await maybeSnapshotVersion("doc-throttle-elapsed", "hello world", 1_000 + 6 * 60 * 1000);
    const versions = await listVersions("doc-throttle-elapsed");
    expect(versions).toHaveLength(2);
  });

  it("does not snapshot if content is unchanged, even past the throttle window", async () => {
    await maybeSnapshotVersion("doc-unchanged", "hello", 1_000);
    await maybeSnapshotVersion("doc-unchanged", "hello", 1_000 + 6 * 60 * 1000);
    expect(await listVersions("doc-unchanged")).toHaveLength(1);
  });

  it("prunes the oldest snapshot past the 300 cap", async () => {
    for (let i = 0; i < 301; i++) {
      await maybeSnapshotVersion("doc-cap", `v${i}`, 1_000 + i * 35 * 1000);
    }
    const versions = await listVersions("doc-cap");
    expect(versions).toHaveLength(300);
  });

  it("lists newest first", async () => {
    await maybeSnapshotVersion("doc-order", "v1", 1_000);
    await maybeSnapshotVersion("doc-order", "v2", 1_000 + 6 * 60 * 1000);
    const versions = await listVersions("doc-order");
    expect(versions[0]!.timestamp).toBeGreaterThan(versions[1]!.timestamp);
  });

  it("getVersionContent returns the stored content for an id", async () => {
    await maybeSnapshotVersion("doc-content", "hello", 1_000);
    const [v] = await listVersions("doc-content");
    expect(await getVersionContent("doc-content", v!.id)).toBe("hello");
  });

  it("restoreLocalVersion returns the content and images, and force-appends a new snapshot", async () => {
    await maybeSnapshotVersion("doc-restore", "v1", 1_000, { "img-1": "data:image/png;base64,aGk=" });
    await maybeSnapshotVersion("doc-restore", "v2", 1_000 + 6 * 60 * 1000);
    const [v1] = (await listVersions("doc-restore")).slice(-1);
    const result = await restoreLocalVersion("doc-restore", v1!.id, 1_000 + 6.1 * 60 * 1000);
    expect(result).toEqual({ content: "v1", images: { "img-1": "data:image/png;base64,aGk=" } });
    const versions = await listVersions("doc-restore");
    expect(versions).toHaveLength(3);
    expect(await getVersionContent("doc-restore", versions[0]!.id)).toBe("v1");
    expect(await getVersionImages("doc-restore", versions[0]!.id)).toEqual({ "img-1": "data:image/png;base64,aGk=" });
  });

  it("deleteHistory removes a document's snapshots", async () => {
    await maybeSnapshotVersion("doc-delete", "hello", 1_000);
    await deleteHistory("doc-delete");
    expect(await listVersions("doc-delete")).toHaveLength(0);
  });

  it("a failed snapshot write does not throw", async () => {
    const realIndexedDB = indexedDB;
    try {
      // Deliberately breaking indexedDB to prove maybeSnapshotVersion
      // degrades silently rather than propagating.
      (globalThis as { indexedDB?: IDBFactory }).indexedDB = undefined;
      await expect(maybeSnapshotVersion("doc-failure", "hello", 1_000)).resolves.toBeUndefined();
    } finally {
      indexedDB = realIndexedDB;
    }
  });
});

describe("local version history — images", () => {
  it("stores images alongside content and getVersionImages returns them", async () => {
    await maybeSnapshotVersion("doc-images", "hello", 1_000, { "img-1": "data:image/png;base64,aGk=" });
    const [v] = await listVersions("doc-images");
    expect(await getVersionImages("doc-images", v!.id)).toEqual({ "img-1": "data:image/png;base64,aGk=" });
  });

  it("getVersionImages returns undefined for a snapshot taken with no images argument", async () => {
    await maybeSnapshotVersion("doc-no-images", "hello", 1_000);
    const [v] = await listVersions("doc-no-images");
    expect(await getVersionImages("doc-no-images", v!.id)).toBeUndefined();
  });

  it("getVersionImages returns undefined for an unknown version id", async () => {
    expect(await getVersionImages("doc-images-unknown", "nonexistent")).toBeUndefined();
  });
});

describe("mergeSnapshotsFromRepo", () => {
  it("adds remote snapshots the local device doesn't have yet", async () => {
    await maybeSnapshotVersion("doc-merge-add", "local v1", 1_000);
    await mergeSnapshotsFromRepo("doc-merge-add", [{ id: "remote-1", timestamp: 500, content: "remote v0" }]);
    const versions = await listVersions("doc-merge-add");
    expect(versions.map((v) => v.id).sort()).toEqual(expect.arrayContaining(["remote-1"]));
    expect(versions).toHaveLength(2);
  });

  it("does not duplicate a remote snapshot whose id already exists locally", async () => {
    await maybeSnapshotVersion("doc-merge-dupe", "v1", 1_000);
    const local = await getHistory("doc-merge-dupe");
    await mergeSnapshotsFromRepo("doc-merge-dupe", [local[0]!]);
    expect(await listVersions("doc-merge-dupe")).toHaveLength(1);
  });

  it("re-sorts by timestamp and re-caps at 300 after merging", async () => {
    for (let i = 0; i < 280; i++) {
      await maybeSnapshotVersion("doc-merge-cap", `v${i}`, 1_000 + i * 35 * 1000);
    }
    const remote = Array.from({ length: 40 }, (_, i) => ({
      id: `remote-${i}`,
      timestamp: 1_000 + (280 + i) * 35 * 1000,
      content: `remote v${i}`,
    }));
    await mergeSnapshotsFromRepo("doc-merge-cap", remote);
    const versions = await listVersions("doc-merge-cap");
    expect(versions).toHaveLength(300);
    // listVersions reverses to newest-first — the newest merged-in remote entry must survive the cap
    expect(versions[0]!.id).toBe("remote-39");
  });
});
