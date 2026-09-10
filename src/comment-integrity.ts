import type { CommentThreadEntry, Reply } from "./comments-doc";

// Pure validators for the WorkspaceRoom `comments` Y.Map observer — the
// server-side equivalent of the role/ownership checks the retired HTTP
// comment endpoints ran. Server-only; not hand-synced.

function replyEqual(a: Reply, b: Reply): boolean {
  return a.id === b.id && a.author === b.author && a.body === b.body && a.createdAt === b.createdAt;
}

function repliesEqual(a: Reply[], b: Reply[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || !replyEqual(x, y)) return false;
  }
  return true;
}

// Everything except `resolved` and `replies` must be unchanged — those
// two are the only fields a transition is allowed to move.
function coreEqual(a: CommentThreadEntry, b: CommentThreadEntry): boolean {
  return (
    a.author === b.author &&
    a.createdAt === b.createdAt &&
    a.quote === b.quote &&
    JSON.stringify(a.from) === JSON.stringify(b.from) &&
    JSON.stringify(a.to) === JSON.stringify(b.to)
  );
}

// A serialized Yjs relative position (Y.relativePositionToJSON output) is
// an object anchored either to an encoded `type` or to a named top-level
// type via `tname` (e.g. "content"), always with a numeric `assoc`.
// `{}` / `null` / a bare number pass a naive `!= null` check but make
// Y.createAbsolutePositionFromRelativePosition throw "Unexpected case" —
// which, resolved synchronously in every viewer's annotation rail, is a
// persistent client-wide DoS. Reject anything that isn't shaped like a
// real rel-pos so it never reaches the map.
export function isPlausibleRelPos(p: unknown): boolean {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  const anchored = typeof o.tname === "string" || o.type != null || o.item != null;
  return anchored && typeof o.assoc === "number";
}

export function isValidNewThread(entry: CommentThreadEntry | undefined, username: string | null): boolean {
  if (!entry || !username) return false;
  const first = entry.replies?.[0];
  return (
    entry.author === username &&
    entry.resolved === false &&
    Array.isArray(entry.replies) &&
    entry.replies.length === 1 &&
    !!first &&
    first.author === username &&
    typeof first.body === "string" &&
    first.body.trim() !== "" &&
    isPlausibleRelPos(entry.from) &&
    isPlausibleRelPos(entry.to)
  );
}

export function isAllowedThreadTransition(oldEntry: CommentThreadEntry, newEntry: CommentThreadEntry | undefined, username: string | null): boolean {
  if (!newEntry) return false;
  if (!coreEqual(oldEntry, newEntry)) return false;

  const repliesUnchanged = repliesEqual(oldEntry.replies, newEntry.replies);

  // A resolve / reopen toggle, replies untouched.
  if (repliesUnchanged && oldEntry.resolved !== newEntry.resolved) return true;

  // Exactly one reply appended — by the writing session, non-empty body,
  // resolved flag unchanged, every earlier reply untouched.
  if (
    oldEntry.resolved === newEntry.resolved &&
    newEntry.replies.length === oldEntry.replies.length + 1 &&
    repliesEqual(oldEntry.replies, newEntry.replies.slice(0, oldEntry.replies.length))
  ) {
    const appended = newEntry.replies[newEntry.replies.length - 1];
    if (!!username && !!appended && appended.author === username && appended.body.trim() !== "") return true;
  }

  return false;
}
