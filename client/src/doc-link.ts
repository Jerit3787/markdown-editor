import type { Doc } from "./types";

export type LinkHrefKind = "external" | "anchor" | "absolute" | "doc-ref";

// A URL scheme prefix: http:, https:, mailto:, tel:, ftp:, ... The
// preview's renderer.link checks the "wikilink:" scheme itself, before
// this is ever called.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const MD_EXT_RE = /\.(?:md|markdown)$/i;
const DOCISH_EXT_RE = /\.(?:md|markdown|txt)$/i;

export function classifyLinkHref(href: string): LinkHrefKind {
  if (href.startsWith("#")) return "anchor";
  if (href.startsWith("//")) return "external"; // protocol-relative
  if (href.startsWith("/")) return "absolute";
  if (SCHEME_RE.test(href)) return "external";
  return "doc-ref";
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function normalizeRef(href: string): string {
  const decoded = safeDecode(href);
  return decoded.startsWith("./") ? decoded.slice(2) : decoded;
}

// Resolve a scheme-less markdown-link target to a document. Tries, in
// order: exact name, name with a trailing .md stripped, exact repoPath,
// repoPath with .md appended, and the ref's basename (sans .md) as a
// name. First match wins; ties resolve to the first in `docs` order,
// same as resolveWikilinkTarget.
export function resolveDocRef(href: string, docs: Doc[]): Doc | undefined {
  const ref = normalizeRef(href);
  const refNoMd = ref.replace(MD_EXT_RE, "");
  const refAsRepoPath = MD_EXT_RE.test(ref) ? ref : `${ref}.md`;
  const baseNoMd = (ref.split("/").pop() ?? ref).replace(MD_EXT_RE, "");
  return (
    docs.find((doc) => doc.name === ref) ??
    docs.find((doc) => doc.name === refNoMd) ??
    docs.find((doc) => doc.repoPath === ref) ??
    docs.find((doc) => doc.repoPath === refAsRepoPath) ??
    docs.find((doc) => doc.name === baseNoMd)
  );
}

// A doc-ref that resolved to nothing: does it read as a bare website
// domain the author meant to link out to? (example.com,
// docs.example.com/page — but not notes.md, "My Note", docs/notes)
export function looksLikeExternalDomain(ref: string): boolean {
  if (/\s/.test(ref)) return false;
  if (DOCISH_EXT_RE.test(ref)) return false;
  const host = ref.split("/")[0] ?? "";
  if (!host.includes(".")) return false;
  const tld = host.split(".").pop() ?? "";
  return /^[a-z]{2,}$/i.test(tld);
}
