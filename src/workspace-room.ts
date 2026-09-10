import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { getCookie, decryptSession, SESSION_COOKIE } from "./auth.js";
import { relocateAnchor } from "./anchor";
import { redactAccessForOutsider } from "./access-visibility";
import { rewriteWikilinkReferences } from "./wikilink-rewrite";
import { groupSnapshotsIntoSessions, SESSION_GAP_MS } from "./version-grouping";
import {
  reconcileReviewerDelta,
  getSuggestionsMap,
  listResolvedSuggestions,
  recordInsertSuggestion,
  recordDeleteSuggestion,
  toAbsoluteIndex,
} from "./suggestions";
import type { ResolvedSuggestion, SuggestionEntry } from "./suggestions";
import { removeRanges, reviewerTextRepairs, isValidNewSuggestionEntry } from "./reviewer-integrity";
import { getCommentsMap, seedCommentThreadsIntoDoc, type CommentThreadEntry } from "./comments-doc";
import { isValidNewThread, isAllowedThreadTransition } from "./comment-integrity";
import type { Env } from "./env";
import { resolveRole } from "./access-role";
import { verifyTurnstileToken, mintJoinTicket, verifyJoinTicket } from "./turnstile.js";
import type { Role, InvitedPerson, AccessRecord, AccessRequest } from "./access-role";

export type { Role, InvitedPerson, AccessRecord, AccessRequest };

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Workspace-wide "which document am I currently looking at" signal —
// separate from MESSAGE_AWARENESS because each document keeps its own
// independent y-protocols Awareness instance (needed for correct
// per-document cursor/selection sync, same as CollabRoom today); this
// message type is the thing that lets the doc list show "who's on which
// file" across the whole workspace instead of just within one open doc.
const MESSAGE_PRESENCE = 2;
// The workspace's own name plus its ordered document list ({name,
// docOrder}) — a single last-write-wins value nobody co-edits
// character-by-character the way document content is, so it rides the
// same socket as a plain broadcast/greeting frame instead of a Y.Doc.
// docId-less, like MESSAGE_PRESENCE.
const MESSAGE_WORKSPACE_META = 3;
// (4 was MESSAGE_COMMENTS — retired in SP-B. Comment threads now live in
// a `comments` Y.Map on each doc and ride the normal SYNC frames; there
// is nothing to signal a refetch for. The wire number is left unused
// rather than recycled so an old client's stray frame is simply ignored.)
// Broadcast once, to every live session, when the owner deletes the
// workspace (handleDeleteRequest). Single varuint, no docId — like a bare
// MESSAGE_WORKSPACE_META greeting. The client tears down and drops its
// local mirror; sessions are closed right after the broadcast.
const MESSAGE_WORKSPACE_DELETED = 5;
// CV2-5. Broadcast to every live session when a viewer/reviewer submits
// "request edit access" ([type, username, message], no docId). Only the
// owner's client acts on it (a toast); everyone else ignores it.
const MESSAGE_ACCESS_REQUEST = 6;
// CV2-5. Broadcast (bare varuint, no docId) whenever the access record or
// the pending-requests list changes through an owner action — approve,
// deny, or a plain PUT /access role edit. Every client re-fetches
// GET /access and, if its own resolved role changed, rejoins the room.
const MESSAGE_ACCESS_CHANGED = 7;

const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

const PERSIST_DELAY_MS = 1000;

export interface Snapshot {
  id: string;
  timestamp: number;
  content: string;
  images?: Record<string, string>;
  // GitHub usernames of the collaborators who edited during this
  // snapshot's window, first-seen order. Absent on snapshots captured
  // before authorship tracking, and on snapshots migrated in from a
  // legacy CollabRoom — every read path treats absent as [].
  authors?: string[];
}

// The pre-SP-B HTTP comment-thread shape — persisted under
// docStorageKey(docId, "comments") and sent in a legacy CollabRoom
// migration payload. Kept only for the one-time seed into the doc's
// `comments` Y.Map (loadDocRoom + /internal/seed); nothing writes this
// shape any more. Live comment state is comments-doc.ts's
// CommentThreadEntry.
export interface LegacyCommentReply {
  id: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface LegacyCommentThread {
  id: string;
  from: number;
  to: number;
  quote: string;
  orphaned: boolean;
  resolved: boolean;
  comments: LegacyCommentReply[];
}

export const DEFAULT_ACCESS: AccessRecord = { owner: null, generalAccess: "restricted", requireAccount: false, role: "viewer", invited: [] };

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function normalizeInvited(raw: unknown[]): InvitedPerson[] {
  const seen = new Set<string>();
  const result: InvitedPerson[] = [];
  for (const entry of raw) {
    const username = typeof entry === "string" ? entry.trim() : String((entry as any)?.username || "").trim();
    if (!username || seen.has(username)) continue;
    const rawRole = typeof entry === "string" ? "editor" : (entry as any)?.role;
    const role: Role = (["viewer", "reviewer", "editor"] as const).includes(rawRole) ? rawRole : "editor";
    seen.add(username);
    result.push({ username, role });
    if (result.length >= 100) break;
  }
  return result;
}

// One entry per document currently in the workspace — same per-document
// state CollabRoom held at the top level of one DO instance, now nested
// one level so a single WorkspaceRoom instance can hold several.
export interface DocRoom {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  snapshots: Snapshot[];
  lastSnapshotAt: number | undefined;
  // Usernames that have edited this doc since the last snapshot capture —
  // flushed onto Snapshot.authors and cleared by maybeSnapshot /
  // forceSnapshot. In-memory only; losing it across DO eviction just
  // means a snapshot with fewer (or no) recorded authors.
  pendingAuthors: Set<string>;
  persistScheduled: boolean;
}

interface SessionInfo {
  username: string | null;
  role: Role;
  // Which document this connection currently has open, for cross-file
  // presence — null until the client sends its first MESSAGE_PRESENCE.
  viewingDocId: string | null;
  // Awareness client IDs this connection has contributed, keyed by docId —
  // unlike CollabRoom's single shared Awareness (one Set per session), each
  // document here has its own independent Awareness instance (DocRoom.awareness),
  // so a session can hold live state in several of them at once. Populated
  // lazily in handleAwarenessUpdate and consumed in handleClose to remove
  // this connection's states on disconnect. Optional so tests that construct
  // a SessionInfo directly (bypassing handleSession) don't need to know about it.
  awarenessIdsByDoc?: Map<string, Set<number>>;
  // A `?preview=1` pre-join socket (Turnstile-exempt, read-only). Pinned to
  // `viewer` at handshake and kept there for the connection's whole life —
  // without this flag reconcileSessionRoles would re-resolve an anonymous
  // preview socket on a public "anyone can edit" workspace straight to
  // `editor` the next time the owner touched access (MDE-11).
  isPreview?: boolean;
}

function docStorageKey(docId: string, suffix: "update" | "snapshots" | "comments"): string {
  return `doc:${docId}:${suffix}`;
}

// One WorkspaceRoom instance == one shared workspace, addressed by the
// workspace's own client-generated id. Replaces CollabRoom for anything
// inside a shared workspace — every document in the workspace lives in
// this same DO instance instead of getting one of its own, so the whole
// workspace can be live-synced over a single WebSocket connection.
export class WorkspaceRoom {
  state: DurableObjectState;
  env: Env;
  sessions: Map<WebSocket, SessionInfo>;
  docs: Map<string, DocRoom>;
  docIds: string[];
  name: string;
  deleted: boolean;
  repoLinked: boolean;
  // The access record, cached so the synchronous `comments` Y.Map
  // observer can read `owner` for a delete check without an async
  // storage hit. Populated in the constructor and refreshed wherever
  // "access" is written.
  cachedAccess: AccessRecord | null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.docs = new Map();
    this.docIds = [];
    this.name = "";
    this.deleted = false;
    this.repoLinked = false;
    this.cachedAccess = null;

