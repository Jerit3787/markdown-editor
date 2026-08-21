import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { debounceWithFlush } from "./debounce";

describe("debounceWithFlush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not call fn immediately on trigger", () => {
    const fn = vi.fn();
    const d = debounceWithFlush(fn, 400);
    d.trigger();
    expect(fn).not.toHaveBeenCalled();
  });

  it("calls fn once after the delay elapses", () => {
    const fn = vi.fn();
    const d = debounceWithFlush(fn, 400);
    d.trigger();
    vi.advanceTimersByTime(400);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resets the delay on repeated triggers", () => {
    const fn = vi.fn();
    const d = debounceWithFlush(fn, 400);
    d.trigger();
    vi.advanceTimersByTime(300);
    d.trigger(); // resets the clock
    vi.advanceTimersByTime(300);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runNow cancels any pending schedule and runs immediately", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const d = debounceWithFlush(fn, 400);
    d.trigger();
    const result = await d.runNow();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toBe("result");
    // advancing time afterward must not cause a second call
    vi.advanceTimersByTime(400);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush runs a pending scheduled call immediately and awaits it", async () => {
    const fn = vi.fn().mockResolvedValue("flushed");
    const d = debounceWithFlush(fn, 400);
    d.trigger();
    const result = await d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toBe("flushed");
  });

  it("flush resolves to undefined when nothing is pending or in flight", async () => {
    const fn = vi.fn();
    const d = debounceWithFlush(fn, 400);
    const result = await d.flush();
    expect(fn).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("flush awaits an already in-flight run instead of starting a second one", async () => {
    let resolveFn: (v: string) => void;
    const fn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
    );
    const d = debounceWithFlush(fn, 400);
    d.trigger();
    vi.advanceTimersByTime(400); // fn is now in flight, not yet resolved
    expect(fn).toHaveBeenCalledTimes(1);
    const flushPromise = d.flush();
    resolveFn!("done");
    expect(await flushPromise).toBe("done");
    expect(fn).toHaveBeenCalledTimes(1); // still only once
  });
});
