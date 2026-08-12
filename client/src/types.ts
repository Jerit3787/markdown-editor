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

export interface Doc {
  id: string;
  name: string;
  content: string;
  updatedAt: number;
  images?: Record<string, string>;
  diagrams?: Record<string, string>;
  gistId?: string;
  // Set once a doc has ever been shared — its own id doubles as its collab
  // room id (see collab.ts), so this is just a local "try to rejoin on
  // load" flag, not the room id itself.
  shared?: boolean;
}

// The cross-module contract app.ts publishes on window.MDE — collab.ts and
// gist.ts run as separate modules with no access to app.ts's closure, so
// this is how they drive doc switching/creation and reach the CodeMirror
// instance instead of touching internals directly.
export interface MDEBridge {
  getEditor(): EditorView;
  // Editor.svelte's construction handoff: it builds the actual EditorView
  // (DOM host + mount/destroy lifecycle are its job), but the extension
  // list is almost entirely app.ts's own callbacks/state, so it asks for
  // that here and hands the resulting view back via registerEditor.
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
  refreshPreview(): void;
  getResolvedContent(): string;
  setDocImage(key: string, dataUrl: string): void;
  onImageAdded: ((key: string, dataUrl: string) => void) | null;
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
  undo(): void;
  redo(): void;
  // Reconfigures the editor's readOnly facet and its editing-mode/undo
  // stack — collab.ts drives both when a room is joined/left/its role
  // changes (see app.ts's editingModeCompartment/readOnlyCompartment).
  setReadOnly(readOnly: boolean): void;
  enterCollabMode(extensions: Extension, undoManager: { undo(): void; redo(): void }): void;
  exitCollabMode(): void;
  cutSelection(): void;
  copySelection(): void;
  pasteClipboard(): void;
  runCmd(cmd: string): void;
  insertAtCursor(text: string): void;
  newDoc(): void;
  openLocalFile(): void;
  exportAs(format: string): Promise<void>;
  toggleSidebar(): void;
  openImagesManager(): void;
  openShortcuts(): void;
  openAbout(): void;
  setView(mode: "editor" | "split" | "preview"): void;
  toggleExpandPreview(): void;
  toggleFocusMode(): void;
  openDiagramEditor(): void;
  setKeybindings(mode: "normal" | "vim" | "emacs"): void;
  formatRelativeTime(ts: number): string;
  // Set by gist.ts at module load, same pattern as onGithubAuthComplete —
  // optional because app.ts's own bridge literal (where every other
  // method above lives) is typed/assigned before gist.ts's module code runs.
  publishGist?(): void;
  openGistPicker?(): void;
}

declare global {
  interface Window {
    MDE: MDEBridge;
  }
}
