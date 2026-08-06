export interface Doc {
  id: string;
  name: string;
  content: string;
  updatedAt: number;
  images?: Record<string, string>;
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
  getEditor(): CodeMirror.Editor;
  getActiveDoc(): Doc | undefined;
  switchDoc(id: string): void;
  persistDocs(): void;
  renderDocList(): void;
  refreshSaveStatus(): void;
  getResolvedContent(): string;
  setDocImage(key: string, dataUrl: string): void;
  onImageAdded: ((key: string, dataUrl: string) => void) | null;
  toggleDropdown(btn: HTMLElement, menu: HTMLElement): void;
  closeAllDropdowns(): void;
  findDocById(id: string): Doc | undefined;
  requireGithubSignIn(hint?: string): void;
  openGithubSignInPopup(): void;
  githubUsername: string | null;
  githubSessionReady?: Promise<unknown>;
  createDoc(partial: Partial<Doc> & { id?: string; name?: string }): Doc;
  markActiveDocShared(shared: boolean): Doc | null;
  setActiveDocGistId(gistId: string): Doc | null;
  onBeforeDocLoad: (() => void) | null;
  onActiveDocChanged: ((doc: Doc) => void) | null;
  onGithubAuthComplete?: () => void;
}

declare global {
  interface Window {
    MDE: MDEBridge;
  }
}
