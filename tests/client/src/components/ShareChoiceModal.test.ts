import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import ShareChoiceModal from "../../../../client/src/components/ShareChoiceModal.svelte";
import { shareChoiceRequest } from "../../../../client/src/stores/shareChoice";

beforeEach(() => shareChoiceRequest.set(null));

function open(resolve = vi.fn()) {
  shareChoiceRequest.set({ docName: "Roadmap", workspaceName: "Team", docCount: 4, resolve });
  return resolve;
}

test("COLLAB-24: renders nothing until a choice is requested", async () => {
  const screen = await render(ShareChoiceModal);
  expect(screen.container.querySelector('[role="dialog"]')).toBeNull();
  open();
  await expect.poll(() => !!screen.container.querySelector('[role="dialog"]')).toBe(true);
});

test("COLLAB-24: choosing 'Just this document' resolves 'document' and dismisses", async () => {
  const resolve = open();
  const screen = await render(ShareChoiceModal);
  await screen.getByRole("button", { name: "Just this document" }).click();
  expect(resolve).toHaveBeenCalledWith("document");
  expect(get(shareChoiceRequest)).toBeNull();
});

test("COLLAB-24: choosing 'Share whole workspace' resolves 'workspace'", async () => {
  const resolve = open();
  const screen = await render(ShareChoiceModal);
  await screen.getByRole("button", { name: /Share whole workspace/ }).click();
  expect(resolve).toHaveBeenCalledWith("workspace");
});

test("COLLAB-24: Cancel (and the × / backdrop) resolves 'cancel'", async () => {
  const resolve = open();
  const screen = await render(ShareChoiceModal);
  await screen.getByRole("button", { name: "Cancel" }).click();
  expect(resolve).toHaveBeenCalledWith("cancel");
});

test("COLLAB-24: the prompt names the doc count and workspace", async () => {
  open();
  const screen = await render(ShareChoiceModal);
  await expect.element(screen.getByText(/one of 4 in "Team."/)).toBeVisible();
});
