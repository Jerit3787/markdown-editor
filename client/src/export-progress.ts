import { finishProgressToast, showProgressToast, updateProgressToast } from "./stores/toast";

export interface PdfExportProgress {
  image(done: number, total: number): void;
  rendering(): void;
  success(message: string, type?: "success" | "info", duration?: number): void;
  error(message: string): void;
}

// One progress toast for the whole PDF export. The image phase has a real
// count; html2pdf has no page progress event, so the render phase shows an
// elapsed timer instead of pretending to know a percentage.
export function startPdfProgress(): PdfExportProgress {
  const id = showProgressToast("Preparing PDF…");
  let timer: ReturnType<typeof setInterval> | undefined;

  function stopTimer() {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return {
    image(done, total) {
      if (total <= 0) return;
      if (done <= 0) {
        updateProgressToast(id, `Embedding ${total} online image${total === 1 ? "" : "s"}…`);
        return;
      }
      updateProgressToast(id, `Embedding online image ${done} of ${total}…`);
    },

    rendering() {
      stopTimer();
      const startedAt = Date.now();
      updateProgressToast(id, "Rendering pages…");
      timer = setInterval(() => {
        const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        updateProgressToast(id, `Rendering pages… ${seconds}s`);
      }, 1000);
    },

    success(message, type = "success", duration) {
      stopTimer();
      finishProgressToast(id, message, type, duration);
    },

    error(message) {
      stopTimer();
      finishProgressToast(id, message, "error");
    },
  };
}
