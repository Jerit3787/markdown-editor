import { describe, it, expect } from "vitest";
import { groupSnapshotsIntoSessions, SESSION_GAP_MS } from "../../../client/src/version-grouping";

describe("groupSnapshotsIntoSessions", () => {
  it("returns an empty array for no snapshots", () => {
    expect(groupSnapshotsIntoSessions([])).toEqual([]);
  });

  it("puts a single snapshot into its own one-entry group", () => {
    const groups = groupSnapshotsIntoSessions([{ id: "a", timestamp: 1000 }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(["a"]);
    expect(groups[0]!.startTimestamp).toBe(1000);
    expect(groups[0]!.endTimestamp).toBe(1000);
  });

  it("groups consecutive snapshots within the gap into one session", () => {
    const groups = groupSnapshotsIntoSessions([
      { id: "a", timestamp: 0 },
      { id: "b", timestamp: 5 * 60 * 1000 },
      { id: "c", timestamp: 10 * 60 * 1000 },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(groups[0]!.startTimestamp).toBe(0);
    expect(groups[0]!.endTimestamp).toBe(10 * 60 * 1000);
  });

  it("starts a new group when the gap exceeds the threshold", () => {
    const groups = groupSnapshotsIntoSessions([
      { id: "a", timestamp: 0 },
      { id: "b", timestamp: 40 * 60 * 1000 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(["a"]);
    expect(groups[1]!.entries.map((e) => e.id)).toEqual(["b"]);
  });

  it("respects a custom sessionGapMs", () => {
    const groups = groupSnapshotsIntoSessions(
      [
        { id: "a", timestamp: 0 },
        { id: "b", timestamp: 5000 },
      ],
      1000,
    );
    expect(groups).toHaveLength(2);
  });

  it("exports the default 30-minute session gap", () => {
    expect(SESSION_GAP_MS).toBe(30 * 60 * 1000);
  });
});
