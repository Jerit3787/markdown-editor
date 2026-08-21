import { describe, it, expect } from "vitest";
import { mergeById } from "../../../client/src/merge-records";

interface Item {
  id: string;
  updatedAt: number;
  label: string;
}

describe("mergeById", () => {
  it("keeps the current version when it's newer", () => {
    const current: Item[] = [{ id: "a", updatedAt: 10, label: "current" }];
    const external: Item[] = [{ id: "a", updatedAt: 5, label: "external" }];
    expect(mergeById(current, external)).toEqual([{ id: "a", updatedAt: 10, label: "current" }]);
  });

  it("keeps the external version when it's newer", () => {
    const current: Item[] = [{ id: "a", updatedAt: 5, label: "current" }];
    const external: Item[] = [{ id: "a", updatedAt: 10, label: "external" }];
    expect(mergeById(current, external)).toEqual([{ id: "a", updatedAt: 10, label: "external" }]);
  });

  it("keeps the current version on a tie", () => {
    const current: Item[] = [{ id: "a", updatedAt: 10, label: "current" }];
    const external: Item[] = [{ id: "a", updatedAt: 10, label: "external" }];
    expect(mergeById(current, external)).toEqual([{ id: "a", updatedAt: 10, label: "current" }]);
  });

  it("keeps a record present only in current", () => {
    const current: Item[] = [{ id: "a", updatedAt: 1, label: "only-current" }];
    expect(mergeById(current, [])).toEqual([{ id: "a", updatedAt: 1, label: "only-current" }]);
  });

  it("keeps a record present only in external", () => {
    const external: Item[] = [{ id: "a", updatedAt: 1, label: "only-external" }];
    expect(mergeById([], external)).toEqual([{ id: "a", updatedAt: 1, label: "only-external" }]);
  });

  it("returns current unchanged when external is empty", () => {
    const current: Item[] = [
      { id: "a", updatedAt: 1, label: "a" },
      { id: "b", updatedAt: 2, label: "b" },
    ];
    expect(mergeById(current, [])).toEqual(current);
  });

  it("returns external unchanged when current is empty", () => {
    const external: Item[] = [
      { id: "a", updatedAt: 1, label: "a" },
      { id: "b", updatedAt: 2, label: "b" },
    ];
    expect(mergeById([], external)).toEqual(external);
  });
});
