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
