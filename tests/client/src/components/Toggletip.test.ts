// Smoke test for the browser-mode Svelte component test harness itself
// (vitest-browser-svelte + the Playwright provider, real Chromium — see
// vitest.config.ts's "components" project) — Toggletip.svelte is a good
// target: small, self-contained, no store/bridge dependencies, and its
// open/close/Escape behavior is easy to verify unambiguously.
import { render } from "vitest-browser-svelte";
import { expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import Toggletip from "../../../../client/src/components/Toggletip.svelte";
import { createRawSnippet } from "svelte";

function hintSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
  }));
}

test("the bubble is hidden until the toggle button is clicked", async () => {
  const screen = await render(Toggletip, { children: hintSnippet("Helpful hint") });

  await expect.element(screen.getByRole("tooltip")).not.toBeInTheDocument();

  await screen.getByRole("button", { name: "What is this?" }).click();
  await expect.element(screen.getByRole("tooltip")).toBeVisible();
  await expect.element(screen.getByText("Helpful hint")).toBeVisible();
});

test("Escape closes an open bubble", async () => {
  const screen = await render(Toggletip, { children: hintSnippet("Helpful hint") });

  await screen.getByRole("button", { name: "What is this?" }).click();
  await expect.element(screen.getByRole("tooltip")).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("tooltip")).not.toBeInTheDocument();
});
