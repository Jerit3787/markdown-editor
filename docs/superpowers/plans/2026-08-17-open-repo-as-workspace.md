# Open Existing Repo as New Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-step "open an existing GitHub repo as a new workspace" flow (File > Open > From GitHub Repo...), instead of today's create-workspace-then-link-then-pull sequence.

**Architecture:** Extract the repo list/paste/create-new UI already built for `RepoLinkModal` into a reusable `RepoPicker` component (an `onPick` callback prop, nothing else changes). A new `OpenRepoModal` reuses it with a different callback: a pure planner function decides whether to switch to an already-linked workspace or create a new one (name deduplicated against existing workspace names), then a thin orchestration function creates+links+pulls.

**Tech Stack:** TypeScript, Svelte 5, Vitest.

## Global Constraints

- Picking a repo that's already linked to an existing local workspace (same `owner`/`repo`/`branch`) switches to that workspace instead of creating a duplicate.
- A newly created workspace is named after the repo itself (e.g. repo `notes` → workspace `notes`), deduplicated with the same `nextAvailableName()` primitive used for document names.
- Picking a repo with no existing link creates the workspace, links it, and pulls immediately — the user lands on a workspace with content already showing, not an empty linked shell.
- `RepoLinkModal`'s existing behavior (linking the *active* workspace) must be unchanged for existing callers after the extraction in Task 1.

---

### Task 1: Extract RepoPicker from RepoLinkModal

**Files:**
- Create: `client/src/components/RepoPicker.svelte`
- Modify: `client/src/components/RepoLinkModal.svelte`

