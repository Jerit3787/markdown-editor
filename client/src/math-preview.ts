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
  renderToString(tex: string, options: { throwOnError: boolean; displayMode: boolean; trust: boolean }): string;
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
  // Every text node that carries at least one §MATH<id>§ marker. A single
  // node can hold several ("a $x$ and $y$" is one text node), and the
  // prose around each marker in that node has to survive — so this
  // splices the node's own text instead of replacing the whole node
  // (which dropped everything else in "The value is $x$ today").
  const markerRe = /§MATH\d+§/;
  const splitRe = /§(MATH\d+)§/g;
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (markerRe.test(node.textContent ?? "")) nodes.push(node as Text);
  }
  if (nodes.length === 0) return;

  const katex = (await loadKatex()).default;

  // One marker's replacement: a rendered-KaTeX DocumentFragment, or a
  // plain text Node for the fallbacks (missing source, or katex itself
  // failing to load/execute).
  const renderMarker = (key: string): Node => {
    const source = sources.get(key);
    // Lazy-load failure or a stale marker from a since-superseded render
    // pass — drop the marker rather than leaking the internal §MATH<id>§
    // token into the visible preview.
    if (!source) return document.createTextNode("");
    const delimited = source.display ? `$$${source.src}$$` : `$${source.src}$`;
    let html: string;
    try {
      // trust: false is KaTeX's own default, but this TeX can come from a
      // collaborator on a shared document and the HTML below goes straight
      // into the live preview *after* Preview.svelte's DOMPurify pass, not
      // through it. With trust enabled, \href/\url/\includegraphics emit
      // caller-controlled URLs and \htmlData/\htmlId emit caller-controlled
      // attributes — pinning it explicitly means a future version changing
      // its default can't silently turn that on.
      html = katex.renderToString(source.src, { throwOnError: false, displayMode: source.display, trust: false });
    } catch {
      // katex itself failing to load/execute (not a LaTeX syntax error,
      // which throwOnError:false already handles inline) — fall back to
      // the literal source rather than losing the marker's replacement.
      return document.createTextNode(delimited);
    }
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  };

  for (const textNode of nodes) {
    const text = textNode.textContent ?? "";
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    for (const m of text.matchAll(splitRe)) {
      const before = text.slice(lastIndex, m.index);
      if (before) frag.appendChild(document.createTextNode(before));
      frag.appendChild(renderMarker(m[1]));
      lastIndex = m.index + m[0].length;
    }
    const after = text.slice(lastIndex);
    if (after) frag.appendChild(document.createTextNode(after));
    textNode.replaceWith(frag);
  }
}
