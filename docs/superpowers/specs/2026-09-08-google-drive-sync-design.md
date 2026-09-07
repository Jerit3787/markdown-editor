# Google Drive Integration — Design Spec

_(filename says "sync"; scope grew to sync + open + save during
brainstorming — the file is kept for link stability.)_

**Sub-project 4 (final) of the workspace pivot.** Sub-projects 1–3
(Workspace core v1.20.0, Workspace-level sharing v1.21.0, GitHub repo
sync v1.22–1.24 + portable local history v1.27.0) are shipped. This spec
covers three capabilities, all behind one "Connect Google Drive"
connection:

1. **Folder sync** — back a workspace onto a Google Drive folder the app
   creates and owns: pull, push, conflicts, Drive revisions in Version
   History, local history stored in the folder. The same shape as GitHub
   repo sync, adapted to Drive's API model.
2. **Open markdown from Drive** — a one-directional import: pick existing
   `.md` files anywhere in your Drive via the Google Picker; they come in
   as documents. Like "Open from GitHub Gist", never writes back.
3. **Save markdown to Drive** — a one-directional export of a single
   document to a `.md` file in Drive; the first save creates it, later
   saves update the same file in place. Exactly the "Publish / Update
   Gist" flow, no conflict check.

(2) and (3) are the lightweight Gist-parity pair (open / publish);
(1) is the heavy repo-parity relationship. All adapted to Drive's
privacy-scoped `drive.file` OAuth scope.

## Goal

Let a user connect Google Drive once, then either (a) link a workspace to
a Drive folder the app creates — pulling/pushing markdown + images with
per-file conflict resolution, so on another device connecting Drive and
picking that folder re-creates the workspace — or (b) one-shot-import
existing markdown files chosen from anywhere in their Drive. (a) is the
same kind of independent link as live-sharing (sub-project 2) and GitHub
repo sync (sub-project 3); (b) is a convenience import with no ongoing
relationship, parallel to the existing Gist open flow.

## The `drive.file` constraint (why this differs from repo sync)

GitHub's `repo` scope grants full tree access — link a repo, pull
everything. Google's privacy-friendly `drive.file` scope grants access
**per file, only to files the app created or the user individually
picked in the Google Picker** ([Google scope
guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)).
Selecting a *folder* in the Picker does **not** grant access to the files
already inside it — only files the app then creates there. The only
alternative is the full `drive` scope, which requires an annual paid
third-party CASA security assessment and shows a hard "unverified app"
block until it clears — out of scope for this project.

**Consequences, confirmed with the user:**

- **Folder sync operates on an app-created folder only.** You cannot
  *link* a pre-existing folder of notes. Everything the app writes
  (markdown, images, `.mde/` metadata) is app-created and stays
  accessible across sessions and devices; "open synced folder as
  workspace" picks from a list of *the app's own* folders.
- **"Open markdown from Drive" imports individual files, not folders.**
  The Google Picker lets you multi-select `.md` files from anywhere in
  your Drive; each picked file becomes readable to the app's token and is
  copied in as a document. It is a one-time copy — no link, no push-back,
  and re-importing the same file just makes another doc. Folder structure
  is not preserved (the Picker returns a flat list of files).
- **"Save markdown to Drive" creates an app-owned file.** The app writes
  the doc's markdown to a new `.md` file (`drive.file` fully permits
  this — the file is app-created); the doc remembers that file's id so a
  later save `PATCH`es it in place. Destination is My Drive root, or a
  folder you pick via the Picker's folder-select mode (placing a *new*
  file into a picked folder is allowed under `drive.file`; reading its
  pre-existing contents is not). Overwrites without a conflict check,
  same as "Update Gist".

## Non-goals / deferred scope

- **Linking a folder populated outside the app for *sync*.** `drive.file`
  fundamentally can't; full `drive` scope + its assessment is the only
  path and is out. (Individual-file *import* via the Picker is in
  scope — see "Open markdown from Drive".)
- **Importing whole folders / preserving folder structure.** The Picker
  returns a flat file list; imported docs land flat in the target
  workspace.
- **Any write-back from the import path.** "Open markdown from Drive" is
  read-only against Drive. An imported doc has no sync link; to get an
  edited copy back into Drive, use "Save markdown to Drive" or folder
  sync.
- **Conflict detection on export.** "Save markdown to Drive" overwrites
  the target file's current content — if you edited it in Drive since the
  last save, that edit is lost. This matches "Update Gist" exactly and is
  the deliberate difference from folder sync (which *does* detect a
  changed `headRevisionId` and prompts).
- **Images / assets on export.** "Save markdown to Drive" writes the
  markdown only; embedded-image references are left in whatever form they
  have locally (the doc keeps working in-app; the exported `.md` on its
  own has unresolved image links, noted in the success toast). Folder
  sync is the path that carries images.
- **Continuous / automatic sync.** Explicit pull/push, like repo sync and
  Gist. Not merged with the live Yjs collaboration channel — the two
  coexist and don't interact (a Drive-linked workspace can also be
  live-shared; pushing reads whatever the workspace's current local
  content is).
- **Atomic push.** Impossible on Drive (no commit primitive). Push is
  best-effort per file; a partial failure leaves the folder partly
  updated and the next push finishes it (see Push details).
- **Google Docs conversion.** Markdown is stored as `text/markdown`
  files, never converted to/from Google Docs format.
- **Drive ACLs / Drive's native sharing.** The app never touches the
  folder's permissions.
- **Drive-link is per-participant**, exactly like repo-link: it lives on
  the local `Workspace` record, so a collaborator who joins a live-shared
  workspace does not inherit it. No new work — stated for clarity.
