import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";

import ImagePickerModal from "../../../../client/src/components/ImagePickerModal.svelte";
import { imagesModalOpen } from "../../../../client/src/stores/imagesModal";
import { docsStore, activeIdStore } from "../../../../client/src/stores/docs";
import { activeWorkspaceIdStore, workspacesStore } from "../../../../client/src/stores/workspaces";

const SMALL = "data:image/png;base64,AAAA";

let dispatched: string[];
let insertImageWithUpload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  dispatched = [];
  insertImageWithUpload = vi.fn();
  window.MDE = {
    getEditor: () => ({
      state: { selection: { main: { head: 0 } }, doc: { toString: () => "" } },
      dispatch: (tr: { changes: { insert: string } }) => dispatched.push(tr.changes.insert),
      focus: vi.fn(),
    }),
    insertImageWithUpload,
    setDocImage: vi.fn(),
    updatePreview: vi.fn(),
  } as unknown as typeof window.MDE;
  workspacesStore.set([{ id: "w1", name: "WS", createdAt: 0, updatedAt: 0 }]);
  activeWorkspaceIdStore.set("w1");
  docsStore.set([{ id: "d1", name: "Doc", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", images: {} }]);
  activeIdStore.set("d1");
  imagesModalOpen.set(true);
});

test("opens on the Upload tab when the document has no images", async () => {
  const screen = await render(ImagePickerModal);
  await expect.element(screen.getByText("Drop images here, or click to choose")).toBeVisible();
});

test("opens on the Existing tab when the document already has images", async () => {
  docsStore.set([{ id: "d1", name: "Doc", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", images: { "a.png": SMALL } }]);
  const screen = await render(ImagePickerModal);
  await expect.poll(() => screen.container.querySelectorAll(".image-picker-item").length).toBe(1);
});

test("clicking an existing thumbnail inserts ![stem](key) and closes", async () => {
  docsStore.set([{ id: "d1", name: "Doc", content: "", updatedAt: 0, createdAt: 0, workspaceId: "w1", images: { "a.png": SMALL } }]);
  const screen = await render(ImagePickerModal);
  await expect.poll(() => screen.container.querySelectorAll(".image-picker-item").length).toBe(1);
  (screen.container.querySelector(".image-picker-item") as HTMLElement).click();
  expect(dispatched).toEqual(["![a](a.png)"]);
  expect(get(imagesModalOpen)).toBe(false);
});

test("the Existing empty state links back to the Upload tab", async () => {
  const screen = await render(ImagePickerModal);
  await screen.getByRole("tab", { name: /Existing/ }).click();
  await screen.getByRole("button", { name: "Add one from the Upload tab" }).click();
  await expect.element(screen.getByText("Drop images here, or click to choose")).toBeVisible();
});

test("picking two image files calls insertImageWithUpload twice and closes", async () => {
  const screen = await render(ImagePickerModal);
  const input = screen.container.querySelector('input[type="file"]') as HTMLInputElement;
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([1])], "one.png", { type: "image/png" }));
  dt.items.add(new File([new Uint8Array([2])], "two.png", { type: "image/png" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.poll(() => insertImageWithUpload.mock.calls.length).toBe(2);
  expect(get(imagesModalOpen)).toBe(false);
});

test("an oversized file keeps the modal open and shows the inline alert", async () => {
  insertImageWithUpload.mockImplementation((_f: File, _p: unknown, onError: (m: string) => void) => onError("big.png is over the 2 MB limit"));
  const screen = await render(ImagePickerModal);
  const input = screen.container.querySelector('input[type="file"]') as HTMLInputElement;
  const dt = new DataTransfer();
  dt.items.add(new File([new Uint8Array([1])], "big.png", { type: "image/png" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("big.png is over the 2 MB limit");
  expect(get(imagesModalOpen)).toBe(true);
});

test("a non-image file is rejected inline and never reaches insertImageWithUpload", async () => {
  const screen = await render(ImagePickerModal);
  const input = screen.container.querySelector('input[type="file"]') as HTMLInputElement;
  const dt = new DataTransfer();
  dt.items.add(new File(["x"], "notes.txt", { type: "text/plain" }));
  input.files = dt.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("notes.txt isn't an image");
  expect(insertImageWithUpload).not.toHaveBeenCalled();
});
