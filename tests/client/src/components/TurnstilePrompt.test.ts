import { test, expect, beforeEach } from "vitest";
import { render } from "vitest-browser-svelte";
import TurnstilePrompt from "../../../../client/src/components/TurnstilePrompt.svelte";
import { turnstilePromptOpen, turnstilePromptError } from "../../../../client/src/stores/turnstile";

beforeEach(() => {
  turnstilePromptOpen.set(false);
  turnstilePromptError.set(false);
});

test("renders nothing while closed", async () => {
  const screen = await render(TurnstilePrompt);
  expect(screen.container.querySelector("#turnstile-widget")).toBeNull();
});

test("open → shows the modal with the widget container", async () => {
  turnstilePromptOpen.set(true);
  const screen = await render(TurnstilePrompt);
  await expect.poll(() => screen.container.querySelector("#turnstile-widget")).not.toBeNull();
  expect(screen.container.textContent).toContain("human");
});

test("error state shows a Retry button", async () => {
  turnstilePromptOpen.set(true);
  turnstilePromptError.set(true);
  const screen = await render(TurnstilePrompt);
  await expect.element(screen.getByRole("button", { name: /retry/i })).toBeVisible();
});

test("Cancel closes the prompt and clears the error", async () => {
  turnstilePromptOpen.set(true);
  turnstilePromptError.set(true);
  const screen = await render(TurnstilePrompt);
  await screen.getByRole("button", { name: /cancel/i }).click();
  await expect.poll(() => screen.container.querySelector("#turnstile-widget")).toBeNull();
});
