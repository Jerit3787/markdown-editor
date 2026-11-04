import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import { toasts } from "../../../client/src/stores/toast";
import { startPdfProgress } from "../../../client/src/export-progress";

describe("PDF export progress", () => {
  beforeEach(() => {
    toasts.set([]);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("walks from preparing through image counts and rendering elapsed time", () => {
    const progress = startPdfProgress();
    expect(get(toasts)).toEqual([{ id: expect.any(Number), message: "Preparing PDF…", type: "info", busy: true }]);

    progress.image(0, 3);
    expect(get(toasts)[0]?.message).toBe("Embedding 3 online images…");
    progress.image(1, 3);
    expect(get(toasts)[0]?.message).toBe("Embedding online image 1 of 3…");
    progress.image(3, 3);
    expect(get(toasts)[0]?.message).toBe("Embedding online image 3 of 3…");

    progress.rendering();
    expect(get(toasts)[0]?.message).toBe("Rendering pages…");
    vi.advanceTimersByTime(1000);
    expect(get(toasts)[0]?.message).toBe("Rendering pages… 1s");
    vi.advanceTimersByTime(2000);
    expect(get(toasts)[0]?.message).toBe("Rendering pages… 3s");

    progress.success("Exported radiant.pdf");
    expect(get(toasts)[0]).toMatchObject({ message: "Exported radiant.pdf", type: "success", busy: false });
    vi.advanceTimersByTime(1500);
    expect(get(toasts)[0]?.message).toBe("Exported radiant.pdf");
  });

  it("uses the singular when only one online image is being embedded", () => {
    const progress = startPdfProgress();
    progress.image(0, 1);
    expect(get(toasts)[0]?.message).toBe("Embedding 1 online image…");
  });

  it("keeps the info type when some images failed to embed", () => {
    const progress = startPdfProgress();
    progress.success("Exported radiant.pdf — 1 image couldn't be embedded", "info", 5000);
    expect(get(toasts)[0]).toMatchObject({ type: "info", busy: false });
  });

  it("turns a failure into an error toast and stops the elapsed timer", () => {
    const progress = startPdfProgress();
    progress.rendering();
    vi.advanceTimersByTime(2000);
    progress.error("Couldn't generate the PDF");
    expect(get(toasts)[0]).toMatchObject({ message: "Couldn't generate the PDF", type: "error", busy: false });
    vi.advanceTimersByTime(1500);
    expect(get(toasts)[0]?.message).toBe("Couldn't generate the PDF");
  });
});
