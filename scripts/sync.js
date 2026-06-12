/**
 * repo-tracker — sync.js
 *
 * Fetches all repos for the authenticated GitHub user and:
 *   1. Captures star count, topics, language, and a short summary per repo
 *   2. Detects upstream drift for forks
 *   3. Writes repo-index.json  (structured data)
 *   4. Writes README.md        (full repo index — replaces this file each run)
 *   5. Writes profile-readme/README.md  (dashboard for your GitHub profile)
 */

const https = require("https");
const fs = require("fs");
const path = require("path");

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;
const ROOT            = path.join(__dirname, "..");
const OUTPUT_JSON     = path.join(ROOT, "repo-index.json");
const OUTPUT_README   = path.join(ROOT, "README.md");
const PROFILE_DIR     = path.join(ROOT, "profile-readme");
const OUTPUT_PROFILE  = path.join(PROFILE_DIR, "README.md");

if (!GITHUB_TOKEN || !GITHUB_USERNAME) {
  console.error("❌  GITHUB_TOKEN and GITHUB_USERNAME must be set.");
  process.exit(1);
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function ghGet(urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: urlPath,
      method: "GET",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "repo-tracker-action",
      },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ─── Update profile repo via GitHub API (safe merge — only updates marked section) ───

const MARKER_START = "<!-- REPO-TRACKER:START -->";
const MARKER_END   = "<!-- REPO-TRACKER:END -->";

async function pushProfileReadme(dashboardBlock) {
  const profileRepo = GITHUB_USERNAME;
  const filePath    = "README.md";

  // Fetch current file (we need the SHA to update, and the content to merge into)
  const { status: getStatus, data: fileData } = await ghGet(
    `/repos/${GITHUB_USERNAME}/${profileRepo}/contents/${filePath}`
  );

  let existingContent = "";
  let sha;

  if (getStatus === 200 && fileData.content) {
    existingContent = Buffer.from(fileData.content, "base64").toString("utf8");
    sha = fileData.sha;
  } else {
    // Profile README doesn't exist yet — create it from scratch with markers
    console.warn("⚠️  No existing profile README found. Creating one with markers.");
    existingContent = `${MARKER_START}\n${MARKER_END}\n`;
  }

  // Check if markers exist in the file
  if (!existingContent.includes(MARKER_START) || !existingContent.includes(MARKER_END)) {
    // Markers not present — append the dashboard block at the bottom
    console.warn("⚠️  Markers not found in profile README. Appending dashboard at the bottom.");
    console.warn(`   To control placement, add these two lines anywhere in your profile README:`);
    console.warn(`   ${MARKER_START}`);
    console.warn(`   ${MARKER_END}`);
    existingContent = existingContent.trimEnd()
      + `\n\n${MARKER_START}\n${dashboardBlock}\n${MARKER_END}\n`;
  } else {
    // Replace only the content between the markers
    const before = existingContent.substring(0, existingContent.indexOf(MARKER_START) + MARKER_START.length);
    const after  = existingContent.substring(existingContent.indexOf(MARKER_END));
    existingContent = `${before}\n${dashboardBlock}\n${after}`;
  }

  const body = JSON.stringify({
    message: `chore: update repo-tracker dashboard — ${new Date().toUTCString()}`,
    content: Buffer.from(existingContent).toString("base64"),
    ...(sha ? { sha } : {}),
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: `/repos/${GITHUB_USERNAME}/${profileRepo}/contents/${filePath}`,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "repo-tracker-action",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let b = "";
      res.on("data", (chunk) => (b += chunk));
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Fetch all repos (handles pagination) ────────────────────────────────────

async function fetchAllRepos() {
  let page = 1;
  const all = [];
  while (true) {
    const { data } = await ghGet(
      `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner`
    );
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return all;
}

// ─── Fetch README and build a rich summary ───────────────────────────────────
//
// For forks: also fetches the upstream (parent) repo README so you can
// evaluate the source, not just your fork snapshot.
// Returns an object: { own, upstream } — both are plain text summaries.

function extractTextFromReadme(raw) {
  // Strip markdown noise and extract meaningful paragraphs
  const cleaned = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[.*?\]\(.*?\)/g, "")          // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // links → text
    .replace(/^#{1,6}\s+.+$/gm, "")              // headings
    .replace(/```[\s\S]*?```/g, "")              // code blocks
    .replace(/`[^`]+`/g, "")                      // inline code
    .replace(/^\s*[-*>|]+\s*/gm, "")             // bullets/blockquotes/tables
    .replace(/\|.+\|/g, "")                      // table rows
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Collect up to 3 meaningful paragraphs for a richer summary
  const paragraphs = cleaned
    .split(/\n\n+/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter((p) => p.length > 40);

  return paragraphs.slice(0, 3).join(" ").slice(0, 500) || null;
}

async function fetchReadmeSummary(owner, repo) {
  try {
    const { status, data } = await ghGet(`/repos/${owner}/${repo}/readme`);
    if (status !== 200 || !data.content) return null;
    const raw = Buffer.from(data.content, "base64").toString("utf8");
    return extractTextFromReadme(raw);
  } catch {
    return null;
  }
}

async function fetchSummary(owner, repo, description, parentFullName) {
  // Always try to get a README-based summary (richer than description alone)
  const readmeSummary = await fetchReadmeSummary(owner, repo);
  const ownSummary    = readmeSummary || description?.trim() || "No description available.";

  // For forks: also fetch the upstream README so we can evaluate the source
  let upstreamSummary = null;
  if (parentFullName) {
    const [parentOwner, parentRepo] = parentFullName.split("/");
    const upstreamReadme = await fetchReadmeSummary(parentOwner, parentRepo);
    upstreamSummary = upstreamReadme || null;
  }

  return { own: ownSummary, upstream: upstreamSummary };
}

// ─── Check if a fork is behind its upstream ───────────────────────────────────

async function checkUpstreamDrift(owner, repo, parentFullName) {
  try {
    const [parentOwner, parentRepo] = parentFullName.split("/");

    const { status: s1, data: upstreamData } = await ghGet(
      `/repos/${parentOwner}/${parentRepo}/commits?per_page=1`
    );
    if (s1 !== 200 || !Array.isArray(upstreamData)) return { drifted: false };

    const upstreamSha  = upstreamData[0]?.sha;
    const upstreamDate = upstreamData[0]?.commit?.committer?.date;

    const { status: s2, data: forkData } = await ghGet(
      `/repos/${owner}/${repo}/commits?per_page=1`
    );
    if (s2 !== 200 || !Array.isArray(forkData)) return { drifted: false };

    const forkSha = forkData[0]?.sha;

    return {
      drifted: upstreamSha !== forkSha,
      upstreamLatestCommit: upstreamDate || null,
      upstreamRepo: parentFullName,
    };
  } catch {
    return { drifted: false };
  }
}

// ─── Build entry per repo ─────────────────────────────────────────────────────

async function buildEntry(repo) {
  const owner      = repo.owner.login;
  const name       = repo.name;
  const parentName = repo.fork && repo.parent ? repo.parent.full_name : null;
  console.log(`  ↳ ${owner}/${name}${parentName ? ` (fork of ${parentName})` : ""}`);

  const summary      = await fetchSummary(owner, name, repo.description, parentName);
  const upstreamInfo = repo.fork && repo.parent
    ? await checkUpstreamDrift(owner, name, repo.parent.full_name)
    : {};

  return {
    name,
    full_name:        repo.full_name,
    url:              repo.html_url,
    stars:            repo.stargazers_count,
    forks:            repo.forks_count,
    language:         repo.language || null,
    topics:           repo.topics || [],
    private:          repo.private,
    archived:         repo.archived,
    fork:             repo.fork,
    summary:          summary.own,
    upstream_summary: summary.upstream,
    last_pushed:      repo.pushed_at,
    last_synced:      new Date().toISOString(),
    upstream:    repo.fork
      ? { parent: repo.parent?.full_name || null, ...upstreamInfo }
      : null,
  };
}

// ─── Render tracker README.md ─────────────────────────────────────────────────

function renderTrackerReadme(entries, username) {
  const now        = new Date().toUTCString();
  const totalStars = entries.reduce((s, e) => s + e.stars, 0);
  const drifted    = entries.filter((e) => e.upstream?.drifted);
  const languages  = [...new Set(entries.map((e) => e.language).filter(Boolean))].sort();

  const repoTable = [...entries]
    .sort((a, b) => b.stars - a.stars)
    .map((e) => {
      const flags  = [
        e.archived       ? "🗄 archived"        : "",
        e.private        ? "🔒 private"          : "",
        e.upstream?.drifted ? "⚠️ upstream drift" : "",
      ].filter(Boolean).join(" ");
      const topics = e.topics.length ? e.topics.map((t) => `\`${t}\``).join(" ") : "—";
      return `| [${e.name}](${e.url}) | ⭐ ${e.stars} | ${e.language || "—"} | ${topics} | ${flags || "✅"} |`;
    })
    .join("\n");

  const driftSection = drifted.length > 0
    ? `\n## ⚠️ Forks with Upstream Drift\n\n${drifted
        .map((e) => `- **[${e.name}](${e.url})** — upstream: [\`${e.upstream.upstreamRepo}\`](https://github.com/${e.upstream.upstreamRepo}) | last upstream commit: ${e.upstream.upstreamLatestCommit || "unknown"}`)
        .join("\n")}\n`
    : "";

  const summaries = [...entries]
    .sort((a, b) => b.stars - a.stars)
    .map((e) => {
      const upstreamBlock = e.fork && e.upstream
        ? `\n**🔍 Upstream source** (\`${e.upstream.upstreamRepo || e.upstream.parent}\`):\n${e.upstream_summary || "_No upstream README found._"}\n${e.upstream?.drifted ? `\n> ⚠️ **Your fork is behind upstream** — last upstream commit: ${e.upstream.upstreamLatestCommit || "unknown"}` : "\n> ✅ Fork is up to date with upstream"}`
        : "";

      return `### [${e.name}](${e.url})${e.fork ? " _(fork)_" : ""}

**📝 Your repo:** ${e.summary}
${upstreamBlock}

- **Stars:** ⭐ ${e.stars} &nbsp;|&nbsp; **Forks:** 🍴 ${e.forks} &nbsp;|&nbsp; **Language:** ${e.language || "N/A"}
- **Topics:** ${e.topics.length ? e.topics.join(", ") : "None"}
- **Last pushed:** ${e.last_pushed ? new Date(e.last_pushed).toDateString() : "N/A"}`;
    })
    .join("\n\n---\n\n");

  return `# 📦 Repo Index — @${username}

> Auto-generated by [repo-tracker](https://github.com/${username}/repo-tracker) · Last updated: **${now}**

## 📊 Summary

| Metric | Value |
|--------|-------|
| Total repos | ${entries.length} |
| Total stars earned | ⭐ ${totalStars} |
| Languages used | ${languages.join(", ") || "—"} |
| Forks with upstream drift | ${drifted.length} |

## 📋 All Repositories

| Repo | Stars | Language | Topics | Status |
|------|-------|----------|--------|--------|
${repoTable}
${driftSection}
## 🔍 Repo Summaries

${summaries}

---
*Generated by [repo-tracker](https://github.com/${username}/repo-tracker)*
`;
}

