import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import { toasts, showToast, dismissToast, showProgressToast, updateProgressToast, finishProgressToast } from "../../../../client/src/stores/toast";

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

describe("regular toasts (SHELL-05)", () => {
  beforeEach(() => {
    toasts.set([]);
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("enqueues with the given message and type, defaulting to info", () => {
    showToast("Saved");
    showToast("Something broke", "error");
    expect(get(toasts).map((t) => [t.message, t.type])).toEqual([
      ["Saved", "info"],
      ["Something broke", "error"],
    ]);
  });

  it("auto-dismisses after its duration and not a tick before", () => {
    showToast("bye", "info", 2000);
    vi.advanceTimersByTime(1999);
    expect(get(toasts)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(get(toasts)).toHaveLength(0);
  });

  it("stacks multiple toasts, each with a distinct id, and each dismisses on its own timer", () => {
    showToast("first", "info", 1000);
    showToast("second", "info", 3000);
    const ids = get(toasts).map((t) => t.id);
    expect(new Set(ids).size).toBe(2);
    vi.advanceTimersByTime(1000);
    expect(get(toasts).map((t) => t.message)).toEqual(["second"]);
    vi.advanceTimersByTime(2000);
    expect(get(toasts)).toHaveLength(0);
  });

  it("dismissToast removes just the targeted toast immediately", () => {
    showToast("a", "info", 9999);
    showToast("b", "info", 9999);
    const [first] = get(toasts);
    dismissToast(first!.id);
    expect(get(toasts).map((t) => t.message)).toEqual(["b"]);
  });
});
