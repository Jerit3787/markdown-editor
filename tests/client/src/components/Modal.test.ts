import { test, expect, vi } from "vitest";
import { render } from "vitest-browser-svelte";
import { createRawSnippet } from "svelte";
import Modal from "../../../../client/src/components/Modal.svelte";

// SHELL-04 — the shared modal shell. Note: focus-trap / Esc-to-close /
// body-scroll-lock are each consumer's own onMount concern (e.g.
// ImagePickerModal / VersionHistory add their own keydown listener), not
// Modal.svelte's — so this covers the structure + the close affordances
// Modal itself owns.

const body = () => createRawSnippet(() => ({ render: () => `<p class="probe-body">content here</p>` }));

test("renders the header (title + icon), an aria-modal dialog, and the body snippet", async () => {
  const screen = await render(Modal, { title: "My Dialog", icon: "icon-x", labelledBy: "t1", onClose: vi.fn(), children: body() });
  const dialog = screen.container.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.getAttribute("aria-labelledby")).toBe("t1");
  expect(screen.container.querySelector("#t1")?.textContent).toContain("My Dialog");
  expect(screen.container.querySelector(".probe-body")).not.toBeNull();
});

test("the × button calls onClose", async () => {
  const onClose = vi.fn();
  const screen = await render(Modal, { title: "X", labelledBy: "t", onClose, children: body() });
  await screen.getByRole("button", { name: "Close" }).click();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a backdrop click closes, a click inside the box does not", async () => {
  const onClose = vi.fn();
  const screen = await render(Modal, { title: "X", labelledBy: "t", onClose, children: body() });

  (screen.container.querySelector(".probe-body") as HTMLElement).click();
  expect(onClose).not.toHaveBeenCalled();

  (screen.container.querySelector(".modal-backdrop") as HTMLElement).click();
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("elevated bumps the backdrop above non-elevated modals", async () => {
  const screen = await render(Modal, { title: "X", labelledBy: "t", elevated: true, onClose: vi.fn(), children: body() });
  expect(screen.container.querySelector(".modal-backdrop.elevated")).not.toBeNull();
});

test("footer + tabs snippets render in their own regions when provided", async () => {
  const screen = await render(Modal, {
    title: "X",
    labelledBy: "t",
    onClose: vi.fn(),
    children: body(),
    tabs: createRawSnippet(() => ({ render: () => `<button class="probe-tab">Tab A</button>` })),
    footer: createRawSnippet(() => ({ render: () => `<button class="probe-foot">Done</button>` })),
  });
  expect(screen.container.querySelector('.modal-tabs[role="tablist"] .probe-tab')).not.toBeNull();
  expect(screen.container.querySelector(".modal-footer .probe-foot")).not.toBeNull();
});
