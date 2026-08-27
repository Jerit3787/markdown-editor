import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export interface InvitedPerson {
  username: string;
  role: string;
}

export interface AccessRecord {
  owner: string | null;
  generalAccess: "restricted" | "anyone";
  // Only meaningful when generalAccess is "anyone" — false (default)
  // means a fully public link, no account needed; true means any signed
  // -in GitHub account works without being individually invited.
  requireAccount: boolean;
  role: string;
  invited: InvitedPerson[];
}

export interface PresenceEntry {
  name: string;
  color: string;
  username?: string;
  role?: string;
}

export interface Note {
  id: string;
  from: number;
  to: number;
  quote: string;
  orphaned: boolean;
  body: string;
  createdAt: number;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  // Backfilled from createdAt for any workspace that predates this field
  // (see stores/workspaces.ts's loadWorkspacesFromStorage) — always
  // present on every workspace in workspacesStore after load. Bumped on
  // every mutation so persistWorkspaces() can merge across tabs by
  // recency instead of blindly overwriting localStorage.
  updatedAt: number;
  // Set once this workspace has ever been shared or joined from a share
  // link — mirrors the same "try to reconnect on load" role Doc.shared
  // plays for local documents, just at workspace scope.
  shared?: boolean;
  // The WorkspaceRoom Durable Object's name, once shared/joined.
  // Deliberately separate from `id`: a workspace joined via "merge into an
  // existing workspace" keeps its own local id/name but still needs to
  // know which remote room to connect to.
  remoteId?: string;
  // Set once this workspace has been linked to a GitHub repo — see
  // client/src/repo-sync.ts. Independent of `shared`/`remoteId`: a
  // workspace can be live-shared, repo-linked, both, or neither.
  repoLink?: {
    owner: string;
    repo: string;
    branch: string;
  };
  // Set after any successful push or pull (whichever happens last) —
  // one combined "last synced" timestamp, not separate push/pull ones.
  // Meaningless without repoLink, so clearWorkspaceRepoLink clears this
  // too.
  repoLastSyncedAt?: number;
  // Repo paths whose local doc was deleted while this workspace stayed
  // linked — queued by stores/docs.ts's removeDocById (the doc itself is
  // gone by the time a push runs and can no longer be asked "what was
  // your repoPath"), consumed by repo-sync.ts's planPush to propagate the
  // deletion to the repo on the next push. Deliberately NOT "any repo
  // path with no matching doc": that would also catch repo content never
  // pulled in yet (e.g. linking to a repo with pre-existing files) and
  // delete it before it ever reached the user.
  pendingRepoDeletions?: string[];
}

export interface Doc {
  id: string;
  name: string;
  content: string;
  updatedAt: number;
  // Backfilled from updatedAt for any document that predates this
  // field (see stores/docs.ts's loadDocsFromStorage normalization
  // pass) — always present on every doc in docsStore after load.
  createdAt: number;
  // Which Workspace (see stores/workspaces.ts) this document belongs
  // to — every doc has exactly one. Backfilled for pre-workspace docs
  // by docs.ts's normalizeLoadedDocs, same pattern as the createdAt
  // backfill above.
  workspaceId: string;
  images?: Record<string, string>;
  diagrams?: Record<string, string>;
  gistId?: string;
  // The filename actually used inside the gist as of the last publish
  // — GitHub's Gist PATCH API creates a *new* file whenever the
  // files{} key doesn't exactly match an existing filename, so this
  // has to be tracked and reused (or explicitly renamed via the old
  // -key-with-a-new-filename-property PATCH form) rather than
  // recomputed fresh from doc.name on every update; otherwise
  // renaming the document after the first publish left the gist with
  // two files instead of one renamed one.
  gistFilename?: string;
  // Path within the linked workspace's repo (e.g. "docs/notes.md"),
  // once this doc has been pulled from or pushed to it at least once.
  // Parallel to gistId/gistFilename above.
  repoPath?: string;
  // The blob SHA this doc's content was last synced at — repo-sync's
  // conflict-detection signal: a mismatch against the repo's current
  // tree means something else changed the file since last sync.
  repoSha?: string;
  // Same idea as repoSha, but per embedded image/diagram ref (see
  // doc.images/doc.diagrams) — each pushed image is its own blob with
  // its own SHA to track.
  repoImageShas?: Record<string, string>;
  // Legacy-only: set on documents shared before workspace-level sharing
  // shipped, under the old one-room-per-document model. New code never
  // sets this — a document's shared state now lives on its containing
  // Workspace (see Workspace.shared) — this flag exists only so
  // collab.ts's migration trigger knows to migrate an old document to its
  // own WorkspaceRoom the next time it's opened, then clears it.
  shared?: boolean;
  // Local, single-author annotations anchored to text — only meaningful
  // for a document that has never been shared (see comments.ts's own
  // comment for why shared documents' threads live server-side instead).
  notes?: Note[];
}

