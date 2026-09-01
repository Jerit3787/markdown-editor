import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import WhatsNew from "../../../../client/src/components/WhatsNew.svelte";
import { whatsNewOpen } from "../../../../client/src/stores/whatsNew";

const STORAGE_KEY = "mde:whatsNewSeen";

beforeEach(() => {
  // Already caught up — the auto-open flow never fires, isolating these
  // tests to the manual-reopen path this task is actually changing.
  localStorage.setItem(STORAGE_KEY, __APP_VERSION__);
  whatsNewOpen.set(false);
});

function openManually() {
  whatsNewOpen.set(true);
}

test("manual reopen shows the category index, not a slide", async () => {
  const screen = await render(WhatsNew);
  openManually();
  await expect.element(screen.getByText("Editing & Formatting")).toBeVisible();
  await expect.element(screen.getByText("Collaboration")).toBeVisible();
  await expect.element(screen.getByText("Version History")).toBeVisible();
  await expect.element(screen.getByText("GitHub Integration")).toBeVisible();
  await expect.element(screen.getByText("Organization & Navigation")).toBeVisible();
});

test("clicking a category enters its stepper at the newest entry, newest-first", async () => {
  const screen = await render(WhatsNew);
  openManually();
  await screen.getByText("GitHub Integration").click();
  // Newest of the 3 GitHub Integration entries by version (1.34.0).
  await expect.element(screen.getByText("Choose Gist Visibility")).toBeVisible();
  await expect.element(screen.getByText("1 of 3")).toBeVisible();
});

test("the last slide's button reads Done, and it returns to the index", async () => {
  const screen = await render(WhatsNew);
  openManually();
  await screen.getByText("GitHub Integration").click();
  await screen.getByRole("button", { name: "Next →" }).click();
  await screen.getByRole("button", { name: "Next →" }).click();
  await expect.element(screen.getByText("3 of 3")).toBeVisible();
  await screen.getByRole("button", { name: "Done" }).click();
  await expect.element(screen.getByText("GitHub Integration")).toBeVisible();
  await expect.element(screen.getByText("Choose Gist Visibility")).not.toBeInTheDocument();
});

test("the Categories back-link returns to the index without finishing the stepper", async () => {
  const screen = await render(WhatsNew);
  openManually();
  await screen.getByText("GitHub Integration").click();
  await screen.getByText("Categories").click();
  await expect.element(screen.getByText("Editing & Formatting")).toBeVisible();
});

test("the auto-open (missed entries) flow never shows the category index", async () => {
  localStorage.setItem(STORAGE_KEY, "1.10.0"); // far behind — several entries missed
  const screen = await render(WhatsNew);
  // Auto-opens on its own; no manual whatsNewOpen.set(true) needed.
  await expect.element(screen.getByRole("button", { name: "Next →" })).toBeVisible();
  await expect.element(screen.getByText("Editing & Formatting")).not.toBeInTheDocument();
});
