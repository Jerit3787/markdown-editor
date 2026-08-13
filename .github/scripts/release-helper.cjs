const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function extractChangelog(content, tagName) {
  const version = tagName.replace(/^v/, '');
  const escapedVersion = version.replace(/\./g, '\\.');
  // Match heading like ## [1.14.0] or ## [1.14.0] - 2026-08-13
  const regex = new RegExp(`##\\s*\\[?${escapedVersion}\\]?[^\n]*\n([\\s\\S]*?)(?=\n##\\s*\\[|\\s*$)`, 'i');
  const match = content.match(regex);
  if (!match || !match[1].trim()) {
    return null;
  }
  return match[1].trim();
}

function processReleases() {
  const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) {
    console.error('CHANGELOG.md not found');
    process.exit(1);
  }
  const changelogContent = fs.readFileSync(changelogPath, 'utf8');

  // Get current ref tag if triggered by tag push
  const currentTag = process.env.GITHUB_REF_NAME || '';

  let existingReleases = [];
  try {
    const ghOutput = execSync('gh release list --limit 1000 --json tagName', { encoding: 'utf8' });
    existingReleases = JSON.parse(ghOutput).map(r => r.tagName);
  } catch (err) {
    console.warn('Could not fetch existing releases via gh CLI:', err.message);
  }

  let tagsToProcess = [];
  if (currentTag && currentTag.startsWith('v')) {
    tagsToProcess.push(currentTag);
  }

  // Get all local git tags matching v*
  try {
    const gitTags = execSync('git tag -l "v*"', { encoding: 'utf8' })
      .split('\n')
      .map(t => t.trim())
      .filter(Boolean);
    for (const tag of gitTags) {
      if (!tagsToProcess.includes(tag)) {
        tagsToProcess.push(tag);
      }
    }
  } catch (err) {
    console.warn('Could not list git tags:', err.message);
  }

  console.log(`Checking ${tagsToProcess.length} tag(s)...`);

  for (const tag of tagsToProcess) {
    if (existingReleases.includes(tag)) {
      console.log(`Release for ${tag} already exists. Skipping.`);
      continue;
    }

    const notes = extractChangelog(changelogContent, tag);
    if (!notes) {
      console.log(`No changelog notes found for ${tag}. Skipping.`);
      continue;
    }

    console.log(`Creating GitHub Release for ${tag}...`);
    const tempNotesFile = path.join(process.cwd(), `.release_notes_${tag.replace(/[^a-zA-Z0-9.-]/g, '_')}.md`);
    fs.writeFileSync(tempNotesFile, notes, 'utf8');

    try {
      execSync(`gh release create "${tag}" --title "${tag}" --notes-file "${tempNotesFile}"`, {
        stdio: 'inherit'
      });
      console.log(`Successfully published release for ${tag}.`);
    } catch (err) {
      console.error(`Failed to create release for ${tag}:`, err.message);
    } finally {
      if (fs.existsSync(tempNotesFile)) {
        fs.unlinkSync(tempNotesFile);
      }
    }
  }
}

if (require.main === module) {
  processReleases();
}

module.exports = { extractChangelog, processReleases };