- **`drive.file` OAuth verification.** Shipping unverified (Google Cloud
  "testing" mode + test users, or users click through the unverified
  screen). The verification submission is an ops task tracked outside
  this spec, not a code deliverable. The consent-screen copy and privacy
  policy link are in scope; the review turnaround is not a blocker.
- **A generic multi-provider sync abstraction.** `drive-sync.ts` is a
  sibling of `repo-sync.ts` that duplicates the planner *shape*, not a
  shared interface. Extract one only if a third provider ever lands.
- **`e2e-drive` real-Google harness.** The whole API surface mocks at the
  fetch boundary; a real harness (test Google account, Cloud project,
  OAuth creds in CI, test-user setup) is a possible follow-up, not v1.

## Current mechanics this builds on

- **`src/github-auth.ts`** — `handleLogin` builds the GitHub auth URL +
  a state cookie and returns a redirect; the flow runs in a **popup**
  (`client/src/app.ts:968` `window.open("/api/auth/github/login", …)`),
  whose final page is `popupHtml()` — it `postMessage`s
  `{ type: "github-auth", ok }` to `window.opener` at
  `window.location.origin` and closes itself. Clients listen via
  `window.addEventListener("message", …)` and call
  `window.MDE.onGithubAuthComplete()` (`GithubSignInModal.svelte:26`,
  `OpenGistModal.svelte:104`).
- **`src/auth.ts`** — `encryptSession`/`decryptSession` (AES-GCM, key =
  SHA-256 of `SESSION_SECRET`), `getCookie`, `cookieHeader`
  (`Path=/; Secure; HttpOnly; SameSite=Lax`), `SESSION_COOKIE =
  "mde_gh_session"`, `STATE_COOKIE = "mde_oauth_state"`. The crypto
  (`deriveKey`/`toBase64Url`/`fromBase64Url`) is generic; only the
  `SessionData` typing is GitHub-specific.
- **`src/github-repo.ts`** (325 lines) — proxies GitHub's REST + Git Data
  API behind the session cookie: `/api/repo/list`, `/create`,
  `/:owner/:repo/tree`, `/blob/:sha`, `/commits`, `/contents/:path`,
  `/push`. Routed in `src/worker.ts` by path regex.
- **`client/src/repo-sync.ts`** (762 lines) — pure planners
  (`planPull`/`planPush`, `slugifyDocName`, `dedupeRepoPath`,
  `rewriteImagesForPush`, `resolveImagesFromPull`, `slugFromRepoPath`,
  `historyPathFor`, `markerMatchesWorkspace`) + fetch-based orchestration
  (`pullFromRepo`, `pushToRepo`, `linkWorkspaceAndSync`,
  `createWorkspaceFromRepo`). Conflict UI via `RepoConflictModal.svelte`
  + `stores/repoSync.ts` (`repoLinkModalOpen`, `openRepoModalOpen`,
  `repoSyncBusyLabel`, `repoConflictModalOpen`, `repoConflictState:
  { kind: "pull"|"push", conflicts, deletions, onResolve }`).
- **`Workspace.repoLink = { owner, repo, branch }`**; **`Doc.repoPath`,
  `Doc.repoSha`, `Doc.repoImageShas: Record<string,string>`** — `repoSha`
  is the conflict key ("tree SHA at this path ≠ stored SHA" = remote
  changed).
- **Portable local history (v1.27.0)** — `historyPathFor(repoPath)` =
  `.mde/history/<slug>.json`; push bundles a doc's IndexedDB snapshots +
  `doc.notes` into that file, pull merges them back by snapshot id
  (`mergeSnapshotsFromRepo`, union-by-id).
- **Version History ↔ repo commits (v1.24.0)** —
  `VersionHistory.svelte`'s `loadVersions()` has a repo branch:
  `loadCommitEntries(doc)` fetches the file's commits and merges them as
  `HistoryEntry { kind: "commit" }` into the timeline; diff + restore
  work against them. `HistoryEntry` today is `local | commit`.
- **`src/worker.ts`** routes `/api/auth/github/{login,callback,logout,me}`
  and `/api/repo/*`, `/api/gist*`, `/api/workspace/*`, `/api/collab/*`.
- **Gist open flow** (`client/src/gist.ts` `openGistPicker` →
  `OpenGistModal.svelte` → `window.MDE.createDoc(...)`) — the model for
  the one-directional "Open markdown from Drive" import: fetch content,
  `createDoc` in the current workspace, no persistent link.
- **What's-new discipline** (CLAUDE.md) — a user-facing feature bumps the
  **minor** version and needs all three of: `package.json` +
  `package-lock.json` bump, a `CHANGELOG.md` section, and a
  `whats-new-entries.ts` entry **with a real committed screenshot**
  (`whats-new-entries.test.ts` fails the build if the file is missing).

## Data model

`client/src/types.ts`:

```ts
interface Workspace {
  // ...existing...
  driveLink?: {
    folderId: string;    // the app-created Drive folder's id
    folderName: string;  // display only; the folder's name as of last sync
  };
}

interface Doc {
  // ---- folder sync (parallel to repoPath / repoSha / repoImageShas) ----
  drivePath?: string;                       // synthetic path within the folder, e.g. "notes/todo.md"
  driveFileId?: string;                     // the Drive file this doc maps to (folder sync)
  driveRev?: string;                        // last-synced revision token — the conflict key
  driveImageRevs?: Record<string, {         // image / diagram ref -> its Drive file
    fileId: string;
    rev: string;
  }>;
  // ---- "Save markdown to Drive" (parallel to gistId / gistFilename) ----
  driveExportId?: string;                   // the standalone Drive file this doc was last saved to
  driveExportName?: string;                 // its filename, for the menu label + relabel-on-rename
}
```

