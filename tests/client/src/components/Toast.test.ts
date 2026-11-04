import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import Toast from "../../../../client/src/components/Toast.svelte";
import { toasts, showProgressToast, finishProgressToast } from "../../../../client/src/stores/toast";

beforeEach(() => {
  toasts.set([]);
});

test("a busy toast renders a progress indicator that disappears when the operation finishes", async () => {
  const id = showProgressToast("Rendering pages…");
  const screen = await render(Toast);

  await expect.element(screen.getByRole("progressbar")).toBeInTheDocument();

  finishProgressToast(id, "Exported radiant.pdf", "success", 60000);
  await expect.element(screen.getByRole("progressbar")).not.toBeInTheDocument();
});
