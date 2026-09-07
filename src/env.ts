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
  // Google OAuth (Drive integration — see src/google-auth.ts). Optional:
  // absent → every /api/auth/google/* and /api/drive/* route returns 503
  // and the client hides the Google menu items, same as the GitHub path
  // without GITHUB_CLIENT_SECRET. GOOGLE_CLIENT_ID and GOOGLE_API_KEY are
  // non-secret (public in every OAuth / Picker request); GOOGLE_CLIENT_SECRET
  // is a Worker secret.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_API_KEY?: string;
}

export interface SessionData {
  token: string;
  username: string;
  // Epoch-ms expiry, stamped by encryptSession and enforced by
  // decryptSession — see auth.ts. Optional only so callers construct
  // sessions without it; every session that round-trips has one.
  exp?: number;
}

// The mde_google_session cookie payload — a Google OAuth grant. Kept
// entirely separate from SessionData (the GitHub session): a user can
// connect Drive without a GitHub account and vice versa.
export interface GoogleSessionData {
  refreshToken: string;
  accessToken: string;
  accessTokenExp: number; // epoch ms — when accessToken stops working
  exp?: number; // cookie lifetime, stamped by encryptJSON like SessionData.exp
}