// ─── Render profile README.md (GitHub profile dashboard) ─────────────────────

function renderProfileReadme(entries, username) {
  const now        = new Date().toUTCString();
  const totalStars = entries.reduce((s, e) => s + e.stars, 0);
  const drifted    = entries.filter((e) => e.upstream?.drifted);
  const active     = entries.filter((e) => !e.archived && !e.fork);

  const topRepos = [...entries]
    .sort((a, b) => b.stars - a.stars)
    .slice(0, 6);

  const topLanguages = Object.entries(
    entries.reduce((acc, e) => {
      if (e.language) acc[e.language] = (acc[e.language] || 0) + 1;
      return acc;
    }, {})
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const recentlyUpdated = [...entries]
    .filter((e) => e.last_pushed)
    .sort((a, b) => new Date(b.last_pushed) - new Date(a.last_pushed))
    .slice(0, 5);

  const topRepoCards = topRepos
    .map((e) => `| [**${e.name}**](${e.url}) | ${e.summary.slice(0, 60)}${e.summary.length > 60 ? "…" : ""} | ⭐ ${e.stars} | ${e.language || "—"} |`)
    .join("\n");

  const langBar = topLanguages
    .map(([lang, count]) => `\`${lang}\` ×${count}`)
    .join("  ");

  const recentRows = recentlyUpdated
    .map((e) => `| [${e.name}](${e.url}) | ${new Date(e.last_pushed).toDateString()} | ⭐ ${e.stars} |`)
    .join("\n");

  const driftAlert = drifted.length > 0
    ? `\n> ⚠️ **${drifted.length} fork${drifted.length > 1 ? "s" : ""} with upstream drift** — [view details](https://github.com/${username}/repo-tracker)\n`
    : `\n> ✅ All forks are up to date with their upstream sources.\n`;

  // Returns only the dashboard block — markers and surrounding content in your
  // profile README are preserved; only the section between the markers is replaced.
  return `<!-- Auto-updated: ${now} -->

## 📊 GitHub Dashboard

| Metric | Value |
|--------|-------|
| 📦 Public repos | ${active.length} |
| ⭐ Total stars earned | ${totalStars} |
| 🍴 Forks maintained | ${entries.filter((e) => e.fork).length} |
| 🗄 Archived | ${entries.filter((e) => e.archived).length} |
${driftAlert}
---

## 🏆 Top Repositories

| Repo | Description | Stars | Language |
|------|-------------|-------|----------|
${topRepoCards}

> 📋 [See full repo index →](https://github.com/${username}/repo-tracker)

---

## 🛠 Top Languages

${langBar}

---

## 🕐 Recently Updated

| Repo | Last Push | Stars |
|------|-----------|-------|
${recentRows}

---

<sub>🤖 Auto-updated daily by <a href="https://github.com/${username}/repo-tracker">repo-tracker</a></sub>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`🔍 Fetching repos for @${GITHUB_USERNAME}…`);
  const repos = await fetchAllRepos();
  console.log(`   Found ${repos.length} repos.\n`);

  const entries = [];
  for (const repo of repos) {
    entries.push(await buildEntry(repo));
  }

  // 1. Write repo-index.json
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(entries, null, 2), "utf8");
  console.log(`\n✅ Wrote repo-index.json (${entries.length} entries)`);

  // 2. Write tracker README.md
  fs.writeFileSync(OUTPUT_README, renderTrackerReadme(entries, GITHUB_USERNAME), "utf8");
  console.log("✅ Wrote README.md (tracker index)");

  // 3. Write + push profile README
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const profileContent = renderProfileReadme(entries, GITHUB_USERNAME);
  fs.writeFileSync(OUTPUT_PROFILE, profileContent, "utf8");
  console.log("✅ Wrote profile-readme/README.md (local copy)");

  console.log("📤 Pushing profile README to GitHub profile repo…");
  const { status } = await pushProfileReadme(profileContent);
  if (status === 200 || status === 201) {
    console.log("✅ Profile README updated on GitHub.");
  } else {
    console.warn(`⚠️  Profile README push returned HTTP ${status}. Check that your PAT has write access to the <username>/<username> repo.`);
  }

  // Drift summary
  const drifted = entries.filter((e) => e.upstream?.drifted);
  if (drifted.length > 0) {
    console.log(`\n⚠️  Upstream drift in ${drifted.length} fork(s):`);
    drifted.forEach((e) => console.log(`   - ${e.name} ← ${e.upstream.upstreamRepo}`));
  } else {
    console.log("\n✅ No upstream drift detected.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
