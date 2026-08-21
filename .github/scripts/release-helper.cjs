const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractChangelog(content, tagName) {
  const version = tagName.replace(/^v/, "");
  const escapedVersion = escapeRegExp(version);
  // Match heading like ## [1.14.0] or ## [1.14.0] - 2026-08-13
  const regex = new RegExp(`##\\s*\\[?${escapedVersion}\\]?[^\n]*\n([\\s\\S]*?)(?=\n##\\s*\\[|\\s*$)`, "i");
  const match = content.match(regex);
  if (!match || !match[1].trim()) {
    return null;
  }
  return match[1].trim();
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

    let notes = extractChangelog(changelogContent, tag);
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

module.exports = { extractChangelog, sortTags, appendComparisonLink, getRepoSlug, processReleases };