    this.state.blockConcurrencyWhile(async () => {
      const storedDocIds = await this.state.storage.get<string[]>("docs");
      this.docIds = storedDocIds || [];
      for (const docId of this.docIds) {
        await this.loadDocRoom(docId);
      }
      this.name = (await this.state.storage.get<string>("name")) || "";
      this.deleted = (await this.state.storage.get<boolean>("deleted")) === true;
      this.repoLinked = (await this.state.storage.get<boolean>("repoLinked")) === true;
      this.cachedAccess = await this.getAccess();
    });
  }

  // Membership (Task 6) is enforced at the HTTP add/remove-document layer,
  // not here — a message for a docId this instance hasn't seen yet is
  // loaded (and remembered in `docIds`) on first touch rather than
  // dropped, since access control (Task 3, editor-role check) already
  // gates who can write into this workspace's DO at all.
  async loadDocRoom(docId: string): Promise<DocRoom> {
    const existing = this.docs.get(docId);
    if (existing) return existing;

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null);
    const stored = await this.state.storage.get<ArrayBuffer>(docStorageKey(docId, "update"));
    if (stored) Y.applyUpdate(doc, new Uint8Array(stored), "storage");

    const docRoom: DocRoom = {
      doc,
      awareness,
      snapshots: [],
      lastSnapshotAt: undefined,
      pendingAuthors: new Set(),
      persistScheduled: false,
    };
    doc.on("update", (update: Uint8Array, origin: unknown) => this.handleDocUpdate(docId, docRoom, update, origin));
    // Server-side integrity net for the reviewer role (see suggestions.ts's
    // reconcileReviewerDelta): a reviewer's write is allowed to apply
    // (above), but every change it makes must be covered by a suggestions
    // entry — verified here directly from Yjs's own transaction delta
    // rather than trusting the reviewer's client to have created it
    // correctly. `transaction.origin` for a message applied via
    // syncProtocol.readSyncMessage(decoder, encoder, docRoom.doc, ws) is
    // the same `ws` handleAwarenessUpdate already looks up sessions by.
    const ytext = doc.getText("content");
    ytext.observe((event, transaction) => {
      if (transaction.origin === "suggestion") return; // our own reconciliation write — never re-reconcile it
      const session = this.sessions.get(transaction.origin as WebSocket);
      if (!session || session.role !== "reviewer") return;
      reconcileReviewerDelta(doc, event.changes.delta, session.username || "Anonymous");
    });
    // A correctly-behaving reviewer client's own suggestion-map write for
    // an insert ALWAYS arrives as a separate update from the ytext insert
    // itself (y-codemirror.next's ySync plugin and suggestion-editor.ts's
    // suggestionInsertListener each call doc.transact() independently —
    // confirmed live against a real WorkspaceRoom over a real WebSocket,
    // not just in-process). The ytext.observe reconciliation above always
    // sees an insert before that companion write has arrived and
    // auto-wraps it, so the client's own entry lands moments later as a
    // second, overlapping suggestion. Across several rapid keystrokes
    // (typing more than one character), each side's own contiguous-extend
    // logic (recordInsertSuggestion's own "does an existing entry's `to`
    // match this insert's `from`") can independently pick a DIFFERENT one
    // of the two duplicate candidates to extend, so the two entries drift
    // into overlapping-but-not-identical ranges rather than staying exact
    // duplicates — confirmed live typing a multi-character suggestion
    // against a real WorkspaceRoom. Rather than try to make the write
    // atomic (would mean bypassing y-codemirror.next's own ytext sync
    // entirely), self-heal here: whenever the suggestions map changes,
    // collapse any overlapping-or-touching same-kind-same-author entries
    // into one spanning their union — the same merge recordInsertSuggestion
    // already performs for a single, non-racing contiguous extend, just
    // applied after the fact to entries that arrived as separate writes.
    const suggestionsMap = getSuggestionsMap(doc);
    suggestionsMap.observe((event, transaction) => {
      // A non-viewer's in-place `update` to an entry may only append one
      // self-authored reply (D3). Any other change — an edited/removed
      // existing reply, a foreign reply author, or a structural edit to
      // `kind`/`author`/`from`/`to` (re-targeting an entry to self-accept
      // or reclassify it, MDE-06) — is reverted. A brand-new `add` may only
      // be a real, self-authored suggestion with no discussion thread yet
      // (MDE-15). (A `delete` of an entry is handled by
      // enforceReviewerConstraints, not here.)
      if (transaction.origin !== "suggestion") {
        const session = this.sessions.get(transaction.origin as WebSocket);
        if (session && session.role !== "viewer") {
          const actor = session.username ?? "Anonymous";
          const replyReverts: Array<() => void> = [];
          event.changes.keys.forEach((change, key) => {
            if (change.action === "add") {
              if (!isValidNewSuggestionEntry(suggestionsMap.get(key), actor)) replyReverts.push(() => suggestionsMap.delete(key));
              return;
            }
            if (change.action !== "update") return;
            const now = suggestionsMap.get(key);
            const old = change.oldValue as SuggestionEntry;
            if (!now) return;
            const structuralChanged =
              now.kind !== old.kind ||
              now.author !== old.author ||
              JSON.stringify(now.from) !== JSON.stringify(old.from) ||
              JSON.stringify(now.to) !== JSON.stringify(old.to);
            const oldReplies = old.replies ?? [];
            const newReplies = now.replies ?? [];
            const prefixMatches = (n: number) => oldReplies.slice(0, n).every((r, i) => r.author === newReplies[i]?.author && r.body === newReplies[i]?.body);
            const repliesUnchanged = newReplies.length === oldReplies.length && prefixMatches(oldReplies.length);
            const appendedBySelf =
              newReplies.length === oldReplies.length + 1 && prefixMatches(oldReplies.length) && newReplies[newReplies.length - 1]?.author === actor;
            if (structuralChanged || (!repliesUnchanged && !appendedBySelf)) {
              replyReverts.push(() => suggestionsMap.set(key, old));
            }
          });
          if (replyReverts.length) doc.transact(() => replyReverts.forEach((r) => r()), "suggestion");
        }
      }

      const byAuthorKind = new Map<string, ResolvedSuggestion[]>();
      for (const s of listResolvedSuggestions(doc)) {
        const key = `${s.kind}|${s.author}`;
        (byAuthorKind.get(key) ?? byAuthorKind.set(key, []).get(key)!).push(s);
      }
      const idsToDelete: string[] = [];
      const toCreate: {
        kind: "insert" | "delete";
        author: string;
        from: number;
        to: number;
        replies: { id: string; author: string; body: string; createdAt: number }[];
      }[] = [];
      for (const group of byAuthorKind.values()) {
        group.sort((a, b) => a.from - b.from);
        let clusterStart = 0;
        let clusterMaxTo = group[0]!.to;
        for (let i = 1; i <= group.length; i++) {
          const cur = group[i];
          if (cur && cur.from <= clusterMaxTo) {
            clusterMaxTo = Math.max(clusterMaxTo, cur.to);
            continue;
          }
          const cluster = group.slice(clusterStart, i);
          if (cluster.length > 1) {
            idsToDelete.push(...cluster.map((c) => c.id));
            // D3 — carry every merged entry's discussion thread onto the
            // survivor. Dropping them (the pre-1.62.1 behaviour) let a
            // reviewer erase review history with one adjacent keystroke.
            const seen = new Set<string>();
            const replies = cluster
              .flatMap((c) => c.replies ?? [])
              .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
              .sort((a, b) => a.createdAt - b.createdAt);
            toCreate.push({ kind: cluster[0]!.kind, author: cluster[0]!.author, from: cluster[0]!.from, to: clusterMaxTo, replies });
          }
          if (cur) {
            clusterStart = i;
            clusterMaxTo = cur.to;
          }
        }
      }
      if (idsToDelete.length === 0) return;
      doc.transact(() => {
        for (const id of idsToDelete) suggestionsMap.delete(id);
        for (const c of toCreate) {
          if (c.kind === "insert") recordInsertSuggestion(doc, c.from, c.to, c.author);
          else recordDeleteSuggestion(doc, c.from, c.to, c.author);
          if (c.replies.length === 0) continue;
          // Re-attach the aggregated replies to the entry just created for
          // this cluster's range.
          for (const s of listResolvedSuggestions(doc)) {
            if (s.kind !== c.kind || s.author !== c.author || s.from !== c.from || s.to !== c.to) continue;
            const entry = suggestionsMap.get(s.id);
            if (entry) suggestionsMap.set(s.id, { ...entry, replies: c.replies });
            break;
          }
        }
      }, "suggestion");
    });
    // SP-B — comment threads live in a `comments` Y.Map on this doc and
    // ride the same sync/persistence path as ytext and suggestions. This
    // observer is the server-side equivalent of the role/ownership checks
    // the retired HTTP comment endpoints ran: validate every client
    // write and revert (in a "comment-reconcile" transaction the observer
    // itself ignores) anything that breaks the rules.
    const commentsMap = getCommentsMap(doc);
    commentsMap.observe((event, transaction) => {
      if (transaction.origin === "comment-reconcile" || transaction.origin === "comment-migrate") return;
      const session = this.sessions.get(transaction.origin as WebSocket);
      if (!session || session.role === "viewer") return; // isWrite already drops a viewer's write; defensive
      const actor = session.username ?? "Anonymous";
      const owner = this.cachedAccess?.owner ?? null;
      const reverts: Array<() => void> = [];
      event.changes.keys.forEach((change, key) => {
        if (change.action === "add") {
          if (!isValidNewThread(commentsMap.get(key), actor)) reverts.push(() => commentsMap.delete(key));
        } else if (change.action === "update") {
          const old = change.oldValue as CommentThreadEntry;
          if (!isAllowedThreadTransition(old, commentsMap.get(key), actor)) reverts.push(() => commentsMap.set(key, old));
        } else if (change.action === "delete") {
          const old = change.oldValue as CommentThreadEntry;
          if (actor !== old.author && actor !== owner) reverts.push(() => commentsMap.set(key, old));
        }
      });
      if (reverts.length) doc.transact(() => reverts.forEach((r) => r()), "comment-reconcile");
    });
    awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) =>
      this.handleAwarenessUpdate(docId, docRoom, added, updated, removed, origin),
    );
    this.docs.set(docId, docRoom);

    // SP-B one-time migration: legacy HTTP-stored comment threads →
    // this doc's `comments` Y.Map. Runs server-side in the single-
    // threaded DO before any client syncs the doc, so there's no
    // duplicate-seed race. The `commentsMap.size === 0` guard means a
    // doc that's already been migrated (and possibly edited since) is
    // never re-seeded from the stale legacy key. That key is left in
    // place as a backstop — nothing writes it any more; a follow-up
    // release can delete it.
    const legacyComments = await this.state.storage.get<LegacyCommentThread[]>(docStorageKey(docId, "comments"));
    if (legacyComments?.length && getCommentsMap(doc).size === 0) {
      seedCommentThreadsIntoDoc(doc, legacyComments);
    }

    // Deliberately does NOT register `docId` as a workspace member. Loading
    // a doc's room object (to read its comments, its version history, or to
    // apply a migration seed) must not imply the doc belongs to this
    // workspace — a client that opens a brand-new local document
    // immediately fetches `GET /docs/<id>/comments`, and that must not make
    // the empty doc show up in `GET /docs` / other collaborators' doc
    // lists. Membership is established explicitly, in exactly two places:
    // the first real Yjs sync frame for a docId (handleMessage's isNewDoc
    // branch) and the `POST /docs` / `/internal/seed` endpoints.
    return docRoom;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (this.deleted) return new Response("This workspace has been deleted.", { status: 410 });
    if (request.method === "DELETE" && /\/api\/workspace\/[^/]+$/.test(url.pathname)) {
      return this.handleDeleteRequest(request);
    }
    // CV2-5 — check the more specific /access-request routes before the
    // bare /access one (`.endsWith("/access")` is false for these, but
    // keep them grouped).
    const accessRequestActionMatch = url.pathname.match(/\/access-request\/([^/]+)$/);
    if (accessRequestActionMatch) return this.handleAccessRequestAction(request, decodeURIComponent(accessRequestActionMatch[1]!));
    if (url.pathname.endsWith("/access-request")) return this.handleAccessRequestSubmit(request);
    if (url.pathname.endsWith("/join-ticket")) return this.handleJoinTicket(request);
    if (url.pathname.endsWith("/access")) return this.handleAccessRequest(request);
    if (url.pathname.endsWith("/docs")) return this.handleDocsRequest(request);
    if (url.pathname.endsWith("/meta")) return this.handleMetaRequest(request);
    if (url.pathname.endsWith("/internal/seed")) return this.handleInternalSeedRequest(request);

    // (SP-B retired the four /docs/:id/comments* HTTP routes — comment
    // threads now sync as a `comments` Y.Map over the WebSocket.)

    const restoreMatch = url.pathname.match(/\/docs\/([^/]+)\/versions\/([^/]+)\/restore$/);
    if (restoreMatch) return this.handleVersionRestoreRequest(request, restoreMatch[1]!, restoreMatch[2]!);
    const restoreContentMatch = url.pathname.match(/\/docs\/([^/]+)\/versions\/restore-content$/);
    if (restoreContentMatch) return this.handleVersionRestoreContentRequest(request, restoreContentMatch[1]!);
    const versionMatch = url.pathname.match(/\/docs\/([^/]+)\/versions\/([^/]+)$/);
    if (versionMatch) return this.handleVersionContentRequest(request, versionMatch[1]!, versionMatch[2]!);
    const versionsListMatch = url.pathname.match(/\/docs\/([^/]+)\/versions$/);
    if (versionsListMatch) return this.handleVersionsListRequest(request, versionsListMatch[1]!);

    const wikilinkRenameMatch = url.pathname.match(/\/docs\/([^/]+)\/wikilink-rename$/);
    if (wikilinkRenameMatch) return this.handleWikilinkRenameRequest(request, wikilinkRenameMatch[1]!);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    const ticket = await this.requireJoinTicket(request);
    if (!ticket.ok) return new Response(ticket.message, { status: ticket.status });

    // Re-resolve the role against the current access record rather than
    // trusting `auth.role` from before the requireJoinTicket await — the
    // owner may have changed access in that window, and this connection is
    // not yet in `this.sessions` for reconcileSessionRoles to have caught
    // it (MDE-16).
    const freshRole = resolveRole(await this.getAccess(), auth.username);
    if (!freshRole) return new Response("You no longer have access to this workspace.", { status: 403 });

    // `?preview=1` sockets are exempt from the Turnstile challenge
    // (requireJoinTicket returns early) because they are meant to be a
    // read-only pre-join content fetch. Pin them to `viewer` so that
    // exemption can never also hand out write access on a public
    // "anyone can edit" workspace (MDE-01), and remember the pin so
    // reconcileSessionRoles keeps it (MDE-11).
    const isPreview = url.searchParams.get("preview") === "1";
    const effectiveRole: Role = isPreview ? "viewer" : freshRole;

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.handleSession(server, auth.username, effectiveRole, isPreview);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Placeholder until Task 3 replaces it — every connection is treated as
  // an editor with no identity check, so this task's sync/awareness
  // plumbing can be built and tested in isolation from access control.
  // ---------- Access control ----------

  async getAccess(): Promise<AccessRecord> {
    const stored = await this.state.storage.get<Record<string, unknown>>("access");
    if (!stored) return { ...DEFAULT_ACCESS };
    const rawInvited = Array.isArray(stored.invited) ? stored.invited : [];
    const invited: InvitedPerson[] = rawInvited.map((entry) => (typeof entry === "string" ? { username: entry, role: "editor" } : (entry as InvitedPerson)));
    return { ...DEFAULT_ACCESS, ...stored, invited } as AccessRecord;
  }

  // CV2-5 — pending "request edit access" entries, stored separately from
  // the access record so the roster-editing path (PUT /access) and the
  // request flow never entangle.
  async getAccessRequests(): Promise<AccessRequest[]> {
    const stored = await this.state.storage.get<AccessRequest[]>("accessRequests");
    return Array.isArray(stored) ? stored : [];
  }

  async getSession(request: Request) {
    const cookie = getCookie(request, SESSION_COOKIE);
    if (!cookie) return null;
    return decryptSession(this.env, cookie);
  }

  private workspaceIdFromUrl(url: URL): string {
    return url.pathname.match(/^\/api\/workspace\/([A-Za-z0-9_-]{1,128})(?:\/|$)/)?.[1] ?? "";
  }

  // Turnstile — verify a widget token with Cloudflare and mint a
  // short-lived, workspace-scoped join ticket the client puts on the WS
  // upgrade URL. A no-op ({ enabled: false }) when TURNSTILE_SECRET_KEY
  // isn't configured; { skip: true } for a signed-in visitor (the ticket
  // gate in authorize() only bites anonymous connections).
  async handleJoinTicket(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
    const secret = this.env.TURNSTILE_SECRET_KEY;
    if (!secret) return Response.json({ enabled: false });

    const session = await this.getSession(request);
    if (session?.username) return Response.json({ skip: true });

    let body: { token?: unknown };
    try {
      body = (await request.json()) as { token?: unknown };
    } catch {
      return Response.json({ error: "bad-request" }, { status: 400 });
    }
    if (typeof body.token !== "string" || !body.token) {
      return Response.json({ error: "bad-request" }, { status: 400 });
    }

    const ok = await verifyTurnstileToken(body.token, request.headers.get("CF-Connecting-IP"), secret);
    if (!ok) return Response.json({ error: "turnstile-failed" }, { status: 403 });

    const wsId = this.workspaceIdFromUrl(new URL(request.url));
    const ticket = await mintJoinTicket(wsId, this.env.SESSION_SECRET, Date.now());
    return Response.json({ ticket });
  }

  async authorize(request: Request): Promise<{ ok: true; username: string | null; role: Role } | { ok: false; status: number; message: string }> {
    const session = await this.getSession(request);
    const access = await this.getAccess();
    if (!access.owner) {
      return { ok: false, status: 403, message: "This workspace hasn't been shared." };
    }
    const role = resolveRole(access, session?.username ?? null);
    if (!role) {
      if (!session || !session.username) {
        return { ok: false, status: 401, message: "Sign in with GitHub to join this workspace." };
      }
      return { ok: false, status: 403, message: "You don't have access to this workspace." };
    }
    return { ok: true, username: session?.username ?? null, role };
  }

  // Turnstile enforcement — the live-sync boundary only. An anonymous
  // connection to an "anyone with the link" room must carry a valid join
  // ticket on the WS-upgrade URL when TURNSTILE_SECRET_KEY is configured.
  // Deliberately NOT part of authorize(): the read-only pre-join HTTP
  // fetches (GET /access, GET /docs, GET /meta) call authorize() too and
  // must stay reachable without a challenge (see the design's non-goals).
  // Signed-in users, requireAccount links (which force a session) and
  // restricted links (no anon role at all) never reach a failing check.
  async requireJoinTicket(request: Request): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
    if (!this.env.TURNSTILE_SECRET_KEY) return { ok: true };
    const url = new URL(request.url);
    // `?preview=1` — the client's throwaway pre-join sync socket
    // (fetchRemoteDocContent), which downloads a doc's current text to
    // populate the Join prompt before the visitor has decided to join.
    // Read-only and explicitly out of scope for the challenge (design
    // non-goals): gate only the real live-sync connection.
    if (url.searchParams.get("preview") === "1") return { ok: true };
    const session = await this.getSession(request);
    if (session?.username) return { ok: true };
    const access = await this.getAccess();
    if (access.generalAccess !== "anyone") return { ok: true };
    const wsId = this.workspaceIdFromUrl(url);
    const ok = await verifyJoinTicket(url.searchParams.get("ticket"), wsId, this.env.SESSION_SECRET, Date.now());
    return ok ? { ok: true } : { ok: false, status: 401, message: "turnstile-required" };
  }

  async handleAccessRequest(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const access = await this.getAccess();
      // Readable without authorization on purpose (the join flow needs it
      // before the visitor has any access), but only participants see the
      // roster — see access-visibility.ts.
      const auth = await this.authorize(request);
      const body = auth.ok ? access : redactAccessForOutsider(access);
      // CV2-5 — the pending-request roster (usernames + free-text notes)
      // is the owner's alone; an authed non-owner learns only whether
      // *they* have a request in flight; an outsider learns nothing.
      const extra: Record<string, unknown> = {};
      if (auth.ok && auth.username && auth.username === access.owner) {
        extra.accessRequests = await this.getAccessRequests();
      } else if (auth.ok && auth.username) {
        const requests = await this.getAccessRequests();
        extra.myAccessRequestPending = requests.some((r) => r.username === auth.username);
      }
      return Response.json({ ...body, ...extra, workspaceName: this.name });
    }
    if (request.method === "PUT") {
      let body: { generalAccess?: unknown; requireAccount?: unknown; role?: unknown; invited?: unknown };
      try {
        body = await request.json();
      } catch (err) {
        return new Response("Invalid JSON.", { status: 400 });
      }

      const session = await this.getSession(request);
      if (!session || !session.username) return new Response("Sign in with GitHub first.", { status: 401 });

      const access = await this.getAccess();
      if (access.owner && access.owner !== session.username) {
        return new Response("Only the owner can change access.", { status: 403 });
      }

      const next: AccessRecord = {
        owner: access.owner || session.username,
        generalAccess: body.generalAccess === "anyone" ? "anyone" : "restricted",
        requireAccount: body.requireAccount === true,
        role: (["viewer", "reviewer", "editor"] as const).includes(body.role as Role) ? (body.role as Role) : "viewer",
        invited: Array.isArray(body.invited) ? normalizeInvited(body.invited) : access.invited,
      };
      await this.state.storage.put("access", next);
      this.cachedAccess = next;
      this.reconcileSessionRoles(next);
      this.broadcastAccessChanged();
      return Response.json(next);
    }
    return new Response("Method not allowed", { status: 405 });
  }

  // Re-resolve every live WebSocket session's role against a just-written
  // access record, so a downgrade or revocation takes effect immediately
  // rather than only on the client's voluntary rejoin (MDE-02). A client
  // that ignores MESSAGE_ACCESS_CHANGED can otherwise keep writing with
  // its stale in-memory role until the socket drops.
  reconcileSessionRoles(next: AccessRecord): void {
    for (const [ws, session] of Array.from(this.sessions.entries())) {
      const resolved = resolveRole(next, session.username);
      // A preview socket that still has *some* access stays pinned to
      // viewer (MDE-11); one that lost all access is closed like any other.
      const role = resolved && session.isPreview ? "viewer" : resolved;
      if (!role) {
        try {
          ws.close(4403, "Access revoked");
        } catch {
          /* already closed */
        }
        this.sessions.delete(ws);
      } else {
        session.role = role;
      }
    }
  }

  broadcastAccessChanged(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_ACCESS_CHANGED);
    this.broadcast(encoding.toUint8Array(encoder), null);
  }

  // CV2-5 — the owner approves or denies a pending request.
  async handleAccessRequestAction(request: Request, username: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const session = await this.getSession(request);
    const access = await this.getAccess();
    if (!session?.username || session.username !== access.owner) {
      return new Response("Only the owner can respond to access requests.", { status: 403 });
    }
    let body: { action?: unknown; role?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      body = {};
    }
    const action = body.action === "approve" ? "approve" : body.action === "deny" ? "deny" : null;
    if (!action) return new Response("action must be 'approve' or 'deny'.", { status: 400 });

    const requests = await this.getAccessRequests();
    if (!requests.some((r) => r.username === username)) return new Response("No such pending request.", { status: 404 });
    await this.state.storage.put(
      "accessRequests",
      requests.filter((r) => r.username !== username),
    );

    if (action === "approve") {
      const role: Role = (["viewer", "reviewer", "editor"] as const).includes(body.role as Role) ? (body.role as Role) : "editor";
      const invited = access.invited.filter((p) => p.username !== username);
      invited.push({ username, role });
      await this.state.storage.put("access", { ...access, invited });
      this.cachedAccess = await this.getAccess();
      this.reconcileSessionRoles(this.cachedAccess);
    }
    this.broadcastAccessChanged();
    return Response.json({ ok: true });
  }

  // CV2-5 — a joined viewer/reviewer asks the owner for edit access.
  async handleAccessRequestSubmit(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    // authorize() returns role "editor" for the owner too — both hit this.
    if (auth.role === "editor") return new Response("You already have edit access.", { status: 400 });
    if (!auth.username) return new Response("Sign in with GitHub first.", { status: 401 });

    let body: { message?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      body = {};
    }
    const message = (typeof body.message === "string" ? body.message : "").trim().slice(0, 500);

    const requests = await this.getAccessRequests();
    const next = requests.filter((r) => r.username !== auth.username);
    next.push({ username: auth.username, message, createdAt: Date.now() });
    await this.state.storage.put("accessRequests", next);

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_ACCESS_REQUEST);
    encoding.writeVarString(encoder, auth.username);
    encoding.writeVarString(encoder, message);
    this.broadcast(encoding.toUint8Array(encoder), null);

    return Response.json({ ok: true });
  }

  encodeWorkspaceMeta(): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_WORKSPACE_META);
    encoding.writeVarString(encoder, this.name);
    encoding.writeVarUint(encoder, this.docIds.length);
    for (const id of this.docIds) encoding.writeVarString(encoder, id);
    // Trailing field — an older client stops reading before it (harmless);
    // a newer client guards the read with decoding.hasContent().
    encoding.writeVarUint(encoder, this.repoLinked ? 1 : 0);
    return encoding.toUint8Array(encoder);
  }

  broadcastWorkspaceMeta(): void {
    this.broadcast(this.encodeWorkspaceMeta(), null);
  }

  async handleMetaRequest(request: Request): Promise<Response> {
    if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    // Workspace name + repo-link state are owner-managed config, like the
    // access record — not per-collaborator. Gating to `editor` let a
    // non-owner editor (and, on a public "anyone can edit" link, an
    // anonymous visitor) rename the workspace and spoof repoLinked (MDE-10).
    const access = await this.getAccess();
    if (!auth.username || auth.username !== access.owner) {
      return new Response("Only the workspace owner can change workspace metadata.", { status: 403 });
    }
    let body: { name?: unknown; repoLinked?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const hasName = typeof body.name === "string";
    const hasRepoLinked = typeof body.repoLinked === "boolean";
    if (!hasName && !hasRepoLinked) return new Response("Nothing to update.", { status: 400 });

    if (hasName) {
      this.name = body.name as string;
      await this.state.storage.put("name", this.name);
    }
    if (hasRepoLinked) {
      this.repoLinked = body.repoLinked as boolean;
      await this.state.storage.put("repoLinked", this.repoLinked);
    }
    this.broadcastWorkspaceMeta();
    return Response.json({ name: this.name, repoLinked: this.repoLinked });
  }

  // Owner-only hard revoke. Sets a persisted `deleted` tombstone (a DO
  // can't delete itself, so any later request re-reads it and 410s), tells
  // every live session, closes them, and wipes the rest of storage.
  async handleDeleteRequest(request: Request): Promise<Response> {
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    const access = await this.getAccess();
    if (!access.owner || access.owner !== auth.username) {
      return new Response("Only the workspace owner can delete it.", { status: 403 });
    }

    this.deleted = true;
    await this.state.storage.put("deleted", true);

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_WORKSPACE_DELETED);
    this.broadcast(encoding.toUint8Array(encoder), null);
    for (const ws of Array.from(this.sessions.keys())) {
      try {
        ws.close(1000, "workspace deleted");
      } catch {
        /* already closed */
      }
    }
    this.sessions.clear();

    // Cancel any pending debounced persist and drop the in-memory rooms —
    // otherwise a persist alarm scheduled seconds earlier fires after
    // deleteAll() and writes every doc's CRDT state back into storage
    // (MDE-08). alarm()/persistAllNow() also bail on `this.deleted` as a
    // backstop.
    await this.state.storage.deleteAlarm();
    this.docs.clear();

    await this.state.storage.deleteAll();
    await this.state.storage.put("deleted", true);
    return new Response(null, { status: 204 });
  }

  // ---------- WebSocket session ----------

  handleSession(ws: WebSocket, username: string | null, role: Role, isPreview = false): void {
    ws.accept();
    this.sessions.set(ws, { username, role, viewingDocId: null, isPreview });

    for (const docId of this.docIds) {
      const docRoom = this.docs.get(docId);
      if (!docRoom) continue;
      const syncEncoder = encoding.createEncoder();
      encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
      encoding.writeVarString(syncEncoder, docId);
      syncProtocol.writeSyncStep1(syncEncoder, docRoom.doc);
      ws.send(encoding.toUint8Array(syncEncoder));

      const states = docRoom.awareness.getStates();
      if (states.size > 0) {
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
        encoding.writeVarString(awarenessEncoder, docId);
        encoding.writeVarUint8Array(awarenessEncoder, awarenessProtocol.encodeAwarenessUpdate(docRoom.awareness, Array.from(states.keys())));
        ws.send(encoding.toUint8Array(awarenessEncoder));
      }
    }
    ws.send(this.encodeWorkspaceMeta());

    ws.addEventListener("message", (event: MessageEvent) => this.handleMessage(ws, event.data));
    ws.addEventListener("close", () => this.handleClose(ws));
    ws.addEventListener("error", () => this.handleClose(ws));
  }

  // Returns its promise (rather than firing-and-forgetting internally) so
  // callers that need the doc-load to have actually landed — tests, and
  // Task 8's migration seeding — can await it. The real WebSocket
  // `addEventListener("message", ...)` path below doesn't await it either
  // way, same as a DOM event handler never awaits a listener's return value.
  async handleMessage(ws: WebSocket, data: unknown): Promise<void> {
    if (typeof data === "string") return;
    const session = this.sessions.get(ws);
    const decoder = decoding.createDecoder(new Uint8Array(data as ArrayBuffer));
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_PRESENCE) {
      const viewingDocId = decoding.readVarString(decoder);
      if (session) session.viewingDocId = viewingDocId || null;
      this.broadcastPresence(ws, session);
      return;
    }

    const docId = decoding.readVarString(decoder);

    if (messageType === MESSAGE_SYNC) {
      const savedPos = decoder.pos;
      const syncType = decoding.readVarUint(decoder);
      decoder.pos = savedPos;

      const isWrite = syncType === SYNC_STEP2 || syncType === SYNC_UPDATE;
      if (isWrite && session && session.role === "viewer") return; // read-only: drop silently
      // A reviewer's write is now allowed to apply (both ytext and the
      // suggestions map need to sync — a reviewer must be able to
      // actually type); loadDocRoom's ytext.observe hook independently
      // verifies every reviewer-authored change lands with a suggestion
      // entry covering it, auto-wrapping one if a client fails to.

      // First Yjs sync frame for a docId this instance has never seen:
      // this is the one signal that establishes the doc as a member of
      // this workspace (loadDocRoom no longer does — see its comment).
      // Captured before withDocRoom loads the room so the reciprocal-step1
      // logic below, and the registration after, both key off it.
      const isNewDoc = !this.docIds.includes(docId);

      await this.withDocRoom(docId, (docRoom) => {
        // A reviewer's write is allowed to apply (they must be able to
        // type suggestions), but the server then enforces that they only
        // *proposed* changes — see enforceReviewerConstraints (MDE-05/06).
        const reviewerPre = session?.role === "reviewer" ? this.captureReviewerPreState(docRoom.doc, session.username ?? "Anonymous") : null;

        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        encoding.writeVarString(encoder, docId);
        // The docId prefix's own encoded length varies with the string, so
        // "was anything appended" has to be measured from this baseline —
        // a fixed byte-count threshold (as CollabRoom's single-doc version
        // uses, where the prefix is always exactly 1 byte) would either
        // under- or over-fire depending on docId length.
        const baseLength = encoding.length(encoder);
        syncProtocol.readSyncMessage(decoder, encoder, docRoom.doc, ws);
        if (encoding.length(encoder) > baseLength) ws.send(encoding.toUint8Array(encoder));

        if (reviewerPre) this.enforceReviewerConstraints(docRoom.doc, reviewerPre);

        // Step1 only pulls the RECIPIENT's content down to the sender —
        // it never pushes the sender's own content anywhere. CollabRoom's
        // single-document model got a full bidirectional handshake for
        // free because its one Y.Doc object always "exists" and
        // handleSession unconditionally step1's it to every new
        // connection; a lazily-created doc room here has no such moment,
        // since it isn't registered until THIS message arrives — one
        // message too late for that per-connection loop to have included
        // it. Without this, a freshly-seeded client's content (see
        // collab.ts's seedDocBindingFromEditor) would never actually
        // reach the server: the client only ever gets asked what it's
        // missing, never asked what it has. Sent as its own frame, not
        // appended to the reply above — one sync sub-message per frame is
        // the wire format both sides expect.
        if (isNewDoc) {
          const step1Encoder = encoding.createEncoder();
          encoding.writeVarUint(step1Encoder, MESSAGE_SYNC);
          encoding.writeVarString(step1Encoder, docId);
          syncProtocol.writeSyncStep1(step1Encoder, docRoom.doc);
          ws.send(encoding.toUint8Array(step1Encoder));
        }
      });

      if (isNewDoc && !this.docIds.includes(docId)) {
        this.docIds.push(docId);
        await this.state.storage.put("docs", this.docIds);
      }
    } else if (messageType === MESSAGE_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      await this.withDocRoom(docId, (docRoom) => {
        awarenessProtocol.applyAwarenessUpdate(docRoom.awareness, update, ws);
      });
    }
  }

  async withDocRoom(docId: string, fn: (docRoom: DocRoom) => void): Promise<void> {
    const docRoom = await this.loadDocRoom(docId);
    fn(docRoom);
  }

  // Snapshot the state a reviewer's incoming sync frame will be validated
  // against — the document text, the reviewer's own pending insert
  // suggestion ranges (the only text they may delete), and a copy of the
  // suggestions map (to detect a deleted/mutated entry).
  private captureReviewerPreState(doc: Y.Doc, username: string) {
    const ownInsertRanges: Array<[number, number]> = [];
    for (const s of listResolvedSuggestions(doc)) {
      if (s.kind === "insert" && s.author === username) ownInsertRanges.push([s.from, s.to]);
    }
    return {
      username,
      text: doc.getText("content").toString(),
      ownInsertRanges,
      entriesById: new Map<string, SuggestionEntry>(getSuggestionsMap(doc).entries()),
    };
  }

  // Runs right after a reviewer's sync update applied. Repairs, in one
  // "suggestion"-origin transaction the observers skip:
  //  - any committed ytext run the reviewer deleted (MDE-05);
  //  - a suggestion entry the reviewer deleted that isn't a genuine
  //    withdraw — another author's entry, or their own INSERT entry whose
  //    text is still present (a unilateral self-accept) (MDE-06).
  // (An in-place kind/author/range edit arrives as an `update` and is
  // reverted by the suggestions observer's guard, not here.)
  private enforceReviewerConstraints(doc: Y.Doc, pre: ReturnType<WorkspaceRoom["captureReviewerPreState"]>): void {
    const ytext = doc.getText("content");
    const committedBefore = removeRanges(pre.text, pre.ownInsertRanges);
    const textRepairs = reviewerTextRepairs(committedBefore, ytext.toString());

    const map = getSuggestionsMap(doc);
    const entryReverts: Array<() => void> = [];
    for (const [id, old] of pre.entriesById) {
      if (map.has(id)) continue; // not deleted this transaction
      if (old.author !== pre.username) {
        entryReverts.push(() => map.set(id, old)); // not yours to discard
        continue;
      }
      if (old.kind === "delete") continue; // withdrawing a proposed deletion — no text implication
      // own insert entry deleted — a genuine withdraw also removes the
      // entry's text, collapsing its relative positions. If the anchored
      // span still resolves to live text, the text is still there and this
      // was a unilateral self-accept (MDE-06) — revert.
      const from = toAbsoluteIndex(doc, ytext, old.from);
      const to = toAbsoluteIndex(doc, ytext, old.to);
      if (from !== null && to !== null && to > from) entryReverts.push(() => map.set(id, old));
    }

    if (textRepairs.length === 0 && entryReverts.length === 0) return;
    doc.transact(() => {
      for (const r of [...textRepairs].sort((a, b) => b.at - a.at)) ytext.insert(r.at, r.text);
      for (const revert of entryReverts) revert();
    }, "suggestion");
  }

  broadcastPresence(exceptWs: WebSocket, session: SessionInfo | undefined): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_PRESENCE);
    encoding.writeVarString(encoder, session?.username || "");
    encoding.writeVarString(encoder, session?.viewingDocId || "");
    const message = encoding.toUint8Array(encoder);
    for (const ws of this.sessions.keys()) {
      if (ws === exceptWs) continue;
      try {
        ws.send(message);
      } catch (err) {
        this.sessions.delete(ws);
      }
    }
  }

  handleClose(ws: WebSocket): void {
    const session = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (session?.awarenessIdsByDoc) {
      for (const [docId, ids] of session.awarenessIdsByDoc) {
        if (ids.size === 0) continue;
        const docRoom = this.docs.get(docId);
        if (docRoom) awarenessProtocol.removeAwarenessStates(docRoom.awareness, Array.from(ids), null);
      }
    }
    if (session) this.broadcastPresence(ws, { ...session, viewingDocId: null, username: session.username });
    if (this.sessions.size === 0) this.persistAllNow();
  }

  handleDocUpdate(docId: string, docRoom: DocRoom, update: Uint8Array, origin: unknown): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    encoding.writeVarString(encoder, docId);
    syncProtocol.writeUpdate(encoder, update);
    this.broadcast(encoding.toUint8Array(encoder), origin);
    if (origin === "storage") return;
    // `origin` is the editing client's WebSocket for a real edit (and the
    // string "restore" for a restore, which isn't a sessions key).
    const editor = this.sessions.get(origin as WebSocket);
    if (editor?.username) docRoom.pendingAuthors.add(editor.username);
    this.schedulePersist(docId, docRoom);
    if (origin !== "restore") void this.maybeSnapshot(docId, docRoom);
  }

  handleAwarenessUpdate(docId: string, docRoom: DocRoom, added: number[], updated: number[], removed: number[], origin: unknown): void {
    const changed = added.concat(updated, removed);
    // A direct Map lookup rather than `origin instanceof WebSocket` — the
    // latter depends on a real global WebSocket constructor (absent in the
    // plain-Node unit test environment, and unnecessary here regardless:
    // this.sessions.get() already returns undefined for any key it doesn't
    // hold, including the "storage"/"restore"/null origins used elsewhere).
    const session = this.sessions.get(origin as WebSocket);
    if (session) {
      if (!session.awarenessIdsByDoc) session.awarenessIdsByDoc = new Map();
      let ids = session.awarenessIdsByDoc.get(docId);
      if (!ids) {
        ids = new Set();
        session.awarenessIdsByDoc.set(docId, ids);
      }
      added.concat(updated).forEach((id) => ids!.add(id));
      removed.forEach((id) => ids!.delete(id));
    }
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarString(encoder, docId);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(docRoom.awareness, changed));
    this.broadcast(encoding.toUint8Array(encoder), origin);
  }

  broadcast(message: Uint8Array, exceptWs: unknown): void {
    for (const ws of this.sessions.keys()) {
      if (ws === exceptWs) continue;
      try {
        ws.send(message);
      } catch (err) {
        this.sessions.delete(ws);
      }
    }
  }

  async schedulePersist(docId: string, docRoom: DocRoom): Promise<void> {
    if (docRoom.persistScheduled) return;
    docRoom.persistScheduled = true;
    await this.state.storage.setAlarm(Date.now() + PERSIST_DELAY_MS);
  }

  async alarm(): Promise<void> {
    if (this.deleted) return;
    await this.persistAllNow();
  }

  async persistAllNow(): Promise<void> {
    if (this.deleted) return; // a persist scheduled just before DELETE must not rewrite wiped storage (MDE-08)
    for (const [docId, docRoom] of this.docs.entries()) {
      if (!docRoom.persistScheduled && this.sessions.size > 0) continue;
      docRoom.persistScheduled = false;
      await this.state.storage.put(docStorageKey(docId, "update"), Y.encodeStateAsUpdate(docRoom.doc));
    }
  }

  // ---------- Version snapshots ----------

  async getSnapshots(docId: string): Promise<Snapshot[]> {
    const stored = await this.state.storage.get<Snapshot[]>(docStorageKey(docId, "snapshots"));
    return stored || [];
  }

  imagesFromDoc(docRoom: DocRoom): Record<string, string> | undefined {
    const map = docRoom.doc.getMap<string>("images");
    return map.size > 0 ? (Object.fromEntries(map.entries()) as Record<string, string>) : undefined;
  }

  async maybeSnapshot(docId: string, docRoom: DocRoom, now: number = Date.now()): Promise<void> {
    // Fired fire-and-forget from handleDocUpdate, it yields at getSnapshots
    // below. If DELETE /workspace's deleteAll() lands during that yield,
    // the put() further down would resurrect doc:*:snapshots into wiped
    // storage — guard both the entry and the write (MDE-14, same class as
    // MDE-08's persist guards).
    if (this.deleted) return;
    const SNAPSHOT_INTERVAL_MS = 30 * 1000;
    if (docRoom.lastSnapshotAt !== undefined && now - docRoom.lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
    const content = docRoom.doc.getText("content").toString();
    let snapshots = await this.getSnapshots(docId);
    const last = snapshots[snapshots.length - 1];
    if (last && last.content === content) {
      docRoom.lastSnapshotAt = last.timestamp;
      return;
    }
    if (last) {
      const groups = groupSnapshotsIntoSessions(snapshots);
      const lastGroup = groups[groups.length - 1]!;
      if (now - lastGroup.endTimestamp > SESSION_GAP_MS && lastGroup.entries.length > 1) {
        const idsToKeep = new Set(snapshots.map((s) => s.id));
        for (const entry of lastGroup.entries.slice(0, -1)) idsToKeep.delete(entry.id);
        snapshots = snapshots.filter((s) => idsToKeep.has(s.id));
      }
    }
    const authors = [...docRoom.pendingAuthors];
    snapshots.push({ id: uid(), timestamp: now, content, images: this.imagesFromDoc(docRoom), authors: authors.length ? authors : undefined });
    while (snapshots.length > 300) snapshots.shift();
    if (this.deleted) return; // re-check after the getSnapshots yield (MDE-14)
    await this.state.storage.put(docStorageKey(docId, "snapshots"), snapshots);
    docRoom.lastSnapshotAt = now;
    docRoom.pendingAuthors.clear();
  }

  async forceSnapshot(docId: string, docRoom: DocRoom, content: string, now: number = Date.now(), author?: string): Promise<Snapshot> {
    const snapshots = await this.getSnapshots(docId);
    const snap: Snapshot = { id: uid(), timestamp: now, content, images: this.imagesFromDoc(docRoom), authors: author ? [author] : undefined };
    snapshots.push(snap);
    while (snapshots.length > 50) snapshots.shift();
    await this.state.storage.put(docStorageKey(docId, "snapshots"), snapshots);
    docRoom.lastSnapshotAt = now;
    docRoom.pendingAuthors.clear();
    return snap;
  }

  async handleVersionsListRequest(request: Request, docId: string): Promise<Response> {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    const snapshots = await this.getSnapshots(docId);
    const list = snapshots.map((s) => ({ id: s.id, timestamp: s.timestamp, authors: s.authors ?? [] })).reverse();
    return Response.json(list);
  }

  async handleVersionContentRequest(request: Request, docId: string, versionId: string): Promise<Response> {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    const snapshots = await this.getSnapshots(docId);
    const snap = snapshots.find((s) => s.id === versionId);
    if (!snap) return new Response("Version not found.", { status: 404 });
    return Response.json(snap);
  }

  async handleVersionRestoreRequest(request: Request, docId: string, versionId: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role !== "editor") return new Response("Only an editor can restore a version.", { status: 403 });
    const snapshots = await this.getSnapshots(docId);
    const snap = snapshots.find((s) => s.id === versionId);
    if (!snap) return new Response("Version not found.", { status: 404 });

    const docRoom = await this.loadDocRoom(docId);
    const text = docRoom.doc.getText("content");
    docRoom.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, snap.content);
      const imagesMap = docRoom.doc.getMap<string>("images");
      for (const key of Array.from(imagesMap.keys())) imagesMap.delete(key);
      if (snap.images) {
        for (const [key, value] of Object.entries(snap.images)) imagesMap.set(key, value);
      }
    }, "restore");
    const created = await this.forceSnapshot(docId, docRoom, snap.content, Date.now(), auth.username ?? undefined);
    return Response.json(created);
  }

  // Same as handleVersionRestoreRequest above, but for content that
  // didn't come from an existing tracked snapshot (e.g. fetched fresh
  // from a repo commit) — takes the content directly instead of
  // looking it up by versionId.
  async handleVersionRestoreContentRequest(request: Request, docId: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role !== "editor") return new Response("Only an editor can restore a version.", { status: 403 });
    let body: { content?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const content = typeof body.content === "string" ? body.content : undefined;
    if (content === undefined) return new Response("content is required.", { status: 400 });

    const docRoom = await this.loadDocRoom(docId);
    const text = docRoom.doc.getText("content");
    docRoom.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, content);
    }, "restore");
    const created = await this.forceSnapshot(docId, docRoom, content, Date.now(), auth.username ?? undefined);
    return Response.json(created);
  }

  // Rewrites [[oldName]] -> [[newName]] wherever it appears in this
  // document's live content, computed against the DO's own authoritative
  // text — never trusts a client-supplied "new content" wholesale, since
  // the requesting client's own cached copy of a document it isn't
  // actively viewing can be stale. Best-effort from the caller's
  // perspective: a 403 here just means the cascade skips this one
  // document rather than failing the whole rename. Uses a distinct
  // transact origin (not "restore") so the ordinary maybeSnapshot capture
  // in handleDocUpdate still applies — this is a normal edit, not a
  // version restore, so it shouldn't force an immediate snapshot.
  async handleWikilinkRenameRequest(request: Request, docId: string): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });
    if (auth.role !== "editor") return new Response("Only an editor can update links in this document.", { status: 403 });

    let body: { oldName?: unknown; newName?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      return new Response("Invalid JSON.", { status: 400 });
    }
    const oldName = typeof body.oldName === "string" ? body.oldName : undefined;
    const newName = typeof body.newName === "string" ? body.newName : undefined;
    if (!oldName || !newName) return new Response("oldName and newName are required.", { status: 400 });

    const docRoom = await this.loadDocRoom(docId);
    const text = docRoom.doc.getText("content");
    const current = text.toString();
    const rewritten = rewriteWikilinkReferences(current, oldName, newName);
    if (rewritten === current) return Response.json({ changed: false });

    docRoom.doc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, rewritten);
    }, "wikilink-rename");
    return Response.json({ changed: true });
  }

  // ---------- Document membership ----------

  async handleDocsRequest(request: Request): Promise<Response> {
    const auth = await this.authorize(request);
    if (!auth.ok) return new Response(auth.message, { status: auth.status });

    if (request.method === "GET") return Response.json(this.docIds);

    if (request.method === "POST") {
      if (auth.role !== "editor") return new Response("Only an editor can add a document.", { status: 403 });
      let body: { docId?: unknown };
      try {
        body = await request.json();
      } catch (err) {
        return new Response("Invalid JSON.", { status: 400 });
      }
      if (typeof body.docId !== "string" || !body.docId) return new Response("Invalid docId.", { status: 400 });
      if (!this.docIds.includes(body.docId)) {
        this.docIds = [...this.docIds, body.docId];
        await this.state.storage.put("docs", this.docIds);
        await this.loadDocRoom(body.docId);
      }
      return Response.json(this.docIds);
    }

    if (request.method === "DELETE") {
      if (auth.role !== "editor") return new Response("Only an editor can remove a document.", { status: 403 });
      const docId = new URL(request.url).searchParams.get("docId");
      if (!docId) return new Response("Missing docId.", { status: 400 });
      this.docIds = this.docIds.filter((id) => id !== docId);
      await this.state.storage.put("docs", this.docIds);
      this.docs.delete(docId);
      await this.state.storage.delete([docStorageKey(docId, "update"), docStorageKey(docId, "snapshots"), docStorageKey(docId, "comments")]);
      this.broadcastWorkspaceMeta();
      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  }

  // ---------- Internal: seeding from a CollabRoom migration ----------
  // Not part of the public API surface — only ever called by
  // CollabRoom.handleMigrateRequest's own internal fetch(), never reachable
  // from worker.ts's routing (see src/worker.ts's WORKSPACE_* patterns,
  // none of which match "/internal/...").
  async handleInternalSeedRequest(request: Request): Promise<Response> {
    let body: { docId?: unknown; docName?: unknown; update?: unknown; access?: unknown; snapshots?: unknown; comments?: unknown };
    try {
      body = await request.json();
    } catch (err) {
      return new Response("Invalid JSON.", { status: 400 });
    }
    if (typeof body.docId !== "string" || !Array.isArray(body.update)) {
      return new Response("Invalid seed payload.", { status: 400 });
    }
    const docId = body.docId;
    const docName = typeof body.docName === "string" ? body.docName.trim() : "";

    if (body.access) {
      await this.state.storage.put("access", body.access);
      this.cachedAccess = await this.getAccess();
    }

    // A legacy /d/ migration: name the fresh workspace after its one
    // document (the CollabRoom had no workspace concept), so joiners don't
    // fall back to the literal "Shared workspace". Only when we actually
    // have a name and this workspace hasn't been named some other way.
    if (docName && !this.name) {
      this.name = docName;
      await this.state.storage.put("name", this.name);
    }

    const docRoom = await this.loadDocRoom(docId);
    docRoom.doc.transact(() => Y.applyUpdate(docRoom.doc, new Uint8Array(body.update as number[]), "storage"), "storage");
    // Seed the document's own name into its Y.Doc meta map if the migrated
    // update didn't already carry one (older CollabRooms never wrote it) —
    // the client's fetchRemoteDocContent reads meta.name and otherwise
    // shows "Shared document".
    if (docName && !docRoom.doc.getMap<string>("meta").get("name")) {
      docRoom.doc.transact(() => docRoom.doc.getMap<string>("meta").set("name", docName), "storage");
    }
    if (Array.isArray(body.snapshots)) {
      docRoom.snapshots = body.snapshots as Snapshot[];
      await this.state.storage.put(docStorageKey(docId, "snapshots"), body.snapshots);
    }
    // A legacy CollabRoom migration carries its HTTP comment threads —
    // seed them straight into the doc's `comments` Y.Map (same as
    // loadDocRoom's one-time migration). Guarded so a re-seed can't
    // clobber a map that already has threads.
    if (Array.isArray(body.comments) && body.comments.length > 0 && getCommentsMap(docRoom.doc).size === 0) {
      seedCommentThreadsIntoDoc(docRoom.doc, body.comments as LegacyCommentThread[]);
    }

    if (!this.docIds.includes(docId)) {
      this.docIds = [...this.docIds, docId];
      await this.state.storage.put("docs", this.docIds);
    }
    await this.state.storage.put(docStorageKey(docId, "update"), Y.encodeStateAsUpdate(docRoom.doc));

    return new Response(null, { status: 204 });
  }
}