`driveFileId` (folder sync) and `driveExportId` (standalone save) are
**independent** — a doc can be in a synced folder *and* separately saved
to a loose `.md` file, or either, or neither. They never point at the
same Drive file.

- **`driveRev` is the exact analogue of `repoSha`.** It is the file's
  `headRevisionId` — an opaque token Drive bumps on every content
  revision, returned by both `files.get` and `files.list`. "Remote
  changed since we synced" = "the file's current `headRevisionId` ≠
  `doc.driveRev`". `headRevisionId` (like `md5Checksum`) is documented as
  applying to "files with binary content" — which for the Drive API
  means *any uploaded blob that isn't a Google-native doc*, i.e. every
  file this feature writes. **Fallback:** if a `.list` result ever omits
  `headRevisionId`, use `modifiedTime` (always present) as the rev token
  for that file — the conflict-detection logic treats `driveRev` as an
  opaque "did it change" string either way.
  ([md5Checksum / headRevisionId are "binary content
  only"](https://developers.google.com/workspace/drive/api/reference/rest/v3/files),
  and uploaded text files qualify.)
- **Addressing is by opaque `fileId`, never by path.** Drive has no
  path-based lookup. `drivePath` is synthetic — derived from the folder
  tree walk, used only for display and for slug/dedup logic on first
  create. A doc keeps its `driveFileId` across renames.
- Folder-to-workspace identity is stored in the **folder's Drive
  `appProperties`** (hidden, app-private key-value metadata; ≤124 bytes
  per key+value, which fits):
  `{ mde: "1", mdeWorkspace: "<workspaceId>", mdeWorkspaceName: "<name>" }`.
  `mde: "1"` marks "an app folder" for the folder-list query;
  `mdeWorkspace` is the Drive-native equivalent of repo-sync's
  `.mde/workspace.json` marker (drives the `sameWorkspace` push
  optimization + orphan-asset cleanup).

## Server

### `src/google-auth.ts` (new) — mirrors `github-auth.ts`

Constants: `GOOGLE_AUTHORIZE_URL =
"https://accounts.google.com/o/oauth2/v2/auth"`, `GOOGLE_TOKEN_URL =
"https://oauth2.googleapis.com/token"`, `GOOGLE_REVOKE_URL =
"https://oauth2.googleapis.com/revoke"`, `DRIVE_SCOPE =
"https://www.googleapis.com/auth/drive.file"`, `GOOGLE_SESSION_COOKIE =
"mde_google_session"`, `GOOGLE_STATE_COOKIE = "mde_google_oauth_state"`.

New cookie payload (encrypted with the same `SESSION_SECRET` via a
generic `encryptJSON`/`decryptJSON` extracted from `auth.ts` —
`encryptSession`/`decryptSession` become thin wrappers over it):

```ts
interface GoogleSessionData {
  refreshToken: string;
  accessToken: string;
  accessTokenExp: number;  // epoch ms
  exp?: number;            // cookie lifetime, stamped like the GitHub session
}
```

- **`handleGoogleConnect(request, env)`** — build the authorize URL:
  `client_id`, `redirect_uri = ${origin}/api/auth/google/callback`,
  `response_type=code`, `scope=${DRIVE_SCOPE}`, `access_type=offline`,
  `prompt=consent` (forces a refresh token on every connect),
  `state=<random>` (also set as `GOOGLE_STATE_COOKIE`, `SameSite=Lax`,
  short max-age). Return a redirect. Runs in a popup, same as GitHub.
- **`handleGoogleCallback(request, env)`** — verify `state` against the
  cookie; `POST GOOGLE_TOKEN_URL` (`grant_type=authorization_code`,
  `code`, `client_id`, `client_secret`, `redirect_uri`) →
  `{ access_token, refresh_token, expires_in }`. If no `refresh_token`
  (user previously consented and Google withheld it — mitigated by
  `prompt=consent`, but handle it): fail the popup with "Please
  disconnect and reconnect". Encrypt `{ refreshToken, accessToken,
  accessTokenExp: Date.now() + expires_in*1000 }` into
  `GOOGLE_SESSION_COOKIE`. Render `popupHtml({ type: "google-auth",
  ok })` — a Google-specific copy of `github-auth.ts`'s `popupHtml`
  (extract a shared `popupHtml(type, ok, message)` helper).
- **`handleGoogleDisconnect(request, env)`** — read the cookie,
  `POST GOOGLE_REVOKE_URL?token=<refreshToken>`, clear the cookie
  (`Max-Age=0`). Always 204 even if the revoke call fails (the cookie is
  gone regardless).
- **`handleGoogleStatus(request, env)`** — `{ connected: boolean }`.
  `connected` iff the cookie decrypts and isn't past `exp`. Does **not**
  call Google (cheap, called on every page load).
- **`getGoogleAccessToken(request, env): Promise<{ token: string;
  setCookie?: string } | null>`** — internal, used by every
  `src/google-drive.ts` handler:
  1. Decrypt `GOOGLE_SESSION_COOKIE`; `null` → return `null` (→ caller
     401s).
  2. `accessTokenExp - Date.now() > 60_000` → return `{ token:
     accessToken }`.
  3. Else `POST GOOGLE_TOKEN_URL` (`grant_type=refresh_token`,
     `refresh_token`, `client_id`, `client_secret`). Success → new
     `{ access_token, expires_in }`; re-encrypt the cookie (keeping the
     same `refreshToken`) and return `{ token, setCookie: <header> }` —
     **the caller must attach `setCookie` to its `Response`**.
  4. Refresh fails (`400 invalid_grant` = revoked / 6-month idle /
     password change): return `null`.

### `src/google-drive.ts` (new) — all via `getGoogleAccessToken`

Every handler: resolve the token first; `null` → `401 "Reconnect Google
Drive."`; on success, thread `setCookie` onto the returned `Response`.
Drive API base `https://www.googleapis.com/drive/v3`, upload base
`https://www.googleapis.com/upload/drive/v3`.

