const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Every "## [x.y.z] - date" section in CHANGELOG.md, in file order (newest
// first) — including ones whose version never became its own git tag (an
// intermediate package.json state that got superseded by a later bump
// before its branch's merge commit ever became master's HEAD, so no commit
// anywhere actually shipped exactly that version on its own).
function parseChangelogSections(content) {
  // (?![\s\S]) is a true end-of-string assertion — \s*$ under the /m flag
  // this needs for ^## to match at each line's start instead matches at
  // *any* blank-line boundary (m makes $ match before every \n, and \s*
  // can match zero characters), so it stopped the lazy body capture at
  // the very first blank line after each heading, before ever reaching
  // the heading's actual content.
  const regex = /^##\s*\[?([0-9][0-9.]*)\]?[^\n]*\n([\s\S]*?)(?=\n##\s*\[|(?![\s\S]))/gm;
  const sections = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    const body = match[2].trim();
    if (body) {
      sections.push({ version: match[1], body });
    }
  }
  return sections;
}

// A tag's own CHANGELOG section, with any immediately-older orphaned
// versions folded in ahead of it — the versions listed between it and
// whichever real tag precedes it that never got a tag of their own, so
// this tag's release is the only place their changes actually ship.
// sortedGitTags is what release-helper already computes from `git tag -l`
// for every other purpose; passing it in here (rather than re-deriving it)
// is what tells this function which versions are "real" vs. orphaned — a
// required argument rather than defaulting to [], since [] would mean
// "nothing is a real tag" and fold in every older section indefinitely,
// not "fold nothing."
function extractChangelog(content, tagName, sortedGitTags) {
  const sections = parseChangelogSections(content);
  const version = tagName.replace(/^v/, "");
  const idx = sections.findIndex((s) => s.version === version);
  if (idx === -1) {
    return null;
  }

  const bodies = [sections[idx].body];
  for (let i = idx + 1; i < sections.length; i++) {
    if (sortedGitTags.includes(`v${sections[i].version}`)) {
      break;
    }
    bodies.push(sections[i].body);
  }
  // bodies is newest-to-oldest (current tag first, then any orphans below
  // it); reversed so the notes read chronologically, oldest change first.
  return bodies.reverse().join("\n\n");
}

function parseSemver(tag) {
  const clean = tag.replace(/^v/, "");
  return clean.split(".").map((p) => parseInt(p, 10) || 0);
}

function sortTags(tags) {
  return [...tags].sort((a, b) => {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na !== nb) return na - nb;
    }
    return 0;
  });
}

function getRepoSlug() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  try {
    const remoteUrl = execSync("git remote get-url origin", { encoding: "utf8" }).trim();
    const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/);
    if (match) {
      return match[1];
    }
  } catch (err) {
    // Ignore error
  }
  return "";
}

function appendComparisonLink(notes, tag, sortedTags, repoSlug) {
  if (!repoSlug) {
    return notes;
  }
  const index = sortedTags.indexOf(tag);
  let link = "";
  if (index > 0) {
    const prevTag = sortedTags[index - 1];
    link = `**Full Changelog**: https://github.com/${repoSlug}/compare/${prevTag}...${tag}`;
  } else {
    link = `**Full Changelog**: https://github.com/${repoSlug}/commits/${tag}`;
  }
  return `${notes}\n\n${link}`;
}

function processReleases() {
  const changelogPath = path.join(process.cwd(), "CHANGELOG.md");
  if (!fs.existsSync(changelogPath)) {
    console.error("CHANGELOG.md not found");
    process.exit(1);
  }
  const changelogContent = fs.readFileSync(changelogPath, "utf8");

  // Get current ref tag if triggered by tag push
  const currentTag = process.env.GITHUB_REF_NAME || "";

  let existingReleases = [];
  try {
    const ghOutput = execSync("gh release list --limit 1000 --json tagName", { encoding: "utf8" });
    existingReleases = JSON.parse(ghOutput).map((r) => r.tagName);
  } catch (err) {
    console.warn("Could not fetch existing releases via gh CLI:", err.message);
  }

  let tagsToProcess = [];
  if (currentTag && currentTag.startsWith("v")) {
    tagsToProcess.push(currentTag);
  }

  // Get all local git tags matching v*
  let allGitTags = [];
  try {
    allGitTags = execSync('git tag -l "v*"', { encoding: "utf8" })
      .split("\n")
      .map((t) => t.trim())
      .filter(Boolean);
    for (const tag of allGitTags) {
      if (!tagsToProcess.includes(tag)) {
        tagsToProcess.push(tag);
      }
    }
  } catch (err) {
    console.warn("Could not list git tags:", err.message);
  }

  const sortedGitTags = sortTags(allGitTags.length > 0 ? allGitTags : tagsToProcess);
  const highestTag = sortedGitTags.length > 0 ? sortedGitTags[sortedGitTags.length - 1] : "";
  const repoSlug = getRepoSlug();

  console.log(`Checking ${tagsToProcess.length} tag(s)...`);

  let createdHighestAsLatest = false;

  for (const tag of tagsToProcess) {
    if (existingReleases.includes(tag)) {
      console.log(`Release for ${tag} already exists. Skipping.`);
      continue;
    }

    let notes = extractChangelog(changelogContent, tag, sortedGitTags);
    if (!notes) {
      console.log(`No changelog notes found for ${tag}. Skipping.`);
      continue;
    }

    notes = appendComparisonLink(notes, tag, sortedGitTags, repoSlug);

    const isLatest = tag === highestTag;
    const latestFlag = isLatest ? "--latest" : "--latest=false";

    console.log(`Creating GitHub Release for ${tag} (latest: ${isLatest})...`);
    const tempNotesFile = path.join(process.cwd(), `.release_notes_${tag.replace(/[^a-zA-Z0-9.-]/g, "_")}.md`);
    fs.writeFileSync(tempNotesFile, notes, "utf8");

    try {
      execSync(`gh release create "${tag}" --title "${tag}" --notes-file "${tempNotesFile}" ${latestFlag}`, {
        stdio: "inherit",
      });
      console.log(`Successfully published release for ${tag}.`);
      if (isLatest) {
        createdHighestAsLatest = true;
      }
    } catch (err) {
      console.error(`Failed to create release for ${tag}:`, err.message);
    } finally {
      if (fs.existsSync(tempNotesFile)) {
        fs.unlinkSync(tempNotesFile);
      }
    }
  }

  // `gh release create ... --latest` above already marks highestTag as
  // latest — re-running the edit here is redundant and, right after
  // creation, races GitHub's read-after-write consistency for the
  // release's published state (edit can 422 "cannot be draft or
  // prerelease" on a release that was, in fact, just published).
  if (highestTag && !createdHighestAsLatest) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(`Ensuring ${highestTag} is set as Latest release (attempt ${attempt}/${maxAttempts})...`);
        execSync(`gh release edit "${highestTag}" --latest`, { stdio: "inherit" });
        break;
      } catch (err) {
        if (attempt === maxAttempts) {
          console.warn(`Could not set ${highestTag} as latest release:`, err.message);
        } else {
          execSync("sleep 3");
        }
      }
    }
  }
}

if (require.main === module) {
  processReleases();
}

module.exports = { extractChangelog, parseChangelogSections, sortTags, appendComparisonLink, getRepoSlug, processReleases };