// The cross-module contract app.ts publishes on window.MDE — collab.ts and
// gist.ts run as separate modules with no access to app.ts's closure, so
// this is how they drive doc switching/creation and reach the CodeMirror
// instance instead of touching internals directly.
export interface MDEBridge {
  getEditor(): EditorView;
  // Editor.svelte owns the EditorView's construction/mount/destroy
  // lifecycle and, as of Phase A and Phase B of the app.ts migration, the
  // readOnly/editing-mode/focus-mode/keybindings compartments, their base
  // theme/highlighting extensions, and the image/comment marker fields,
  // slash-command and wikilink-autocomplete fields, and paste/drop
  // handling. This asks app.ts for whatever it still owns (Phase C/D
  // territory — formatting keymaps, markdown language, the save/preview
  // updateListener) to splice into the final list.
  getEditorExtensions(): Extension[];
  registerEditor(view: EditorView): void;
  // Doc CRUD/state reads (getActiveDoc, findDocById, createDoc, deleteDoc,
  // duplicateDoc, markActiveDocShared, setActiveDocGistId) live in
  // ./stores/docs now — collab.ts/gist.ts/DocList.svelte/MenuBar.svelte
  // import them directly instead of going through the bridge, since none
  // of it needs DOM/CodeMirror access. switchDoc/jumpToLine/setDocImage
  // stay here: each needs something only app.ts's closure has (the
  // mobile-sidebar DOM state, the live CodeMirror instance, or a preview
  // refresh).
  switchDoc(id: string): void;
  jumpToLine(id: string, line: number): void;
  refreshSaveStatus(): void;
  getResolvedContent(): string;
  setDocImage(key: string, dataUrl: string): void;
  onImageAdded: ((key: string, dataUrl: string) => void) | null;
  // Same shape as setDocImage/onImageAdded, for the document's name: a
  // collaborator renaming a shared document (collab.ts's metaMap) calls
  // setDocName to update the docTitle input/page title/store for
  // whichever doc that is; the local user renaming via the docTitle
  // input calls onDocRenamed so collab.ts can push that name to the
  // shared workspace's Y.Doc if the document is currently shared.
  setDocName(id: string, name: string): void;
  onDocRenamed: ((id: string, name: string) => void) | null;
  toggleDropdown(btn: HTMLElement, menu: HTMLElement): void;
  closeAllDropdowns(): void;
  requireGithubSignIn(hint?: string): void;
  openGithubSignInPopup(): void;
  githubUsername: string | null;
  githubSessionReady?: Promise<unknown>;
  onBeforeDocLoad: (() => void) | null;
  onActiveDocChanged: ((doc: Doc) => void) | null;
  onGithubAuthComplete?: () => void;

