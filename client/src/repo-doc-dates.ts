export interface RepoDocDates {
  createdAt: number;
  updatedAt: number;
}

interface CommitApiEntry {
  commit: { author: { date: string } };
}

// GitHub's Link header looks like:
//   <https://api.github.com/repositories/1/commits?page=2>; rel="next", <...?page=5>; rel="last"
// We only need the page number of the "last" entry.
function parseLastPage(linkHeader: string | null): number | null {
  if (!linkHeader) return null;
  const lastPart = linkHeader.split(",").find((part) => part.includes('rel="last"'));
  if (!lastPart) return null;
  const urlMatch = lastPart.match(/<([^>]+)>/);
  if (!urlMatch) return null;
  const page = new URL(urlMatch[1]!).searchParams.get("page");
  return page ? Number(page) : null;
}

async function fetchCommitsPage(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  page: number,
  signal?: AbortSignal,
): Promise<{ commits: CommitApiEntry[]; linkHeader: string | null }> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`/api/repo/${owner}/${repo}/commits?branch=${encodeURIComponent(branch)}&page=${page}&path=${encodedPath}`, { signal });
  if (!res.ok) throw new Error(`commits fetch failed: ${res.status}`);
  const commits = (await res.json()) as CommitApiEntry[];
  return { commits, linkHeader: res.headers.get("Link") };
}

// Fetches the creation and last-modified dates for a repo-linked file from
// its real GitHub commit history — the newest commit for `updatedAt`, the
// oldest for `createdAt`. GitHub returns commits newest-first, so finding
// the oldest means jumping straight to the last page via the Link header's
// rel="last" entry rather than walking every page. Returns undefined (never
// throws) on any failure — no commits yet, a failed request, or an aborted
// one — so callers can fall back to local timestamps unconditionally.
export async function fetchRepoDocDates(owner: string, repo: string, branch: string, path: string, signal?: AbortSignal): Promise<RepoDocDates | undefined> {
  try {
    const first = await fetchCommitsPage(owner, repo, branch, path, 1, signal);
    if (first.commits.length === 0) return undefined;
    const updatedAt = new Date(first.commits[0]!.commit.author.date).getTime();

    const lastPage = parseLastPage(first.linkHeader);
    if (lastPage === null) {
      const oldest = first.commits[first.commits.length - 1]!;
      return { createdAt: new Date(oldest.commit.author.date).getTime(), updatedAt };
    }

    const last = await fetchCommitsPage(owner, repo, branch, path, lastPage, signal);
    if (last.commits.length === 0) return { createdAt: updatedAt, updatedAt };
    const oldest = last.commits[last.commits.length - 1]!;
    return { createdAt: new Date(oldest.commit.author.date).getTime(), updatedAt };
  } catch {
    return undefined;
  }
}
