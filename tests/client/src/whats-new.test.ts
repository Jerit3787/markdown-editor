import { describe, it, expect } from "vitest";
import { compareVersions, missedEntries, groupByCategory } from "../../../client/src/whats-new";
import type { WhatsNewEntry } from "../../../client/src/whats-new-entries";

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.10.0", "1.10.0")).toBe(0);
  });

  it("returns positive when a > b", () => {
    expect(compareVersions("1.11.0", "1.10.0")).toBeGreaterThan(0);
  });

  it("returns negative when a < b", () => {
    expect(compareVersions("1.10.0", "1.11.0")).toBeLessThan(0);
  });

  it("compares multi-digit segments numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });
});

describe("missedEntries", () => {
  const entries: WhatsNewEntry[] = [
    { version: "1.10.0", title: "A", description: "a", screenshot: "/a.png", category: "Editing & Formatting" },
    { version: "1.11.0", title: "B", description: "b", screenshot: "/b.png", category: "Editing & Formatting" },
    { version: "1.12.0", title: "C", description: "c", screenshot: "/c.png", category: "Editing & Formatting" },
  ];

  it("returns only the newest entry when nothing has been seen", () => {
    expect(missedEntries(entries, null)).toEqual([entries[2]]);
  });

  it("returns everything strictly newer than lastSeen", () => {
    expect(missedEntries(entries, "1.10.0")).toEqual([entries[1], entries[2]]);
  });

  it("returns an empty array when already caught up", () => {
    expect(missedEntries(entries, "1.12.0")).toEqual([]);
  });

  it("returns an empty array for an empty entries list regardless of lastSeen", () => {
    expect(missedEntries([], null)).toEqual([]);
    expect(missedEntries([], "1.0.0")).toEqual([]);
  });
});

describe("groupByCategory", () => {
  const entries: WhatsNewEntry[] = [
    { version: "1.0.0", title: "A", description: "a", screenshot: "/a.png", category: "Editing & Formatting" },
    { version: "1.1.0", title: "B", description: "b", screenshot: "/b.png", category: "Collaboration" },
    { version: "1.2.0", title: "C", description: "c", screenshot: "/c.png", category: "Editing & Formatting" },
    { version: "1.3.0", title: "D", description: "d", screenshot: "/d.png", category: "Collaboration" },
  ];

  it("groups entries by category, ordered by each category's first appearance", () => {
    const groups = groupByCategory(entries);
    expect(groups.map((g) => g.category)).toEqual(["Editing & Formatting", "Collaboration"]);
  });

  it("orders entries within each category newest-first", () => {
    const groups = groupByCategory(entries);
    expect(groups[0]!.entries.map((e) => e.title)).toEqual(["C", "A"]);
    expect(groups[1]!.entries.map((e) => e.title)).toEqual(["D", "B"]);
  });

  it("returns an empty array for no entries", () => {
    expect(groupByCategory([])).toEqual([]);
  });
});
