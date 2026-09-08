export type Role = "viewer" | "reviewer" | "editor";

export interface InvitedPerson {
  username: string;
  role: Role;
}

// A pending "request edit access" from a viewer/reviewer (CV2-5). Stored
// in the DO under the "accessRequests" key, separate from AccessRecord.
// Hand-synced with client/src/types.ts's copy.
export interface AccessRequest {
  username: string;
  message: string; // "" when none
  createdAt: number;
}

export interface AccessRecord {
  owner: string | null;
  generalAccess: "restricted" | "anyone";
  // Only meaningful when generalAccess is "anyone" — false (default) means
  // a fully public link, no account needed; true means any signed-in
  // GitHub account works without being individually invited.
  requireAccount: boolean;
  role: Role;
  invited: InvitedPerson[];
}

// Pure extraction of the identical logic previously duplicated in
// WorkspaceRoom.authorize() and CollabRoom.authorize(). `sessionUsername`
// is the caller's already-decrypted session's username, or null for no/
// invalid session. Returns null when the requester has no access at all —
// the caller decides the exact 401 vs 403 status and message (the two
// rooms word them slightly differently — "this document" vs "this
// workspace") and is also responsible for the "no owner yet" check before
// ever calling this, since that's a distinct, room-specific error case.
export function resolveRole(access: AccessRecord, sessionUsername: string | null): Role | null {
  if (sessionUsername && sessionUsername === access.owner) return "editor";
  if (access.generalAccess === "anyone") {
    if (access.requireAccount && !sessionUsername) return null;
    return access.role;
  }
  if (!sessionUsername) return null;
  const invited = access.invited.find((p) => p.username === sessionUsername);
  return invited ? invited.role : null;
}