  // ---- Menu bar (MenuBar.svelte) — everything below drives File/Edit/
  // View/Help actions and dropdown/submenu mechanics from the component,
  // since it has no access to app.ts's closure. Dynamic content (recent
  // docs, gist publish status, view mode) is store-driven instead —
  // see stores/view.ts and stores/gist.ts.
  enableMenuBarHoverSwitch(pairs: { btn: HTMLElement; menu: HTMLElement }[]): void;
  initSubmenus(root: HTMLElement): void;
  closeSubmenus(root: HTMLElement): void;
  // Optional (assigned by Editor.svelte's onMount, not app.ts's own
  // bridge literal) — same pattern as publishGist?/openGistPicker?
  // below: app.ts's bridge object is typed/assigned before Editor.svelte
  // mounts, so these can't be required there. Reconfigures the editor's
  // readOnly facet and its editing-mode/undo stack — collab.ts drives
  // setReadOnly/enterCollabMode/exitCollabMode when a room is
  // joined/left/its role changes.
  undo?(): void;
  redo?(): void;
  setReadOnly?(readOnly: boolean): void;
  enterCollabMode?(extensions: Extension, undoManager: { undo(): void; redo(): void }): void;
  exitCollabMode?(): void;
  // Assigned by Editor.svelte's onMount, same reasoning as the five
  // methods above — Phase B of the editor-core migration moved the
  // image-marker field and upload logic there. app.ts's
  // initImageUploads() (the #imageFileInput file-picker path) is the
  // only caller.
  insertImageWithUpload?(file: File, pos?: number): void;
  // Assigned by Editor.svelte's onMount, same reasoning — Phase B moved
  // commentMarkerField there. CommentsPanel.svelte is the only caller.
  setCommentMarkers?(entries: { id: string; from: number; to: number }[]): void;
  // Assigned by Preview.svelte's onMount, same reasoning — Phase C
  // moved the render pipeline there. Callers: app.ts's updateListener,
  // its activeIdStore.subscribe, and its bridge's own setDocImage
  // wrapper.
  updatePreview?(): void;
  // Re-runs the full render pipeline — used by DiagramEditor.svelte
  // after editing an existing diagram (doc.diagrams[ref] changes
  // without the document text itself changing, so the normal
  // doc-changed-triggered path never fires on its own).
  refreshPreview?(): void;
  // Assigned by Preview.svelte's onMount. Called from app.ts's
  // updateListener on every docChanged/selectionSet.
  followCursorInPreview?(): void;
  // Assigned by Preview.svelte's onMount. Awaited by app.ts's
  // exportAs() before reading #preview's rendered DOM for txt/html/pdf
  // export, so an in-flight diagram/math render has landed first.
  flushPreviewRenders?(): Promise<void>;
  cutSelection(): void;
  copySelection(): void;
  pasteClipboard(): void;
  newDoc(): void;
  openLocalFile(): void;
  exportAs(format: string): Promise<void>;
  toggleSidebar(): void;
  collapseSidebarForMobile(): void;
  openImagesManager(): void;
  openShortcuts(): void;
  openAbout(): void;
  openDiagramEditor(): void;
  formatRelativeTime(ts: number): string;
  // Set by gist.ts at module load, same pattern as onGithubAuthComplete —
  // optional because app.ts's own bridge literal (where every other
  // method above lives) is typed/assigned before gist.ts's module code runs.
  publishGist?(): void;
  openGistPicker?(): void;
  // Set by repo-sync-ui.ts at module load, same pattern as the two above.
  openRepoLinkModal?(): void;
  openRepoModal?(): void;
  pushToRepoAction?(): void;
  pullFromRepoAction?(): void;
  unlinkRepo?(): void;
  // Set by formatting-commands.ts at module load, same pattern as
  // publishGist? above. MenuBar.svelte/CommandPalette.svelte/
  // SlashMenu.svelte call runCmd; DiagramEditor.svelte calls
  // insertAtCursor after creating a new diagram; LinkModal.svelte calls
  // insertLinkIntoEditor.
  runCmd?(cmd: string): void;
  insertAtCursor?(text: string): void;
  insertLinkIntoEditor?(text: string, url: string): void;
}

declare global {
  interface Window {
    MDE: MDEBridge;
  }
}
