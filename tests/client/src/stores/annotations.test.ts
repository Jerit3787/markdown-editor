import { describe, it, expect } from "vitest";
import { get } from "svelte/store";
import { activeAnnotationIds } from "../../../../client/src/stores/annotations";

describe("activeAnnotationIds", () => {
  it("starts empty and holds a set of ids", () => {
    expect(get(activeAnnotationIds)).toEqual([]);
    activeAnnotationIds.set(["a", "b"]);
    expect(get(activeAnnotationIds)).toEqual(["a", "b"]);
    activeAnnotationIds.set([]);
    expect(get(activeAnnotationIds)).toEqual([]);
  });
});
