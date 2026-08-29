import { describe, it, expect } from "vitest";
import { groupSnapshotsIntoSessions, SESSION_GAP_MS } from "../../src/version-grouping";

describe("groupSnapshotsIntoSessions (Worker copy)", () => {
  it("returns an empty array for no snapshots", () => {
    expect(groupSnapshotsIntoSessions([])).toEqual([]);
  });

  it("groups consecutive snapshots within the gap into one session", () => {
    const groups = groupSnapshotsIntoSessions([
      { id: "a", timestamp: 0 },
      { id: "b", timestamp: 5 * 60 * 1000 },
    ]);
    expect(groups).toHaveLength(1);
  });

  it("starts a new group when the gap exceeds the threshold", () => {
    const groups = groupSnapshotsIntoSessions([
      { id: "a", timestamp: 0 },
      { id: "b", timestamp: 40 * 60 * 1000 },
    ]);
    expect(groups).toHaveLength(2);
  });

  it("exports the default 30-minute session gap", () => {
    expect(SESSION_GAP_MS).toBe(30 * 60 * 1000);
  });
});
