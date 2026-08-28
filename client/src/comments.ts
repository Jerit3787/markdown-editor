// Shared (collaboration-room) documents' threaded comments — thin fetch
// wrappers over CollabRoom's HTTP routes, same same-origin relative-fetch,
// try/catch-with-safe-fallback style as collab.ts's own fetchAccess/
// putAccess and history.ts's shared-version wrappers. Local (never-shared)
// documents use stores/docs.ts's addDocNote/deleteDocNote/
// refreshDocNoteAnchors instead — see that module's own comment for why
// the two paths diverge once a document is shared.

export interface CommentReply {
  id: string;
  author: string;
  body: string;
  createdAt: number;
}

export interface CommentThread {
  id: string;
  from: number;
  to: number;
  quote: string;
  orphaned: boolean;
  resolved: boolean;
  comments: CommentReply[];
}

export async function listComments(workspaceId: string, docId: string): Promise<CommentThread[]> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/comments`);
    if (!res.ok) return [];
    return (await res.json()) as CommentThread[];
  } catch (err) {
    return [];
  }
}

export async function createComment(
  workspaceId: string,
  docId: string,
  from: number,
  to: number,
  quote: string,
  body: string,
): Promise<CommentThread | undefined> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, quote, body }),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as CommentThread;
  } catch (err) {
    return undefined;
  }
}

export async function replyToComment(workspaceId: string, docId: string, threadId: string, body: string): Promise<CommentThread | undefined> {
  try {
    const res = await fetch(
      `/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/comments/${encodeURIComponent(threadId)}/reply`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!res.ok) return undefined;
    return (await res.json()) as CommentThread;
  } catch (err) {
    return undefined;
  }
}

export async function resolveComment(workspaceId: string, docId: string, threadId: string, resolved: boolean): Promise<CommentThread | undefined> {
  try {
    const res = await fetch(
      `/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/comments/${encodeURIComponent(threadId)}/resolve`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved }),
      },
    );
    if (!res.ok) return undefined;
    return (await res.json()) as CommentThread;
  } catch (err) {
    return undefined;
  }
}

export function countUnresolvedComments(threads: CommentThread[]): number {
  return threads.filter((t) => !t.resolved).length;
}

export async function deleteComment(workspaceId: string, docId: string, threadId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/workspace/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/comments/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
    });
    return res.ok;
  } catch (err) {
    return false;
  }
}
