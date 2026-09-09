// Runs before any test file's own imports (setupFiles load ahead of test
// module code, unlike a polyfill written inside a test file itself, which
// can't run before that same file's own top-level imports already
// executed). Needed because jsdom doesn't provide localStorage without a
// proper http(s) URL configured, and several client stores (workspaces.ts,
// docs.ts) read localStorage at module load time — any test file that
// statically imports one of those (directly or transitively) crashes on
// import without this.
if (typeof localStorage === "undefined") {
  class MockLocalStorage {
    private data: Record<string, string> = {};
    setItem(key: string, value: string): void {
      this.data[key] = String(value);
    }
    getItem(key: string): string | null {
      return this.data[key] ?? null;
    }
    removeItem(key: string): void {
      delete this.data[key];
    }
    clear(): void {
      this.data = {};
    }
    key(index: number): string | null {
      const keys = Object.keys(this.data);
      return keys[index] ?? null;
    }
    get length(): number {
      return Object.keys(this.data).length;
    }
  }
  (globalThis as any).localStorage = new MockLocalStorage();
}

// worker.ts's HTML-response path constructs a `new HTMLRewriter()` (a
// Cloudflare Workers runtime global) to strip the <meta> CSP and stamp a
// nonce on each <script>. The Node/jsdom unit env has no such global —
// this pass-through stand-in lets worker.ts's fetch() run past that call
// in routing tests. The real element rewriting is exercised by the
// collab e2e suite (tests/e2e/collab/csp-built.spec.ts) against wrangler.
if (typeof (globalThis as any).HTMLRewriter === "undefined") {
  class MockHTMLRewriter {
    on(): this {
      return this;
    }
    transform<T>(response: T): T {
      return response;
    }
  }
  (globalThis as any).HTMLRewriter = MockHTMLRewriter;
}

// stores/view.ts sets #body's className as a module-load side effect
// (mirrors the old app.ts initViewToggle) — any test file that statically
// imports it, directly or transitively (e.g. via collab.ts), crashes on
// import against jsdom's default document, which has no element with
// id="body". Real index.html always has this div, so this mirrors that.
if (typeof document !== "undefined" && !document.getElementById("body")) {
  const body = document.createElement("div");
  body.id = "body";
  document.body.appendChild(body);
}
