export interface MathSource {
  src: string;
  display: boolean;
}

export interface MathExtraction {
  text: string;
  sources: Map<string, MathSource>;
}

// Fenced code blocks (```...```, across lines) or inline code spans
// (`...`, single line) — math syntax inside either must never be treated
// as math. Splitting on this first, then only scanning the non-code
// segments below, is simpler and safer than trying to build one regex
// that understands both code and math delimiters at once.
const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

// $$...$$ can span multiple lines; content must not contain a literal
// unescaped $ (so it can't accidentally swallow a following span — LaTeX
// content needing a literal dollar sign is a known, accepted limitation
// of this first pass, same scope boundary noted in the design doc).
const BLOCK_MATH_RE = /\$\$([^$]+?)\$\$/g;

// $...$, single line only (no embedded newline), content's first and
// last character both non-whitespace and non-$ — disambiguates from
// prose currency like "$5 and $10", where whitespace sits right against
// at least one side of every $ that isn't real math.
const INLINE_MATH_RE = /\$([^\s$][^$\n]*?[^\s$]|[^\s$])\$/g;

export interface KatexLike {
  renderToString(tex: string, options: { throwOnError: boolean; displayMode: boolean }): string;
}

async function loadRealKatex(): Promise<{ default: KatexLike }> {
  const mod = await import("katex");
  // The real package's type is a strict superset of KatexLike (only
  // renderToString is called here) — narrowing here keeps this module's
  // public surface independent of katex's full API/types, same reasoning
  // as mermaid-preview.ts's MermaidLike.
  return { default: mod.default as unknown as KatexLike };
}

export function extractMathSpans(rawMarkdown: string): MathExtraction {
  const sources = new Map<string, MathSource>();
  let nextId = 0;

  function stash(src: string, display: boolean): string {
    const key = `MATH${nextId++}`;
    sources.set(key, { src, display });
    return `§${key}§`;
  }

  const segments = rawMarkdown.split(CODE_SEGMENT_RE);
  const processed = segments.map((segment, i) => {
    // String.split with a capturing group interleaves the captured
    // delimiters at odd indices — those are the code segments; leave
    // them untouched.
    if (i % 2 === 1) return segment;

    // Block math is resolved first: running the inline regex on raw
    // "$$...$$" text would otherwise match a "$...$" substring nested
    // inside it before the block pattern ever gets a chance.
    let out = segment.replace(BLOCK_MATH_RE, (_match, src: string) => stash(src, true));
    out = out.replace(INLINE_MATH_RE, (_match, src: string) => stash(src, false));
    return out;
  });

  return { text: processed.join(""), sources };
}

// Walks container's text nodes looking for the §MATH<id>§ markers
// extractMathSpans left behind (they pass through marked.parse() and
// DOMPurify.sanitize() untouched, since they're plain text with no HTML
// meaning), and replaces each with KaTeX's rendered markup for that id's
// stored source.
export async function renderMathPlaceholders(
  container: ParentNode,
  sources: Map<string, MathSource>,
  loadKatex: () => Promise<{ default: KatexLike }> = loadRealKatex,
): Promise<void> {
  if (sources.size === 0) return;

  const walker = document.createTreeWalker(container as Node, NodeFilter.SHOW_TEXT);
  const matches: { node: Text; key: string }[] = [];
  const markerRe = /§(MATH\d+)§/;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? "";
    const match = markerRe.exec(text);
    if (match) matches.push({ node: node as Text, key: match[1] });
  }
  if (matches.length === 0) return;

  const katex = (await loadKatex()).default;
  for (const { node, key } of matches) {
    const source = sources.get(key);
    // Lazy-load failure or a stale marker from a since-superseded render
    // pass — leave the original $...$/$$...$$ source visible rather than
    // the internal §MATH<id>§ marker, which would otherwise leak into
    // the visible preview.
    if (!source) {
      node.textContent = (node.textContent ?? "").replace(`§${key}§`, "");
      continue;
    }
    const delimited = source.display ? `$$${source.src}$$` : `$${source.src}$`;
    let html: string;
    try {
      html = katex.renderToString(source.src, { throwOnError: false, displayMode: source.display });
    } catch {
      // katex itself failing to load/execute (not a LaTeX syntax error,
      // which throwOnError:false already handles inline) — fall back to
      // the literal source rather than losing the marker's replacement.
      node.textContent = (node.textContent ?? "").replace(`§${key}§`, delimited);
      continue;
    }
    const template = document.createElement("template");
    template.innerHTML = html;
    node.replaceWith(template.content);
  }
}