| Route (in `src/worker.ts`) | Drive call | Notes |
| --- | --- | --- |
| `POST /api/drive/folder` | `POST /files` `{ name, mimeType: "application/vnd.google-apps.folder", appProperties: { mde:"1", mdeWorkspace, mdeWorkspaceName } }` | body: `{ workspaceId, workspaceName, folderName }`. Returns `{ folderId, folderName }`. |
| `GET /api/drive/folders` | `GET /files?q=mimeType='application/vnd.google-apps.folder' and appProperties has { key='mde' and value='1' } and trashed=false&fields=files(id,name,appProperties,modifiedTime)` | the "open Drive folder as workspace" chooser list. Returns `[{ folderId, folderName, workspaceId, modifiedTime }]`. |
| `GET /api/drive/folder/:folderId/tree` | recursive walk: `GET /files?q='<id>' in parents and trashed=false&fields=files(id,name,mimeType,headRevisionId,modifiedTime,appProperties)`, one call per subfolder (`assets/*`, `.mde/*`) | Drive `q` is not recursive. Server BFS-walks, returns a **flat list** `[{ fileId, path, mimeType, rev }]` (`rev` = `headRevisionId` ?? `modifiedTime`) with synthetic `path` built from the folder names. Depth cap (e.g. 8) as a guard. |
| `GET /api/drive/file/:fileId` | `GET /files/{id}?alt=media` | returns `{ contentBase64 }`. Used for `.md`, images, `.mde/*.json`. |
| `POST /api/drive/folder/:folderId/push` | per item (see Push details) | **best-effort.** Returns `200` with `{ results: [{ path, op, ok, fileId?, rev?, error? }], synced, failed }` even on partial failure. |
| `GET /api/drive/file/:fileId/revisions` | `GET /files/{id}/revisions?fields=revisions(id,modifiedTime,lastModifyingUser(displayName))` | Version History timeline. `[]` if the file has only one revision. |
| `GET /api/drive/file/:fileId/revisions/:revId` | `GET /files/{id}/revisions/{rev}?alt=media` | preview / restore a Drive revision → `{ contentBase64 }`. |
| `GET /api/auth/google/picker-token` | — | returns `{ token, apiKey }` for the client to build the Google Picker (import only). `token` is the live access token (refreshed if needed, `setCookie` threaded); `apiKey` is `GOOGLE_API_KEY`. See the security note below. |
| `POST /api/drive/import` | `GET /files/{id}?fields=name,mimeType` + `GET /files/{id}?alt=media` per id | body `{ fileIds: string[] }` (from the Picker). Returns `[{ fileId, name, contentBase64, ok, error? }]` — best-effort per file. Server-side download keeps the token off the client after the Picker closes. |
| `POST /api/drive/export` | `fileId` present → `PATCH /upload/drive/v3/files/{fileId}?uploadType=media`; else → `POST /upload/drive/v3/files?uploadType=multipart` (metadata `{ name, parents: [parentFolderId ?? "root"] }` + content) | body `{ fileId?, name, parentFolderId?, contentBase64 }` ("Save markdown to Drive"). Returns `{ fileId, name, webViewLink }`. Create-or-update in one endpoint, mirroring `handleGistCreate` / `handleGistUpdate`. |

**Push endpoint body:**

```ts
{
  ensureSubfolders: string[];   // e.g. ["assets/notes-slug", ".mde/history"] — created (idempotently) first
  creates: { path: string; mimeType: string; contentBase64: string }[];
  updates: { fileId: string; contentBase64: string }[];
  deletes: string[];            // fileIds
}
```

Server, in order:
1. For each `ensureSubfolders` path: walk/create each missing segment
   under `folderId` (a `files.list` by name+parent, then `files.create`
   folder if absent). Cache created ids within the request.
2. `creates`: `POST /upload/drive/v3/files?uploadType=multipart` — a
   `multipart/related` body: part 1 `application/json`
   `{ name, parents: [<resolved subfolder id>], mimeType }`, part 2 the
   raw bytes with `Content-Type: <mimeType>`. Response `fields=id,headRevisionId,modifiedTime`.
3. `updates`: `PATCH /upload/drive/v3/files/{fileId}?uploadType=media`
   with the raw bytes (content-only; name/parents unchanged). Response
   `fields=id,headRevisionId,modifiedTime`.
4. `deletes`: `DELETE /files/{fileId}` (hard delete — the file is
   app-created and the doc is gone locally; trash would leave it
   listable and re-pullable).
5. Each item wrapped in try/catch; a failure records `{ ok: false, error
   }` and the loop continues. HTTP status is always `200` unless the
   token itself is dead.

### `src/env.ts`

```ts
GOOGLE_CLIENT_ID: string;      // OAuth client id
GOOGLE_CLIENT_SECRET: string;  // OAuth client secret (secret)
GOOGLE_API_KEY: string;        // browser API key for the Google Picker — NOT secret
```

`GOOGLE_CLIENT_SECRET` → `wrangler secret put`; `GOOGLE_CLIENT_ID` and
`GOOGLE_API_KEY` are non-secret (public in every Picker/OAuth request
anyway) and can be plain `wrangler.toml` vars. Local: git-ignored
`.dev.vars`. Absent → `/api/auth/google/*` and `/api/drive/*` return
`503 "Google Drive is not configured."` and the client hides every
Google menu item (same graceful degradation the GitHub OAuth path
already has for a missing `GITHUB_CLIENT_SECRET`).

### Security note — the Picker needs a client-side token

