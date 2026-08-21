import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import { toasts, showProgressToast, updateProgressToast, finishProgressToast } from "../../../../client/src/stores/toast";

describe("progress toasts", () => {
  beforeEach(() => {
    toasts.set([]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("showProgressToast adds a toast with no scheduled auto-removal", () => {
    const id = showProgressToast("Pushing…");
    expect(get(toasts)).toEqual([{ id, message: "Pushing…", type: "info" }]);
    vi.advanceTimersByTime(60000);
    expect(get(toasts)).toEqual([{ id, message: "Pushing…", type: "info" }]);
  });

  it("updateProgressToast replaces the message in place, keeping id and type", () => {
    const id = showProgressToast("Pushing…");
    updateProgressToast(id, "Pushing 3/8 files…");
    expect(get(toasts)).toEqual([{ id, message: "Pushing 3/8 files…", type: "info" }]);
  });

  it("finishProgressToast sets the final message/type, then it's gone after its duration", () => {
    const id = showProgressToast("Pushing…");
    finishProgressToast(id, "Pushed to repo", "success", 1000);
    expect(get(toasts)).toEqual([{ id, message: "Pushed to repo", type: "success" }]);
    vi.advanceTimersByTime(999);
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(get(toasts)).toHaveLength(0);
  });
});
