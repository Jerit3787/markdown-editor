export interface Env {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  SESSION_SECRET: string;
  COLLAB_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export interface SessionData {
  token: string;
  username: string;
}
