import type { ResolvedSuggestion } from "./suggestions";

// Wraps each suggestion's range in raw <ins>/<del> HTML before the text
// reaches marked.parse() — same "transform raw markdown text before
// parsing" pattern this codebase already uses for wikilinks/citations/
// math (see Preview.svelte's updatePreview()). marked passes raw inline
// HTML through by default, and <ins>/<del> are already in DOMPurify's
// default allowlist, so no sanitizer changes are needed.
//
// Known limitation (see design spec): if a suggestion's boundary falls
// inside Markdown syntax itself (splitting a "**" pair, or crossing a
// fenced code block), Preview may render that one pending suggestion's
// surrounding text oddly until it's resolved — inherent to layering
// suggestions on a Markdown source pipeline rather than a rich-text
// model. Never affects the editor pane or the eventual accept/reject.
export function transformSuggestions(raw: string, suggestions: ResolvedSuggestion[]): string {
  if (suggestions.length === 0) return raw;
  // Apply from the END of the string backward so earlier insertion
  // offsets are never invalidated by a later (in iteration order, but
  // earlier in the string) wrap changing the string's length.
  const sorted = [...suggestions].sort((a, b) => b.from - a.from);
  let result = raw;
  for (const s of sorted) {
    if (s.from < 0 || s.to > result.length || s.to <= s.from) continue;
    const tag = s.kind === "insert" ? "ins" : "del";
    const cls = s.kind === "insert" ? "suggestion-insert" : "suggestion-delete";
    const before = result.slice(0, s.from);
    const middle = result.slice(s.from, s.to);
    const after = result.slice(s.to);
    result = `${before}<${tag} class="${cls}" data-suggestion-id="${s.id}">${middle}</${tag}>${after}`;
  }
  return result;
}