**Interfaces:**
- Produces:
  ```ts
  interface RepoPickerProps {
    open: boolean; // true while the wrapping modal is shown — triggers reset + repo-list reload
    pickLabel?: string; // default "Link"
    pickBusyLabel?: string; // default "Linking…"
    createLabel?: string; // default "Create & Link"
    onPick: (owner: string, repo: string, branch: string) => void | Promise<void>;
  }
  ```
  `RepoPicker.svelte` renders the owner/repo paste field, the create-new-repo form, and the "Your Repos" list — everything `RepoLinkModal.svelte` currently renders below its `quickAction` snippet. Calls `onPick` (awaiting it, so its own busy state reflects the caller's async work too) instead of doing the linking itself.

- [ ] **Step 1: Create RepoPicker.svelte**

Create `client/src/components/RepoPicker.svelte`:

```svelte
<script lang="ts">
  import { githubUsername } from "../stores/github";
  import { showToast } from "../stores/toast";

  interface Props {
    open: boolean;
    pickLabel?: string;
    pickBusyLabel?: string;
    createLabel?: string;
    onPick: (owner: string, repo: string, branch: string) => void | Promise<void>;
  }
  let { open, pickLabel = "Link", pickBusyLabel = "Linking…", createLabel = "Create & Link", onPick }: Props = $props();

  let repos = $state<any[]>([]);
  let listTitle = $state("");
  let listHint = $state("Sign in with GitHub to see your own repos here.");
  let manualInput = $state("");
  let newRepoName = $state("");
  let newRepoPrivate = $state(true);
  let busyKey = $state<string | null>(null);
  const CREATE_KEY = "__create__";
  const MANUAL_KEY = "__manual__";

  async function loadRepoList() {
    if (!$githubUsername) {
      listTitle = "Sign in required";
      listHint = "Sign in with GitHub to see your own repos here.";
      repos = [];
      return;
    }
    listTitle = "Loading…";
    listHint = "Loading your repos…";
    try {
      const res = await fetch("/api/repo/list");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      repos = await res.json();
      listTitle = repos.length === 0 ? "No repos" : "";
      listHint = repos.length === 0 ? "No repos found." : "";
    } catch {
      listTitle = "Error";
      listHint = "Couldn't load your repos.";
      repos = [];
    }
  }

  async function pick(fullName: string, defaultBranch: string, key: string) {
    busyKey = key;
    try {
      const [owner, repo] = fullName.split("/");
      await onPick(owner!, repo!, defaultBranch);
    } finally {
      busyKey = null;
    }
  }

  async function pickFromManualInput() {
    const trimmed = manualInput.trim().replace(/^https?:\/\/github\.com\//, "");
    const [owner, repo] = trimmed.split("/");
    if (!owner || !repo) {
      showToast("Enter a repo as owner/repo", "error");
      return;
    }
    busyKey = MANUAL_KEY;
    try {
      await onPick(owner, repo.replace(/\.git$/, ""), "main");
    } finally {
      busyKey = null;
    }
  }

  async function createAndPick() {
    const name = newRepoName.trim();
    if (!name) return;
    busyKey = CREATE_KEY;
    try {
      const res = await fetch("/api/repo/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, private: newRepoPrivate }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const [owner, repo] = data.full_name.split("/");
      await onPick(owner, repo, data.default_branch || "main");
    } catch {
      showToast("Couldn't create the repo", "error");
    } finally {
      busyKey = null;
    }
  }

  $effect(() => {
    if (open) {
      manualInput = "";
      newRepoName = "";
      void loadRepoList();
    }
  });
</script>

<label class="modal-field">
  <span>owner/repo</span>
  <div class="share-row">
    <input type="text" placeholder="owner/repo or a GitHub URL" aria-label="owner/repo" bind:value={manualInput} onkeydown={(e) => e.key === "Enter" && pickFromManualInput()} />
    <button class="secondary-btn" type="button" disabled={busyKey === MANUAL_KEY} onclick={pickFromManualInput}>{pickLabel}</button>
  </div>
</label>

<div class="menu-divider"></div>
<div class="menu-section-label">Create a new repo</div>
<div class="share-row">
  <input type="text" placeholder="Repo name" aria-label="New repo name" bind:value={newRepoName} onkeydown={(e) => e.key === "Enter" && createAndPick()} />
  <label><input type="checkbox" bind:checked={newRepoPrivate} /> Private</label>
  <button class="secondary-btn" type="button" disabled={busyKey === CREATE_KEY || !newRepoName.trim()} onclick={createAndPick}>
    {busyKey === CREATE_KEY ? "Creating…" : createLabel}
  </button>
</div>

<div class="menu-divider"></div>
<div class="menu-section-label">Your Repos</div>
{#if listHint}
  <div class="empty-state">
    <svg class="empty-state-icon"><use href="#icon-github"></use></svg>
    <div class="empty-state-title">{listTitle}</div>
    <div class="empty-state-desc">{listHint}</div>
    {#if !$githubUsername}
      <button type="button" class="primary-btn" onclick={() => window.MDE.openGithubSignInPopup()} style="margin-top: 8px;">
        <svg class="icon"><use href="#icon-github"></use></svg> Sign in with GitHub
      </button>
    {/if}
  </div>
{/if}
<div class="images-list">
  {#each repos as repo (repo.full_name)}
    <div class="gist-item">
      <div class="gist-meta">
        <div class="gist-name">{repo.full_name}</div>
        <div class="gist-date">{repo.private ? "Private" : "Public"}</div>
      </div>
      <button class="secondary-btn" type="button" disabled={busyKey === repo.full_name} onclick={() => pick(repo.full_name, repo.default_branch, repo.full_name)}>
        {busyKey === repo.full_name ? pickBusyLabel : pickLabel}
      </button>
    </div>
  {/each}
</div>
```

- [ ] **Step 2: Rewrite RepoLinkModal.svelte to use it**

Replace the full contents of `client/src/components/RepoLinkModal.svelte` with:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import RepoPicker from "./RepoPicker.svelte";
  import { repoLinkModalOpen } from "../stores/repoSync";
  import { activeWorkspaceIdStore, setWorkspaceRepoLink } from "../stores/workspaces";
  import { showToast } from "../stores/toast";

  function close() {
    repoLinkModalOpen.set(false);
  }

  function linkWorkspace(owner: string, repo: string, branch: string) {
    const workspaceId = $activeWorkspaceIdStore;
    if (!workspaceId) return;
    setWorkspaceRepoLink(workspaceId, { owner, repo, branch });
    close();
    showToast(`Linked to ${owner}/${repo}`, "success");
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $repoLinkModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $repoLinkModalOpen}
  <Modal title="Link Workspace to GitHub Repo" icon="icon-github" wide labelledBy="repoLinkModalTitle" onClose={close}>
    {#snippet quickAction()}
      <Toggletip>Every .md file in the repo's tree becomes a doc in this workspace. Pick an existing repo, paste one, or create a new one.</Toggletip>
    {/snippet}
    <RepoPicker open={$repoLinkModalOpen} onPick={linkWorkspace} />
  </Modal>
{/if}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 4: Manual verification (regression check)**

Run the dev server, open File > GitHub Repo > Link Workspace to Repo... — confirm it looks and behaves exactly as before (repo list loads when signed in, paste field works, create-new-repo form works). This is a pure refactor; nothing about this modal's behavior should have changed.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/RepoPicker.svelte client/src/components/RepoLinkModal.svelte
git commit -m "refactor: extract RepoPicker out of RepoLinkModal"
```

---

### Task 2: createWorkspaceFromRepo planner + orchestration

**Files:**
- Modify: `client/src/repo-sync.ts`
- Test: `client/src/repo-sync.test.ts`

**Interfaces:**
- Consumes: `Workspace` type (`./types` — not yet imported in this file, which currently only imports `Doc`), `nextAvailableName` (`./doc-naming`), `workspacesStore`/`createWorkspace`/`setWorkspaceRepoLink`/`switchWorkspace` (`./stores/workspaces`), `ensureActiveDocInWorkspace` (`./stores/docs`), `pullFromRepo` (already in this file).
- Produces:
  ```ts
  export type CreateFromRepoPlan =
    | { action: "switch"; workspaceId: string }
    | { action: "create"; workspaceName: string };
  export function planCreateWorkspaceFromRepo(owner: string, repo: string, branch: string, workspaces: Workspace[]): CreateFromRepoPlan;
  export async function createWorkspaceFromRepo(owner: string, repo: string, branch: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

Add to `client/src/repo-sync.test.ts` (append; the file already has the `// @vitest-environment jsdom` pragma at the top from earlier tasks, so no new setup is needed):

```typescript
import { planCreateWorkspaceFromRepo } from "./repo-sync";
import type { Workspace } from "./types";

describe("planCreateWorkspaceFromRepo", () => {
  it("plans to switch to an existing workspace already linked to the same owner/repo/branch", () => {
    const workspaces: Workspace[] = [{ id: "w1", name: "notes", createdAt: 0, repoLink: { owner: "octocat", repo: "notes", branch: "main" } }];
    const plan = planCreateWorkspaceFromRepo("octocat", "notes", "main", workspaces);
    expect(plan).toEqual({ action: "switch", workspaceId: "w1" });
  });

  it("does not match a workspace linked to a different branch", () => {
    const workspaces: Workspace[] = [{ id: "w1", name: "notes", createdAt: 0, repoLink: { owner: "octocat", repo: "notes", branch: "dev" } }];
    const plan = planCreateWorkspaceFromRepo("octocat", "notes", "main", workspaces);
    expect(plan).toEqual({ action: "create", workspaceName: "notes" });
  });

  it("plans to create a new workspace named after the repo when nothing matches", () => {
    const plan = planCreateWorkspaceFromRepo("octocat", "notes", "main", []);
    expect(plan).toEqual({ action: "create", workspaceName: "notes" });
  });

  it("dedupes the new workspace name against existing workspace names", () => {
    const workspaces: Workspace[] = [{ id: "w1", name: "notes", createdAt: 0 }];
    const plan = planCreateWorkspaceFromRepo("octocat", "notes", "main", workspaces);
    expect(plan).toEqual({ action: "create", workspaceName: "notes-2" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: FAIL — `planCreateWorkspaceFromRepo` doesn't exist yet.

- [ ] **Step 3: Write minimal implementation**

In `client/src/repo-sync.ts`, change the type import at the top from:

```typescript
import type { Doc } from "./types";
```

to:

```typescript
import type { Doc, Workspace } from "./types";
```

Add near the other imports:

```typescript
import { get } from "svelte/store";
import { nextAvailableName } from "./doc-naming";
import { workspacesStore, createWorkspace, setWorkspaceRepoLink, switchWorkspace } from "./stores/workspaces";
import { ensureActiveDocInWorkspace } from "./stores/docs";
```

Add at the end of the file:

```typescript
export type CreateFromRepoPlan = { action: "switch"; workspaceId: string } | { action: "create"; workspaceName: string };

// Pure — no store reads, takes the workspace list as a parameter — so
// this is directly unit-testable without touching real store state.
// Two local workspaces both pointed at the same remote repo would fight
// each other on push/pull (each tracking its own, inconsistent repoSha
// per doc), so an exact owner/repo/branch match always wins over
// creating a new one.
export function planCreateWorkspaceFromRepo(owner: string, repo: string, branch: string, workspaces: Workspace[]): CreateFromRepoPlan {
  const existing = workspaces.find((w) => w.repoLink?.owner === owner && w.repoLink?.repo === repo && w.repoLink?.branch === branch);
  if (existing) return { action: "switch", workspaceId: existing.id };
  const taken = new Set(workspaces.map((w) => w.name));
  return { action: "create", workspaceName: nextAvailableName(repo, taken) };
}

export async function createWorkspaceFromRepo(owner: string, repo: string, branch: string): Promise<void> {
  const plan = planCreateWorkspaceFromRepo(owner, repo, branch, get(workspacesStore));
  if (plan.action === "switch") {
    if (switchWorkspace(plan.workspaceId)) ensureActiveDocInWorkspace(plan.workspaceId);
    return;
  }
  // createWorkspace() already switches activeWorkspaceIdStore to the new
  // workspace — but the active *document* still points at whatever was
  // open in the previous workspace until ensureActiveDocInWorkspace runs
  // below, once the workspace actually has documents to land on.
  const ws = createWorkspace(plan.workspaceName);
  setWorkspaceRepoLink(ws.id, { owner, repo, branch });
  await pullFromRepo(ws.id, { owner, repo, branch }, new Set());
  ensureActiveDocInWorkspace(ws.id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run client/src/repo-sync.test.ts`
Expected: PASS (all tests including the 4 new ones)

- [ ] **Step 5: Typecheck and full suite**

Run: `npx tsc --noEmit -p client/tsconfig.json && npm test`
Expected: clean, all pass.

- [ ] **Step 6: Commit**

```bash
git add client/src/repo-sync.ts client/src/repo-sync.test.ts
git commit -m "feat: add createWorkspaceFromRepo planner and orchestration"
```

---

### Task 3: OpenRepoModal component

**Files:**
- Modify: `client/src/stores/repoSync.ts`
- Create: `client/src/components/OpenRepoModal.svelte`
- Modify: `client/index.html`, `client/src/main.ts`

**Interfaces:**
- Consumes: `createWorkspaceFromRepo` (Task 2), `RepoPicker` (Task 1).
- Produces: `openRepoModalOpen: Writable<boolean>` in `stores/repoSync.ts`.

- [ ] **Step 1: Add the store**

Add to `client/src/stores/repoSync.ts` (near `repoLinkModalOpen`):

```typescript
export const openRepoModalOpen = writable(false);
```

- [ ] **Step 2: Create the component**

Create `client/src/components/OpenRepoModal.svelte`:

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import Modal from "./Modal.svelte";
  import Toggletip from "./Toggletip.svelte";
  import RepoPicker from "./RepoPicker.svelte";
  import { openRepoModalOpen } from "../stores/repoSync";
  import { createWorkspaceFromRepo } from "../repo-sync";
  import { showToast } from "../stores/toast";

  function close() {
    openRepoModalOpen.set(false);
  }

  async function pickRepo(owner: string, repo: string, branch: string) {
    try {
      await createWorkspaceFromRepo(owner, repo, branch);
      close();
      showToast(`Opened ${owner}/${repo}`, "success");
    } catch (err: any) {
      showToast(err.message || "Couldn't open that repo", "error");
    }
  }

  onMount(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && $openRepoModalOpen) close();
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  });
</script>

{#if $openRepoModalOpen}
  <Modal title="Open GitHub Repo as Workspace" icon="icon-github" wide labelledBy="openRepoModalTitle" onClose={close}>
    {#snippet quickAction()}
      <Toggletip>Creates a new workspace, links it to the repo you pick, and pulls every .md file in right away. Already have a workspace linked to that repo? Switches to it instead of making a duplicate.</Toggletip>
    {/snippet}
    <RepoPicker open={$openRepoModalOpen} pickLabel="Open" pickBusyLabel="Opening…" createLabel="Create & Open" onPick={pickRepo} />
  </Modal>
{/if}
```

- [ ] **Step 3: Add the mount point**

In `client/index.html`, add after the `repo-conflict-modal-mount` div:

```html
<!-- Open GitHub Repo as Workspace — Svelte component, mounted in
     main.ts; see client/src/components/OpenRepoModal.svelte -->
<div id="open-repo-modal-mount"></div>
```

In `client/src/main.ts`, add the import next to `RepoConflictModal`'s:

```typescript
import OpenRepoModal from "./components/OpenRepoModal.svelte";
```

and the mount call next to `RepoConflictModal`'s:

```typescript
mount(OpenRepoModal, { target: document.getElementById("open-repo-modal-mount")! });
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/stores/repoSync.ts client/src/components/OpenRepoModal.svelte client/index.html client/src/main.ts
git commit -m "feat: add OpenRepoModal component"
```

---

### Task 4: Wire the File > Open menu entry

**Files:**
- Modify: `client/src/types.ts` (MDEBridge), `client/src/repo-sync-ui.ts`, `client/src/components/MenuBar.svelte`

**Interfaces:**
- Consumes: `openRepoModalOpen` (Task 3), `requireRepoScope` (already in `repo-sync-ui.ts`).
- Produces: `MDEBridge` gains `openRepoModal?(): void;`

- [ ] **Step 1: Add the MDEBridge method**

In `client/src/types.ts`, add to the `MDEBridge` interface, next to `openRepoLinkModal?`:

```typescript
  openRepoModal?(): void;
```

- [ ] **Step 2: Wire it in repo-sync-ui.ts**

In `client/src/repo-sync-ui.ts`, change the import from `./stores/repoSync`:

```typescript
import { repoLinkModalOpen, repoConflictModalOpen, repoConflictState, repoSyncBusyLabel } from "./stores/repoSync";
```

to:

```typescript
import { repoLinkModalOpen, openRepoModalOpen, repoConflictModalOpen, repoConflictState, repoSyncBusyLabel } from "./stores/repoSync";
```

Add next to the existing `window.MDE.openRepoLinkModal` assignment:

```typescript
window.MDE.openRepoModal = () => {
  void (async () => {
    if (!(await requireRepoScope())) return;
    openRepoModalOpen.set(true);
  })();
};
```

- [ ] **Step 3: Add the File > Open menu entry**

In `client/src/components/MenuBar.svelte`, find the `Open` submenu panel:

```svelte
        <div class="menu-submenu-panel">
          <button id="menuOpenLocal" type="button" onclick={() => act(() => window.MDE.openLocalFile())}>
            <svg class="icon"><use href="#icon-upload"></use></svg> From this device
          </button>
          <input id="importInput" type="file" accept=".md,.markdown,.txt" hidden>
          <div class="menu-divider"></div>
          <button id="menuOpenGist" type="button" onclick={() => act(() => window.MDE.openGistPicker?.())}>
            <svg class="icon"><use href="#icon-github"></use></svg> From GitHub Gist...
          </button>
        </div>
```

Add a new button right after the Gist one:

```svelte
        <div class="menu-submenu-panel">
          <button id="menuOpenLocal" type="button" onclick={() => act(() => window.MDE.openLocalFile())}>
            <svg class="icon"><use href="#icon-upload"></use></svg> From this device
          </button>
          <input id="importInput" type="file" accept=".md,.markdown,.txt" hidden>
          <div class="menu-divider"></div>
          <button id="menuOpenGist" type="button" onclick={() => act(() => window.MDE.openGistPicker?.())}>
            <svg class="icon"><use href="#icon-github"></use></svg> From GitHub Gist...
          </button>
          <button id="menuOpenRepo" type="button" onclick={() => act(() => window.MDE.openRepoModal?.())}>
            <svg class="icon"><use href="#icon-github"></use></svg> From GitHub Repo...
          </button>
        </div>
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p client/tsconfig.json`
Expected: clean.

- [ ] **Step 5: Manual verification**

Run the dev server, open File > Open — confirm "From GitHub Repo..." appears below "From GitHub Gist...". Click it — confirm `OpenRepoModal` opens (with no GitHub session, this should show the "Sign in required" scope-check prompt, same as every other repo-sync action gated by `requireRepoScope()`).

- [ ] **Step 6: Commit**

```bash
git add client/src/types.ts client/src/repo-sync-ui.ts client/src/components/MenuBar.svelte
git commit -m "feat: wire File > Open > From GitHub Repo..."
```

---

## Final Verification

After all tasks complete:

```bash
npm test
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p client/tsconfig.json
npm run build
```

Expected: all tests pass, both typechecks clean, build succeeds.