The Google Picker is a Google-hosted iframe with no server-side
equivalent; it requires an OAuth access token *in the browser*
(`PickerBuilder().setOAuthToken(...)`). This breaks the app's "token
never in JS" invariant for the duration of the Picker interaction.
Bounded by: the scope is `drive.file` (the exposed token can only read
app-created files + files already picked — not the user's whole Drive),
the token is fetched from `/api/auth/google/picker-token` only at the
moment the Picker opens (not held long-term), and the actual file
downloads route back through the server (`POST /api/drive/import`) so the
token isn't needed after the Picker closes. The folder-sync path never
exposes a token — only the import path does, and only because the Picker
is the sole `drive.file`-compatible way to select arbitrary files.

## Client: `drive-sync.ts` (folder sync) + `drive-files.ts` (import/save) + `stores/driveSync.ts` + UI

### Pure planners (parallel to `repo-sync.ts`, unit-tested in isolation)

```ts
planPull(driveTree: DriveEntry[], docs: Doc[], dirtyDocIds: Set<string>): {
  toCreate:  { path: string; fileId: string }[];
  toUpdate:  { docId: string; fileId: string }[];
  unchanged: string[];
  conflicts: { docId: string; docName: string; drivePath: string }[];
  pendingDeletions: { docId: string; docName: string; drivePath: string }[];
}
```
Match `.md` entries to docs by `driveFileId`, falling back to `drivePath`
on the first pull after a link. Then, per matched pair:
`entry.rev === doc.driveRev` → unchanged; differs & doc clean → `toUpdate`;
differs & doc in `dirtyDocIds` → conflict. Unmatched `.md` entry →
`toCreate`. Doc with a `driveFileId` absent from the tree → pending
deletion (batched confirmation, exactly like repo-sync).

```ts
planPush(docs: Doc[], driveTree: DriveEntry[], sameWorkspace: boolean,
         pendingDriveDeletions: string[]): {
  creates: { docId: string; path: string; contentBase64: string; imageOps: ImageOp[] }[];
  updates: { docId: string; fileId: string; contentBase64: string; imageOps: ImageOp[] }[];
  deletes: string[];   // fileIds (locally-deleted docs + orphaned assets)
  conflicts: { docId: string; docName: string; drivePath: string }[];
  unchanged: string[];
}
```
Per doc: resolve `doc.images`/`doc.diagrams` to `assets/<slug>/…` and
rewrite the markdown (reuse `repo-sync.ts`'s `rewriteImagesForPush`
verbatim — it already targets repo-relative paths, which are identical in
shape to Drive synthetic paths). Then: no `driveFileId` → `create`,
assign `drivePath` (`slugifyDocName` + `dedupeRepoPath` against the tree
— both reused unchanged). `driveFileId` set, local content hash ===
`doc.driveRev` and no image changes → `unchanged`. Content changed,
remote rev still === `doc.driveRev` → `update`. Remote rev ≠
`doc.driveRev` → conflict. Locally-deleted doc that had a `driveFileId` →
`delete`. `sameWorkspace` (the folder's `appProperties.mdeWorkspace`
matches) enables aggressive path-matching + `assets/*` orphan cleanup;
otherwise stay conservative — same rule as repo-sync's marker check.

`historyPathFor(drivePath)` = `.mde/history/<slug>.json`, reused
unchanged.

### Orchestration (fetch-based, unit-tested with a stubbed `fetch`)

| Fn | Flow |
| --- | --- |
| `linkWorkspaceToDrive(wsId, folderName)` | `POST /api/drive/folder` → set `workspace.driveLink` → `pushToDrive(wsId)` (folder is empty → always a clean push, no conflict path) |
| `openDriveFolderAsWorkspace(folder)` | create a local workspace (name = `folder.folderName`) → set `driveLink` → `pullFromDrive(wsId)` |
| `pullFromDrive(wsId)` | `GET …/tree` → `planPull` → apply `toCreate`/`toUpdate`/deletions with no conflicts immediately (restamp `driveRev`/`driveFileId`); any conflicts or pending deletions → open `SyncConflictModal`; `onResolve` re-applies per the mine/theirs choices |
| `pushToDrive(wsId)` | `GET …/tree` **fresh** → `planPush` → conflicts open `SyncConflictModal` first → build the push body → `POST …/push` → **per-result**: `ok` → commit that doc's `driveFileId`/`driveRev`/`driveImageRevs` + write local history to `.mde/history/*` on the same batch; `!ok` → leave the doc's stored state as-is (stays ahead of Drive), collect the count |
| `pullDriveRevisions(fileId)` | `GET /api/drive/file/:id/revisions` — used by `VersionHistory.svelte` |
| `getDriveRevisionContent(fileId, revId)` | `GET /api/drive/file/:id/revisions/:rev` |

**Best-effort push result handling** (the user's Q4 choice): after
`POST …/push`, `results.filter(r => !r.ok)` → if any, a toast:
`"Pushed <synced> of <synced+failed> files to Drive — Retry"` with a
retry action that re-runs `pushToDrive` (the still-unsynced docs are
still "changed" vs `driveRev`, so they're exactly what the next
`planPush` picks up). No rollback, no partial-state cleanup — the
workspace self-heals on the next push.

**Images**: one `assets/<doc-slug>/` subfolder per doc; the push body's
`ensureSubfolders` lists every needed subfolder so the server makes them
before the image `creates` land. `driveImageRevs[ref] = { fileId, rev }`
tracks each image, so an image edited on Drive surfaces as a conflict on
that doc too (mirrors `repoImageShas`). `resolveImagesFromPull` is reused
for the pull direction (fetch each referenced asset blob, fold into
`doc.images`, rewrite markdown to internal ref syntax).

### `client/src/stores/driveSync.ts` (new)

```ts
export const driveConnected       = writable(false);   // hydrated from GET /api/auth/google/status on load
export const openDriveModalOpen   = writable(false);   // "open a synced folder as a workspace" list
export const linkDriveModalOpen   = writable(false);
export const driveSyncBusyLabel   = writable<string | null>(null);   // "Pulling from Drive…" / "Pushing to Drive…"
export const driveImportBusyLabel = writable<string | null>(null);   // "Importing…" (the Picker import path)
export const driveExportBusyLabel = writable<string | null>(null);   // "Saving…" / "Updating…" (per-file save)
```

Conflict modal state is **shared** with repo-sync: rename
`stores/repoSync.ts`'s `RepoConflictState` → `SyncConflictState`
(add `source: "repo" | "drive"` for the modal's copy/links), and
`RepoConflictModal.svelte` → `SyncConflictModal.svelte`. `repoSyncBusyLabel`
+ `driveSyncBusyLabel` stay separate (a workspace can't push to both at
once, but the labels differ — "Pushing to Drive…" vs "Pushing to
Repo…").

### UI

- **`File > Open >`** gains `Markdown from Google Drive…` (next to `From
  GitHub Gist…`) → the **Picker import** (previous section). Not the
  synced-folder chooser — that lives in the Google Drive submenu below.
- **`File > Google Drive >`** submenu (parallel to `GitHub Repo >` in
  `MenuBar.svelte`) — the **sync** feature:
  - not connected → `Connect Google Drive…`
  - connected → `Open a synced folder as a workspace…` →
    `OpenDriveModal.svelte` (new): a list from `GET /api/drive/folders`
    (folder name + last-modified) → pick → `openDriveFolderAsWorkspace`.
  - connected, `!workspace.driveLink` → `Link this workspace to a Drive
    folder…` → `LinkDriveModal.svelte` (new): one text field (folder
    name, default = workspace name), Create button.
  - connected, linked → folder-name label linking to
    `https://drive.google.com/drive/folders/<folderId>` · `Pull from
    Drive` · `Push to Drive` (both disabled while `$driveSyncBusyLabel`)
    · `Unlink from Drive` (drops local `driveLink`, keeps the folder) ·
    `Disconnect Google Drive` (revokes; affects every linked workspace —
    a `ConfirmDialog` first).
- **`DocInfoPanel.svelte`** — up to two Drive rows: the folder-sync row
  (`Google Drive folder — <folderName> / <drivePath>`, links to the file
  in Drive) when `doc.driveFileId`, and the saved-file row
  (`Saved to Google Drive — <driveExportName>`, links to
  `drive.google.com/file/d/<driveExportId>`) when `doc.driveExportId` —
  parallel to the existing Gist link row.
- **`Settings` modal** — a "Connections" section: "Google Drive —
  Connected / Not connected" + a Connect/Disconnect button (discovery;
  the menu is primary).
- **`window.MDE` bridge** additions (`client/src/types.ts` +
  `client/src/app.ts`): `openDriveFolderPicker` (the sync "open synced
  folder" list), `importMarkdownFromDrive` (Picker import), `saveToDrive`
  (per-file create/update), `connectGoogleDrive`, `disconnectGoogleDrive`,
  `linkToDriveAction`, `pullFromDriveAction`, `pushToDriveAction`.
  `onGoogleAuthComplete` hook (parallel to `onGithubAuthComplete`) —
  refreshes `driveConnected` and re-runs the pending action.
- **Sprite sheet** — add `#icon-drive` (the Drive logo, or a generic
  cloud-sync glyph consistent with the existing icon set).

### Open / Save markdown — `client/src/drive-files.ts` (new)

The two one-directional per-file flows, structurally like `gist.ts`
(open + publish), not like the sync module. `window.MDE.importMarkdownFromDrive`
and `window.MDE.saveToDrive` (create/update), parallel to
`openGistPicker` / `publishGist`.

#### Open markdown from Drive (Picker import)

- **Menu**: `File > Open >` gains `Markdown from Google Drive…` (next to
  `From GitHub Gist…`). Not connected → runs the OAuth popup first, then
  proceeds on `onGoogleAuthComplete`.
- **Picker load**: lazy-load Google's picker from
  `https://apis.google.com/js/api.js` (allowed by the app's existing CSP
  `script-src` — the plan verifies / adds `apis.google.com`), then
  `gapi.load("picker", …)`. `GET /api/auth/google/picker-token` supplies
  `{ token, apiKey }`. Build a `PickerBuilder`: a `DocsView` filtered to
  `application/vnd.google-apps.folder` excluded + `text/markdown`,
  `text/plain`, and extension `.md`/`.markdown` (Picker MIME filters are
  loose — the import step also checks the fetched file's name/extension
  and skips anything that isn't markdown-ish, reporting it);
  `enableFeature(Feature.MULTISELECT_ENABLED)`; `setCallback` receives the
  selected `{ id, name }[]`.
- **Import**: `POST /api/drive/import` with the picked `fileIds` →
  `[{ fileId, name, contentBase64, ok, error? }]`. For each `ok`,
  `createDoc({ name: <name minus .md>, content: <decoded> })` in the
  **current workspace** (name collisions get the app's usual silent `-2`
  suffix, same as `createDoc` everywhere). Images referenced by the
  markdown are **left as-is** — the import notes any `![](…)` links that
  won't resolve in a post-import toast (`"Imported 3 files. 2 image
  references won't resolve — see <doc>."`), matching the compatibility
  approach the app already uses. No `drive*` fields are set on imported
  docs; they are ordinary local documents from that point on.
- **Busy state**: `driveImportBusyLabel` (a store field), so the
  menu item shows `Importing…` and disables.

#### Save markdown to Drive (per-file export)

- **Menu**: `File > Publish >` submenu (which already holds Publish/Update
  Gist) gains `Save to Google Drive` / `Update in Google Drive` — the
  label switches on `doc.driveExportId`, exactly like the Gist row's
  `Publish to Gist` / `Update Gist`. A `View in Drive` link
  (`https://drive.google.com/file/d/<driveExportId>`) shows when set,
  parallel to `#gistViewLink`. Not connected → OAuth popup first.
- **First save**: a small dialog (reuse `Modal`) — filename field
  (default `<doc.name>.md`) and, optionally, `Choose folder…` which opens
  the Picker in folder-select mode (`setSelectFolderEnabled(true)`,
  `setIncludeFolders(true)`) to pick a `parentFolderId`; default is My
  Drive root. `POST /api/drive/export` (no `fileId`) → store
  `driveExportId` + `driveExportName` on the doc, toast with the
  `webViewLink`.
- **Later saves**: `POST /api/drive/export` **with** `fileId =
  doc.driveExportId` → `PATCH` the file's content. No dialog, no folder
  reprompt, no conflict check (overwrites — same as Update Gist). If the
  file 404s (deleted in Drive) → clear `driveExportId` and fall back to a
  first-save.
- **On doc rename**: leave the Drive file's name as-is (like Gist —
  renaming the doc doesn't rename the gist); the `Update in Google Drive`
  label keeps showing `driveExportName`. A future "rename in Drive too"
  is out of scope.
- **Busy state**: `driveExportBusyLabel` (`Saving…` / `Updating…`).

### Version History integration

- **`HistoryEntry`** union: `local | commit` → `local | remote` with
  `remote.source: "github" | "drive"`. `loadCommitEntries` →
  `loadRemoteEntries` with a `source` param. `VersionHistory.svelte`'s
  `loadVersions()`: `if (workspace.repoLink)` → GitHub commits (as
  today); `if (workspace.driveLink && doc.driveFileId)` →
  `pullDriveRevisions(doc.driveFileId)` → `remote` entries
  `{ source: "drive", id: revId, timestamp: modifiedTime, author:
  lastModifyingUser.displayName }`. Both render identically (icon +
  label + Diff + Restore).
- **Load a `remote` entry's content**: GitHub → existing blob fetch;
  Drive → `getDriveRevisionContent`. One branch in the existing
  "load selected version content" path.
- **Restore** a Drive revision → the existing
  `restoreLocalVersionContent` / `restoreSharedVersionContent` path
  (fetch bytes → apply as content), exactly like restore-from-commit. No
  new restore code.

### Local history stored in the folder (parity with v1.27.0)

- **Push**: for each pushed doc, bundle its IndexedDB snapshots +
  `doc.notes` into JSON and add a `create`/`update` for
  `.mde/history/<slug>.json` to the same push batch (`ensureSubfolders`
  gets `.mde/history`).
- **Pull**: read every `.mde/history/*.json` in the tree, merge into
  local history by snapshot id — **`mergeSnapshotsFromRepo` reused
  verbatim**; notes follow repo-sync's existing merge behavior.
- Renames/deletes of `.mde/history/*.json` ride the same
  `historyPathFor` + tree-diff logic as `.md` files. No new restore path
  — it's local history that happens to be backed up.

## Error handling

| Situation | Behavior |
| --- | --- |
| Not connected, menu item clicked | opens the connect popup, resumes the action on `onGoogleAuthComplete` |
| `getGoogleAccessToken` → `null` (revoked / idle / password change) | endpoint `401`; client clears `driveConnected`, toasts `"Google Drive disconnected — reconnect to sync"`, opens the connect modal |
| Refresh succeeded | `setCookie` threaded onto the response; transparent to the client |
| `GOOGLE_CLIENT_*` unset | routes `503`; client hides the Drive menu items entirely |
| Drive `403 rateLimitExceeded` / `userRateLimitExceeded` | server retries once with backoff; still failing → the push result item / the pull is `{ ok: false, error: "Drive rate limit — try again shortly" }` |
| Drive `404` on a `fileId` we stored (folder or file trashed in Drive UI) | pull: treat as a remote deletion (pending-deletion confirmation); push update: fall back to a `create` |
| Partial push failure | best-effort per-file + "Retry" toast (above) |
| Folder's `appProperties.mdeWorkspace` ≠ this workspace | `sameWorkspace = false` — conservative matching, no orphan cleanup |
| Two devices push the same doc concurrently | second push sees `remote rev ≠ doc.driveRev` → conflict modal, same as repo-sync's stale-base-tree case |
| Picker cancelled / no files selected | no-op, close cleanly |
| A picked file isn't markdown (Picker MIME filters are loose) | `/api/drive/import` still returns it; the client skips it and the toast lists it: `"'budget.xlsx' skipped — not a markdown file"` |
| An imported `.md` references images | left as-is; post-import toast lists unresolved `![](…)` links |
| `/api/auth/google/picker-token` called while disconnected | `401`; client runs the connect popup then retries |

## Testing

| Layer | What |
| --- | --- |
| Pure planners (`planPull`, `planPush`, slug/dedupe, image rewrite, `historyPathFor`) | `tests/client/src/drive-sync.test.ts` — unit, no network; the bulk of the coverage, mirrors `repo-sync.test.ts` |
| `src/google-auth.ts` | `tests/src/google-auth.test.ts` — `vi.stubGlobal("fetch")`: authorize-URL params, state mismatch → popup fail, token exchange, **refresh** (expired `accessTokenExp` → refresh fired → `setCookie` returned; refresh `400 invalid_grant` → `null` → `401`), disconnect/revoke, missing `refresh_token` handling, missing `GOOGLE_CLIENT_*` → `503` |
| `src/google-drive.ts` | `tests/src/google-drive.test.ts` — folder create sends `appProperties`; tree walk recurses subfolders and flattens paths; **best-effort push** (3 items, #2's `PATCH` → 500 → `{ results: [ok, {ok:false,error}, ok], synced: 2, failed: 1 }`, HTTP 200); `POST /api/drive/import` — per-file name+content, one file 404 → `{ ok: false }` for that entry, 200 overall; `POST /api/drive/export` — no `fileId` → multipart create with `parents`; with `fileId` → `PATCH` media; `picker-token` returns `{ token, apiKey }` + `401` when disconnected; `getGoogleAccessToken` `null` → `401` |
| Client — sync | `tests/client/src/drive-sync.test.ts` — `linkWorkspaceToDrive` / `pullFromDrive` / `pushToDrive` with stubbed `fetch`: conflict modal opens, push body shape, per-file doc-record commit, partial-failure toast + retry re-picks-up the unsynced docs |
| Client — import/save | `tests/client/src/drive-files.test.ts` — **import**: stub the Picker callback with `[{id,name}]`, stub `/api/drive/import` → docs created in the current workspace with decoded content, name collision → `-2`, non-markdown skipped + reported, unresolved image links reported. **save**: first save with no `driveExportId` → dialog, `POST` create, `driveExportId`/`driveExportName` stored, toast link; second save → `PATCH` (no dialog); export file 404 → clears `driveExportId` and retries as a create |
| Components | `OpenDriveModal.test.ts`, `LinkDriveModal.test.ts`; retarget `RepoConflictModal.test.ts` → `SyncConflictModal.test.ts` (drive + repo `source`); `VersionHistory.test.ts` gains a Drive-revisions branch (mirrors the existing `VersionHistoryRepoCommits.test.ts`); `DocInfoPanel.test.ts` Drive row |
| `docs/TEST-COVERAGE.md` | new **§15 "Google Drive sync"** section, ~15–20 rows; the subsystem-totals table gains a row |

**No `e2e-drive` project** — the fetch boundary covers it; a real
harness is a documented possible follow-up (`## Deferred` note style).

## Versioning & release

User-facing → **minor bump** (`1.49.0`). All three: `package.json` +
`package-lock.json`; `CHANGELOG.md` `### Added` (all three capabilities);
`whats-new-entries.ts` — **one entry, "Google Drive"** covering connect +
folder sync + open + save (one release, one entry; don't split), category
per open question 1. **Real screenshot** captured via a new
`tests/scripts/manual-testing/capture-drive-sync-screenshot.mjs`,
committed in the same change (`whats-new-entries.test.ts` enforces it —
capture against a local build with a real Google test project, same as
the other capture scripts need a real backend).

## Open questions for the plan

1. **What's-new category** — keep `"GitHub Integration"`, or introduce
   `"Cloud Sync"` (would also re-file GIST/REPO entries — bigger churn)?
2. **`.dev.vars` for local dev** — Google OAuth needs a real Cloud
   project + creds even locally (the redirect URI must be registered).
   The plan should document the setup in `CONTRIBUTING.md` alongside the
   GitHub OAuth App instructions, and note that without `GOOGLE_CLIENT_*`
   the whole feature degrades gracefully (routes `503`, menu hidden) so
   contributors without Google creds aren't blocked — same as GitHub
   OAuth today.
3. **Icon** — reuse an existing glyph or add a dedicated Drive mark?
4. **Picker CSP** — `apis.google.com` (the Picker loader) must be in the
   app's `script-src`. The plan checks the current CSP (`index.html` /
   worker headers) and adds it if missing; also the Picker iframe origins
   (`docs.google.com`, `*.google.com`) for `frame-src` /
   `child-src`.
5. **`GOOGLE_API_KEY` restriction** — it's a browser key; the plan
   documents restricting it by HTTP referrer to the app's domains in the
   Google Cloud console (defence in depth; the key alone can't do
   anything without a user's OAuth token).
6. **Plan decomposition.** One feature, large (new OAuth provider + Drive
   proxy + client sync module + Picker import + per-file save + Version
   History integration + history-in-folder + ~4 modals/dialogs + ~6 test
   files). Ships as one release (`1.49.0`); the *implementation plan* is
   split into **three sequential plans on one branch**, each
   independently reviewable and each leaving the tree green:
   1. **Connection + the three flows** — `google-auth.ts` (connect /
      callback / status / disconnect / `getGoogleAccessToken` /
      `picker-token`), `google-drive.ts` (folder / folders / tree / file
      / push / import / **export**), `drive-sync.ts` planners +
      pull/push, `drive-files.ts` (Picker import + per-file save),
      `stores/driveSync.ts`, the `SyncConflictModal` rename, the
      `File > Open > Markdown from Google Drive`, `File > Publish > Save
      to Google Drive`, and `File > Google Drive` menus, `LinkDriveModal`,
      `OpenDriveModal`, the save dialog, `DocInfoPanel` rows. All three
      capabilities are usable at the end of this. (This plan is itself
      large — the writing-plans step may sub-split it into 1a
      auth+import+save and 1b folder sync.)
   2. **Version History integration** — the `HistoryEntry`
      `commit → remote` generalization, `/revisions` endpoints,
      `pullDriveRevisions`, the `VersionHistory.svelte` Drive branch.
   3. **History-in-folder + release** — `.mde/history/*.json` on
      push/pull, Settings "Connections" row, the What's-new entry +
      screenshot + `CHANGELOG` + version bump, `docs/TEST-COVERAGE.md`
      §15, `CONTRIBUTING.md` Google OAuth + API-key setup docs.
   The writing-plans step produces plan 1 first; plans 2 and 3 are
   written after plan 1 lands (same "branch each phase off the previous"
   pattern the workspace-pivot sub-projects used).
