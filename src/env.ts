export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  COLLAB_ROOM: DurableObjectNamespace;
  WORKSPACE_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export interface SessionData {
  token: string;
  username: string;
  // Epoch-ms expiry, stamped by encryptSession and enforced by
  // decryptSession — see auth.ts. Optional only so callers construct
  // sessions without it; every session that round-trips has one.
  exp?: number;
}
