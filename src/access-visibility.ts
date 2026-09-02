// What a caller the room hasn't actually let in is allowed to learn from
// GET /access.
//
// That endpoint has to stay readable without authorization: the join flow
// reads it *before* the visitor has any access of their own, to decide
// whether to prompt for GitHub sign-in, show "you don't have access", or go
// straight in (see collab.ts's computeMyRole). What it has no business
// handing out is the rest of the room's roster — `invited` lists every
// collaborator's GitHub username and `owner` names whoever created the
// share, so anyone who ever saw a share link (including someone whose
// access was since revoked, or a stranger on a restricted workspace) could
// otherwise enumerate the whole team indefinitely.
//
// Dropping both is invisible to a legitimate join. computeMyRole only ever
// looks *itself* up in `invited` and only compares `owner` against its own
// username — and both of those cases authorize successfully, so they never
// reach this function: an invited person is granted their role by
// authorize(), and the owner is granted editor. Anyone who lands here is,
// by construction, in neither list.
export interface RedactableAccess {
  owner: string | null;
  invited: unknown[];
}

export function redactAccessForOutsider<T extends RedactableAccess>(access: T): T {
  return { ...access, owner: null, invited: [] };
}
