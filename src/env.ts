export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  COLLAB_ROOM: DurableObjectNamespace;
  WORKSPACE_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  // Test-only: a throwaway account's classic PAT (Bearer for
  // api.github.com, `repo`+`gist` scopes) and its login. Set in a
  // git-ignored .dev.vars locally or a CI secret for the e2e-github job;
  // never present in production. Consumed only by the (uncommitted)
  // dev-login patch's `?real=1` branch.
  TEST_GITHUB_TOKEN?: string;
  TEST_GITHUB_USERNAME?: string;
}

export interface SessionData {
  token: string;
  username: string;
  // Epoch-ms expiry, stamped by encryptSession and enforced by
  // decryptSession — see auth.ts. Optional only so callers construct
  // sessions without it; every session that round-trips has one.
  exp?: number;
}
