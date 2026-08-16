// GitHub repo-sync: pure path/content-transform helpers (this task),
// pull/push diff planners, and orchestration (fetch calls to /api/repo/*).
// Kept pure-function-first so the diff/conflict logic is unit-testable
// without mocking fetch — the same reasoning src/github-repo.ts's
// computeNewTreeEntries follows server-side.

export function slugifyDocName(name: string): string {
  const slug = (name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

export function dedupeRepoPath(basePath: string, existingPaths: Set<string>): string {
  if (!existingPaths.has(basePath)) return basePath;
  const extMatch = basePath.match(/^(.*)(\.[^./]+)$/);
  const stem = extMatch ? extMatch[1]! : basePath;
  const ext = extMatch ? extMatch[2]! : "";
  let n = 2;
  while (existingPaths.has(`${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

export interface ImageAsset {
  path: string;
  dataUrl: string;
}

function extFromDataUrl(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/);
  if (!match) return "png";
  const sub = match[1]!.split("+")[0]!.toLowerCase();
  return sub === "jpeg" ? "jpg" : sub;
}

export function rewriteImagesForPush(
  content: string,
  docSlug: string,
  images: Record<string, string> | undefined,
  diagrams: Record<string, string> | undefined
): { content: string; assets: ImageAsset[] } {
  const assets: ImageAsset[] = [];
  const seenRefs = new Map<string, string>(); // ref -> assigned assets path, so repeats reuse the same path
  const newContent = content.replace(MARKDOWN_IMAGE_RE, (match, alt, ref) => {
    const dataUrl = (images && images[ref]) || (diagrams && diagrams[ref]);
    if (!dataUrl) return match;
    let assetPath = seenRefs.get(ref);
    if (!assetPath) {
      const hasExt = /\.[a-zA-Z0-9]+$/.test(ref);
      assetPath = `assets/${docSlug}/${hasExt ? ref : `${ref}.${extFromDataUrl(dataUrl)}`}`;
      seenRefs.set(ref, assetPath);
      assets.push({ path: assetPath, dataUrl });
    }
    return `![${alt}](${assetPath})`;
  });
  return { content: newContent, assets };
}

export function resolveImagesFromPull(content: string, docSlug: string, blobs: Record<string, string>): { content: string; images: Record<string, string> } {
  const images: Record<string, string> = {};
  let counter = 0;
  const prefix = `assets/${docSlug}/`;
  const newContent = content.replace(MARKDOWN_IMAGE_RE, (match, alt, ref) => {
    if (!ref.startsWith(prefix) || !blobs[ref]) return match;
    counter++;
    const internalRef = `img-${Date.now().toString(36)}-${counter}`;
    images[internalRef] = blobs[ref]!;
    return `![${alt}](${internalRef})`;
  });
  return { content: newContent, images };
}
