export { CollabRoom } from "./collab-room.js";
export { WorkspaceRoom } from "./workspace-room.js";
import {
  handleLogin,
  handleCallback,
  handleLogout,
  handleMe,
  handleGistCreate,
  handleGistUpdate,
  handleGistGet,
  handleGistList,
} from "./github-auth.js";
import { handleGistImageUpload } from "./gist-images.js";
import type { Env } from "./env";

const ROOM_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})$/;
const ROOM_ACCESS_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/access$/;
const ROOM_MIGRATE_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/migrate$/;
const ROOM_VERSIONS_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/versions(\/.*)?$/;
const ROOM_COMMENTS_PATH = /^\/api\/collab\/([A-Za-z0-9_-]{1,128})\/comments(\/.*)?$/;
const WORKSPACE_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})$/;
const WORKSPACE_ACCESS_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/access$/;
const WORKSPACE_DOCS_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs$/;
const WORKSPACE_DOC_VERSIONS_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs\/([A-Za-z0-9_-]{1,128})\/versions(\/.*)?$/;
const WORKSPACE_DOC_COMMENTS_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs\/([A-Za-z0-9_-]{1,128})\/comments(\/.*)?$/;
const GIST_PATH = /^\/api\/gist\/([0-9a-f]+)$/i;
const GIST_IMAGE_PATH = /^\/api\/gist\/([0-9a-f]+)\/image$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const workspaceAccessMatch = url.pathname.match(WORKSPACE_ACCESS_PATH);
    if (workspaceAccessMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceAccessMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceDocsMatch = url.pathname.match(WORKSPACE_DOCS_PATH);
    if (workspaceDocsMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceDocsMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceDocVersionsMatch = url.pathname.match(WORKSPACE_DOC_VERSIONS_PATH);
    if (workspaceDocVersionsMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceDocVersionsMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceDocCommentsMatch = url.pathname.match(WORKSPACE_DOC_COMMENTS_PATH);
    if (workspaceDocCommentsMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceDocCommentsMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const workspaceMatch = url.pathname.match(WORKSPACE_PATH);
    if (workspaceMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const id = env.WORKSPACE_ROOM.idFromName(workspaceMatch[1]!);
      return env.WORKSPACE_ROOM.get(id).fetch(request);
    }

    const roomMigrateMatch = url.pathname.match(ROOM_MIGRATE_PATH);
    if (roomMigrateMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomMigrateMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    const roomAccessMatch = url.pathname.match(ROOM_ACCESS_PATH);
    if (roomAccessMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomAccessMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    const roomVersionsMatch = url.pathname.match(ROOM_VERSIONS_PATH);
    if (roomVersionsMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomVersionsMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    const roomCommentsMatch = url.pathname.match(ROOM_COMMENTS_PATH);
    if (roomCommentsMatch) {
      const id = env.COLLAB_ROOM.idFromName(roomCommentsMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    const roomMatch = url.pathname.match(ROOM_PATH);
    if (roomMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const id = env.COLLAB_ROOM.idFromName(roomMatch[1]!);
      return env.COLLAB_ROOM.get(id).fetch(request);
    }

    if (url.pathname === "/api/auth/github/login") return handleLogin(request, env);
    if (url.pathname === "/api/auth/github/callback") return handleCallback(request, env);
    if (url.pathname === "/api/auth/github/logout") return handleLogout(request, env);
    if (url.pathname === "/api/auth/github/me") return handleMe(request, env);

    if (url.pathname === "/api/gist" && request.method === "POST") return handleGistCreate(request, env);
    if (url.pathname === "/api/gists" && request.method === "GET") return handleGistList(request, env);
    const gistImageMatch = url.pathname.match(GIST_IMAGE_PATH);
    if (gistImageMatch && request.method === "POST") return handleGistImageUpload(request, env, gistImageMatch[1]!);

    const gistMatch = url.pathname.match(GIST_PATH);
    if (gistMatch && request.method === "PATCH") return handleGistUpdate(request, env, gistMatch[1]!);
    if (gistMatch && request.method === "GET") return handleGistGet(request, env, gistMatch[1]!);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
