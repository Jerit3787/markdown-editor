import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchRepoDocDates } from "./repo-doc-dates";

afterEach(() => {
  vi.unstubAllGlobals();
});

function commitsResponse(dates: string[], link?: string) {
  const body = dates.map((date, i) => ({
    sha: `sha-${i}`,
    commit: { message: `commit ${i}`, author: { name: "Alice", date } },
  }));
  const headers: HeadersInit = {};
  if (link) headers["Link"] = link;
  return new Response(JSON.stringify(body), { status: 200, headers });
}

describe("fetchRepoDocDates", () => {
  it("uses the newest commit as updatedAt and the oldest as createdAt when history fits on one page", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        // Newest first, matching GitHub's actual ordering.
        return commitsResponse(["2026-08-10T00:00:00Z", "2026-08-05T00:00:00Z", "2026-01-01T00:00:00Z"]);
      }),
    );
    const result = await fetchRepoDocDates("alice", "notes", "main", "Notes.md");
    expect(result).toEqual({
      updatedAt: new Date("2026-08-10T00:00:00Z").getTime(),
      createdAt: new Date("2026-01-01T00:00:00Z").getTime(),
    });
    expect(calls).toHaveLength(1);
  });

  it("fetches the last page (via the Link header) to find createdAt when history spans multiple pages", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url.includes("page=1")) {
          return commitsResponse(
            ["2026-08-10T00:00:00Z", "2026-08-05T00:00:00Z"],
            '<https://api.github.com/repositories/1/commits?page=2>; rel="next", <https://api.github.com/repositories/1/commits?page=3>; rel="last"',
          );
        }
        if (url.includes("page=3")) {
          return commitsResponse(["2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const result = await fetchRepoDocDates("alice", "notes", "main", "Notes.md");
    expect(result).toEqual({
      updatedAt: new Date("2026-08-10T00:00:00Z").getTime(),
      createdAt: new Date("2026-01-01T00:00:00Z").getTime(),
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("page=3");
  });

  it("returns undefined when the file has no commits yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => commitsResponse([])),
    );
    const result = await fetchRepoDocDates("alice", "notes", "main", "Notes.md");
    expect(result).toBeUndefined();
  });

  it("returns undefined when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Server Error", { status: 500 })),
    );
    const result = await fetchRepoDocDates("alice", "notes", "main", "Notes.md");
    expect(result).toBeUndefined();
  });

  it("returns undefined when fetch throws (e.g. network error or aborted)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      }),
    );
    const result = await fetchRepoDocDates("alice", "notes", "main", "Notes.md");
    expect(result).toBeUndefined();
  });

  it("URL-encodes the path and passes branch and page through as query params", async () => {
    let requestedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requestedUrl = url;
        return commitsResponse(["2026-08-10T00:00:00Z"]);
      }),
    );
    await fetchRepoDocDates("alice", "notes", "main", "docs/my notes.md");
    expect(requestedUrl).toBe("/api/repo/alice/notes/commits?branch=main&page=1&path=docs/my%20notes.md");
  });
});
