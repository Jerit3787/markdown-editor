export { CollabRoom } from "./collab-room.js";
export { WorkspaceRoom } from "./workspace-room.js";
import { handleLogin, handleCallback, handleLogout, handleMe, handleGistCreate, handleGistUpdate, handleGistGet, handleGistList } from "./github-auth.js";
import { handleGistImageUpload } from "./gist-images.js";
import { handleRepoList, handleRepoCreate, handleRepoTree, handleRepoBlob, handleRepoCommits, handleRepoFileAtRef, handleRepoPush } from "./github-repo.js";
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
const WORKSPACE_DOC_WIKILINK_RENAME_PATH = /^\/api\/workspace\/([A-Za-z0-9_-]{1,128})\/docs\/([A-Za-z0-9_-]{1,128})\/wikilink-rename$/;
const GIST_PATH = /^\/api\/gist\/([0-9a-f]+)$/i;
const GIST_IMAGE_PATH = /^\/api\/gist\/([0-9a-f]+)\/image$/i;
const REPO_TREE_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/tree$/;
const REPO_BLOB_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/blob\/([0-9a-f]+)$/i;
const REPO_PUSH_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/push$/;
const REPO_COMMITS_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/commits$/;
const REPO_FILE_AT_REF_PATH = /^\/api\/repo\/([^/]+)\/([^/]+)\/contents\/(.+)$/;

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

    const workspaceWikilinkRenameMatch = url.pathname.match(WORKSPACE_DOC_WIKILINK_RENAME_PATH);
    if (workspaceWikilinkRenameMatch) {
      const id = env.WORKSPACE_ROOM.idFromName(workspaceWikilinkRenameMatch[1]!);
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

    if (url.pathname === "/api/repo/list" && request.method === "GET") return handleRepoList(request, env);
    if (url.pathname === "/api/repo/create" && request.method === "POST") return handleRepoCreate(request, env);

    const repoTreeMatch = url.pathname.match(REPO_TREE_PATH);
    if (repoTreeMatch && request.method === "GET") {
      const branch = url.searchParams.get("branch") || "";
      const sha = url.searchParams.get("sha") || undefined;
      return handleRepoTree(request, env, repoTreeMatch[1]!, repoTreeMatch[2]!, branch, sha);
    }

    const repoBlobMatch = url.pathname.match(REPO_BLOB_PATH);
    if (repoBlobMatch && request.method === "GET") return handleRepoBlob(request, env, repoBlobMatch[1]!, repoBlobMatch[2]!, repoBlobMatch[3]!);

    const repoCommitsMatch = url.pathname.match(REPO_COMMITS_PATH);
    if (repoCommitsMatch && request.method === "GET") {
      const branch = url.searchParams.get("branch") || "";
      const page = Number(url.searchParams.get("page")) || 1;
      const path = url.searchParams.get("path") || undefined;
      return handleRepoCommits(request, env, repoCommitsMatch[1]!, repoCommitsMatch[2]!, branch, page, path);
    }

    const repoFileAtRefMatch = url.pathname.match(REPO_FILE_AT_REF_PATH);
    if (repoFileAtRefMatch && request.method === "GET") {
      const ref = url.searchParams.get("ref") || "";
      return handleRepoFileAtRef(request, env, repoFileAtRefMatch[1]!, repoFileAtRefMatch[2]!, repoFileAtRefMatch[3]!, ref);
    }

    const repoPushMatch = url.pathname.match(REPO_PUSH_PATH);
    if (repoPushMatch && request.method === "POST") return handleRepoPush(request, env, repoPushMatch[1]!, repoPushMatch[2]!);

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
