import { test, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import { render } from "vitest-browser-svelte";
import RepoConflictModal from "../../../../client/src/components/RepoConflictModal.svelte";
import { repoConflictModalOpen, repoConflictState } from "../../../../client/src/stores/repoSync";

beforeEach(() => {
  repoConflictModalOpen.set(false);
  repoConflictState.set(null);
});

function openConflicts(onResolve = vi.fn(async () => {})) {
  repoConflictState.set({
    kind: "pull",
    conflicts: [
      { docId: "d1", docName: "Notes", repoPath: "notes.md", localContent: "x", remoteSha: "s1" },
      { docId: "d2", docName: "Plan", repoPath: "plan.md", localContent: "y", remoteSha: "s2" },
    ],
    deletions: [{ docId: "d3", docName: "Old", repoPath: "old.md" }],
    onResolve,
  } as unknown as Parameters<typeof repoConflictState.set>[0]);
  repoConflictModalOpen.set(true);
  return onResolve;
}

test("REPO-20: renders a per-file resolution select, defaulting every conflict to 'mine'", async () => {
  openConflicts();
  const screen = await render(RepoConflictModal);
  const selects = screen.container.querySelectorAll("select");
  expect(selects).toHaveLength(2);
  expect([...selects].every((s) => (s as HTMLSelectElement).value === "mine")).toBe(true);
  await expect.element(screen.getByText("old.md")).toBeVisible(); // the deletion section
});

test("REPO-20: Apply calls onResolve with the chosen side per file (never a silent overwrite)", async () => {
  const onResolve = openConflicts();
  const screen = await render(RepoConflictModal);

  await screen.getByLabelText("Resolution for Plan").selectOptions("theirs");
  await screen.getByRole("button", { name: "Apply" }).click();

  expect(onResolve).toHaveBeenCalledWith({ d1: "mine", d2: "theirs" });
  await expect.poll(() => get(repoConflictModalOpen)).toBe(false);
});

test("REPO-20: Cancel closes without resolving", async () => {
  const onResolve = openConflicts();
  const screen = await render(RepoConflictModal);
  await screen.getByRole("button", { name: "Cancel" }).click();
  expect(onResolve).not.toHaveBeenCalled();
  expect(get(repoConflictState)).toBeNull();
});
