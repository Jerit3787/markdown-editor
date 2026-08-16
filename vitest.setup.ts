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
