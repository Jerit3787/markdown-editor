import { test, expect, beforeEach, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import Settings from "../../../../client/src/components/Settings.svelte";
import { settingsModalOpen } from "../../../../client/src/stores/settingsModal";

beforeEach(() => {
  settingsModalOpen.set(false);
  window.MDE = new Proxy({}, { get: () => vi.fn() }) as unknown as typeof window.MDE;
  localStorage.clear();
});

test("the modal is closed until settingsModalOpen goes true, and closes again when it goes false", async () => {
  const screen = await render(Settings);
  expect(screen.container.textContent).not.toContain("Appearance");

  settingsModalOpen.set(true);
  await expect.poll(() => screen.container.textContent).toContain("Appearance");

  settingsModalOpen.set(false);
  await expect.poll(() => screen.container.textContent?.includes("Appearance")).toBe(false);
});

test("closing the modal (× / onClose) sets settingsModalOpen false", async () => {
  settingsModalOpen.set(true);
  const screen = await render(Settings);
  await expect.poll(() => screen.container.textContent).toContain("Appearance");
  await screen.getByRole("button", { name: /close/i }).click();
  await expect.poll(() => screen.container.textContent?.includes("Appearance")).toBe(false);
});

test("v1.57: no Analytics row when analytics is unavailable", async () => {
  settingsModalOpen.set(true);
  const screen = await render(Settings);
  await expect.poll(() => screen.container.textContent).toContain("Appearance");
  expect(screen.container.textContent).not.toContain("Analytics");
});

test("DRIVE-1: Google Drive row toggles Connect/Disconnect; hidden when unconfigured + disconnected", async () => {
  const { driveConnected, driveConfigured } = await import("../../../../client/src/stores/driveSync");
  settingsModalOpen.set(true);

  driveConnected.set(false);
  driveConfigured.set(false);
  const screen = await render(Settings);
  await expect.poll(() => screen.container.textContent).toContain("Appearance");
  expect(screen.container.textContent).not.toContain("Google Drive");

  driveConfigured.set(true);
  await expect.poll(() => screen.container.textContent).toContain("Google Drive");
  await expect.element(screen.getByRole("button", { name: "Connect" })).toBeVisible();

  driveConnected.set(true);
  await expect.element(screen.getByRole("button", { name: "Disconnect" })).toBeVisible();

  driveConnected.set(false);
  driveConfigured.set(true);
});
