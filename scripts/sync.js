/**
 * repo-tracker — sync.js
 *
 * Fetches all repos for the authenticated GitHub user and:
 *   1. Captures star count, topics, language, and a rich README summary per repo
 *   2. For forks: fetches upstream "about" info (description, stars, topics, watchers)
 *      and a full upstream README summary so you can evaluate the source repo
 *   3. Detects upstream drift (fork behind upstream by commit SHA)
 *   4. Auto-rebases drifted forks via the GitHub Merge-upstream API (rebase strategy)
 *      — skips silently and flags in the index if it fails (e.g. merge conflict)
 *   5. Writes repo-index.json  (structured data)
 *   6. Writes README.md        (full repo index — replaced each run)
 *   7. Writes + pushes profile-readme/README.md to your GitHub profile repo
 *      using safe marker-based injection (preserves existing profile content)
 */

const https = require("https");
const fs    = require("fs");
const path  = require("path");

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

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function ghRequest(method, urlPath, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const options = {
      hostname: "api.github.com",
      path:     urlPath,
      method,
      headers: {
        Authorization:          `Bearer ${GITHUB_TOKEN}`,
        Accept:                 "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent":           "repo-tracker-action",
        "Content-Type":         "application/json",
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let b = "";
      res.on("data", (chunk) => (b += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(b) }); }
        catch { resolve({ status: res.statusCode, data: b }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const ghGet  = (p)    => ghRequest("GET",  p, null);
const ghPost = (p, b) => ghRequest("POST", p, b);
const ghPut  = (p, b) => ghRequest("PUT",  p, b);

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

// ─── Upstream "about" info ────────────────────────────────────────────────────
// Fetches the full repo metadata for the upstream (parent) repo so we can
// surface its description, star count, topics, watcher count, and license.

async function fetchUpstreamAbout(parentFullName) {
  try {
    const { status, data } = await ghGet(`/repos/${parentFullName}`);
    if (status !== 200) return null;
    return {
      full_name:   data.full_name,
      url:         data.html_url,
      description: data.description || null,
      stars:       data.stargazers_count,
      forks:       data.forks_count,
      watchers:    data.subscribers_count,
      language:    data.language || null,
      topics:      data.topics || [],
      license:     data.license?.spdx_id || null,
      last_pushed: data.pushed_at || null,
      open_issues: data.open_issues_count,
      archived:    data.archived,
    };
  } catch {
    return null;
  }
}

// ─── README summary extraction ────────────────────────────────────────────────

function extractTextFromReadme(raw) {
  const cleaned = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+.+$/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/^\s*[-*>|]+\s*/gm, "")
    .replace(/\|.+\|/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const paragraphs = cleaned
    .split(/\n\n+/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter((p) => p.length > 40);

  return paragraphs.slice(0, 3).join(" ").slice(0, 500) || null;
}

async function fetchReadmeSummary(ownerSlashRepo) {
  try {
    const { status, data } = await ghGet(`/repos/${ownerSlashRepo}/readme`);
    if (status !== 200 || !data.content) return null;
    const raw = Buffer.from(data.content, "base64").toString("utf8");
    return extractTextFromReadme(raw);
  } catch {
    return null;
  }
}

// ─── Drift detection ──────────────────────────────────────────────────────────

async function checkUpstreamDrift(owner, repo, parentFullName) {
  try {
    const { status: s1, data: upstreamCommits } = await ghGet(
      `/repos/${parentFullName}/commits?per_page=1`
    );
    if (s1 !== 200 || !Array.isArray(upstreamCommits)) return { drifted: false };

    const upstreamSha  = upstreamCommits[0]?.sha;
    const upstreamDate = upstreamCommits[0]?.commit?.committer?.date;

    const { status: s2, data: forkCommits } = await ghGet(
      `/repos/${owner}/${repo}/commits?per_page=1`
    );
    if (s2 !== 200 || !Array.isArray(forkCommits)) return { drifted: false };

    return {
      drifted:              upstreamSha !== forkCommits[0]?.sha,
      upstreamLatestCommit: upstreamDate || null,
      upstreamRepo:         parentFullName,
    };
  } catch {
    return { drifted: false };
  }
}

// ─── Auto-rebase fork ─────────────────────────────────────────────────────────
// Uses the GitHub "merge upstream" API which performs a fast-forward or rebase
// on the fork's default branch. On conflict it returns 409 — we catch that,
// skip silently, and set sync_status = "conflict" in the index entry.

async function rebaseFork(owner, repo, defaultBranch) {
  try {
    const { status, data } = await ghPost(
      `/repos/${owner}/${repo}/merge-upstream`,
      { branch: defaultBranch }
    );

    if (status === 200) {
      return { synced: true,  sync_status: "synced",   message: data.message || "Rebased successfully." };
    } else if (status === 409) {
      return { synced: false, sync_status: "conflict", message: "Merge conflict — manual resolution required." };
    } else if (status === 422) {
      return { synced: false, sync_status: "already_up_to_date", message: data.message || "Already up to date." };
    } else {
      return { synced: false, sync_status: "error",    message: `HTTP ${status}: ${data?.message || "Unknown error"}` };
    }
  } catch (err) {
    return { synced: false, sync_status: "error", message: err.message };
  }
}

// ─── Build entry per repo ─────────────────────────────────────────────────────

async function buildEntry(repo) {
  const owner      = repo.owner.login;
  const name       = repo.name;
  const parentName = repo.fork && repo.parent ? repo.parent.full_name : null;

  console.log(`  ↳ ${owner}/${name}${parentName ? ` (fork of ${parentName})` : ""}`);

  // Own README summary
  const ownReadme = await fetchReadmeSummary(`${owner}/${name}`);
  const ownSummary = ownReadme || repo.description?.trim() || "No description available.";

  // Fork-specific enrichment
  let upstreamAbout   = null;
  let upstreamSummary = null;
  let upstreamInfo    = {};
  let syncResult      = {};

  if (repo.fork && parentName) {
    // Fetch upstream about info + README + drift in parallel
    [upstreamAbout, upstreamSummary, upstreamInfo] = await Promise.all([
      fetchUpstreamAbout(parentName),
      fetchReadmeSummary(parentName),
      checkUpstreamDrift(owner, name, parentName),
    ]);

    // Auto-rebase if drifted
    if (upstreamInfo.drifted) {
      const branch = repo.default_branch || "main";
      console.log(`    ↪ Drifted — attempting rebase on '${branch}'…`);
      syncResult = await rebaseFork(owner, name, branch);
      console.log(`    ↪ Sync result: ${syncResult.sync_status} — ${syncResult.message}`);
    }
  }

  return {
    name,
    full_name:        repo.full_name,
    url:              repo.html_url,
    stars:            repo.stargazers_count,
    forks:            repo.forks_count,
    language:         repo.language || null,
    topics:           repo.topics  || [],
    private:          repo.private,
    archived:         repo.archived,
    fork:             repo.fork,
    default_branch:   repo.default_branch || "main",
    summary:          ownSummary,
    upstream_summary: upstreamSummary,
    last_pushed:      repo.pushed_at,
    last_synced:      new Date().toISOString(),
    upstream: repo.fork ? {
      parent:               parentName,
      about:                upstreamAbout,
      ...upstreamInfo,
      // sync result — only present for drifted forks
      ...(upstreamInfo.drifted ? {
        sync_status:    syncResult.sync_status    || null,
        sync_message:   syncResult.sync_message   || null,
        synced:         syncResult.synced         || false,
      } : {}),
    } : null,
  };
}

// ─── Profile README: safe marker-based injection ─────────────────────────────

const MARKER_START = "<!-- REPO-TRACKER:START -->";
const MARKER_END   = "<!-- REPO-TRACKER:END -->";

async function pushProfileReadme(dashboardBlock) {
  const filePath = "README.md";
  const { status: getStatus, data: fileData } = await ghGet(
    `/repos/${GITHUB_USERNAME}/${GITHUB_USERNAME}/contents/${filePath}`
  );

  let existingContent = "";
  let sha;

  if (getStatus === 200 && fileData.content) {
    existingContent = Buffer.from(fileData.content, "base64").toString("utf8");
    sha = fileData.sha;
  } else {
    console.warn("⚠️  No existing profile README found — creating one with markers.");
    existingContent = `${MARKER_START}\n${MARKER_END}\n`;
  }

  if (!existingContent.includes(MARKER_START) || !existingContent.includes(MARKER_END)) {
    console.warn("⚠️  Markers not found — appending dashboard at the bottom.");
    console.warn(`   Add these lines to your profile README to control placement:`);
    console.warn(`   ${MARKER_START}`);
    console.warn(`   ${MARKER_END}`);
    existingContent = existingContent.trimEnd()
      + `\n\n${MARKER_START}\n${dashboardBlock}\n${MARKER_END}\n`;
  } else {
    const before = existingContent.substring(
      0, existingContent.indexOf(MARKER_START) + MARKER_START.length
    );
    const after = existingContent.substring(existingContent.indexOf(MARKER_END));
    existingContent = `${before}\n${dashboardBlock}\n${after}`;
  }

  const { status } = await ghPut(
    `/repos/${GITHUB_USERNAME}/${GITHUB_USERNAME}/contents/${filePath}`,
    {
      message: `chore: update repo-tracker dashboard — ${new Date().toUTCString()}`,
      content: Buffer.from(existingContent).toString("base64"),
      ...(sha ? { sha } : {}),
    }
  );
  return { status };
}

// ─── Strip markdown/HTML from a string (for display in tables) ───────────────

function stripMarkdown(str) {
  if (!str) return "";
  return str
    .replace(/<[^>]+>/g, "")          // HTML tags
    .replace(/!\[.*?\]\(.*?\)/g, "")  // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → text
    .replace(/[`*_~]/g, "")           // markdown formatting
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Render tracker README.md ─────────────────────────────────────────────────

function renderTrackerReadme(entries, username) {
  const now        = new Date().toUTCString();
  const totalStars = entries.reduce((s, e) => s + e.stars, 0);
  const drifted    = entries.filter((e) => e.upstream?.drifted);
  const synced     = entries.filter((e) => e.upstream?.synced);
  const conflicts  = entries.filter((e) => e.upstream?.sync_status === "conflict");
  const languages  = [...new Set(entries.map((e) => e.language).filter(Boolean))].sort();

  const repoTable = [...entries]
    .sort((a, b) => b.stars - a.stars)
    .map((e) => {
      const syncBadge = e.upstream?.sync_status === "synced"   ? "🔄 auto-synced"
                      : e.upstream?.sync_status === "conflict" ? "⚡ conflict"
                      : e.upstream?.drifted                    ? "⚠️ drift"
                      : "";
      const flags = [
        e.archived            ? "🗄 archived" : "",
        e.private             ? "🔒 private"  : "",
        syncBadge,
      ].filter(Boolean).join(" ");
      const topics = e.topics.length ? e.topics.map((t) => `\`${t}\``).join(" ") : "—";
      const displayStars = e.fork && e.upstream?.about?.stars != null
        ? `${e.stars} (↑ ${e.upstream.about.stars.toLocaleString()} upstream)`
        : e.stars;
      return `| [${e.name}](${e.url}) | ⭐ ${displayStars} | ${e.language || "—"} | ${topics} | ${flags || "✅"} |`;
    })
    .join("\n");

  // Drift + sync section
  const driftRows = drifted.map((e) => {
    const badge = e.upstream.sync_status === "synced"   ? "✅ auto-rebased"
                : e.upstream.sync_status === "conflict" ? "⚡ conflict — needs manual fix"
                : "⚠️ not synced";
    return `- **[${e.name}](${e.url})** ← [\`${e.upstream.upstreamRepo}\`](https://github.com/${e.upstream.upstreamRepo}) | upstream commit: ${e.upstream.upstreamLatestCommit || "unknown"} | sync: ${badge}`;
  }).join("\n");

  const driftSection = drifted.length > 0
    ? `\n## ⚠️ Fork Sync Status\n\n${driftRows}\n`
    : "";

  // Per-repo summaries
  const summaries = [...entries]
    .sort((a, b) => b.stars - a.stars)
    .map((e) => {
      let upstreamBlock = "";
      if (e.fork && e.upstream) {
        const about = e.upstream.about;
        const aboutLine = about
          ? `**⭐ ${about.stars.toLocaleString()} stars** &nbsp;|&nbsp; **👁 ${about.watchers} watchers** &nbsp;|&nbsp; **🍴 ${about.forks} forks**${about.license ? ` &nbsp;|&nbsp; License: \`${about.license}\`` : ""}${about.archived ? " &nbsp;|&nbsp; 🗄 _archived upstream_" : ""}`
          : "";
        const topicsLine = about?.topics?.length
          ? `Topics: ${about.topics.map((t) => `\`${t}\``).join(" ")}`
          : "";
        const descLine = about?.description
          ? `> ${about.description}`
          : "";
        const readmeLine = e.upstream_summary
          ? e.upstream_summary
          : "_No upstream README found._";
        const syncLine = e.upstream.sync_status === "synced"
          ? `\n> ✅ **Auto-rebased** this run — fork is now up to date.`
          : e.upstream.sync_status === "conflict"
          ? `\n> ⚡ **Rebase failed — merge conflict.** Manual resolution required on your fork.`
          : e.upstream.drifted
          ? `\n> ⚠️ **Fork is behind upstream** — last upstream commit: ${e.upstream.upstreamLatestCommit || "unknown"}`
          : `\n> ✅ Fork is up to date with upstream.`;

        upstreamBlock = `
**🔍 Upstream: [\`${e.upstream.upstreamRepo || e.upstream.parent}\`](https://github.com/${e.upstream.upstreamRepo || e.upstream.parent})**
${aboutLine}
${topicsLine}
${descLine}

${readmeLine}
${syncLine}`;
      }

      return `### [${e.name}](${e.url})${e.fork ? " _(fork)_" : ""}

**📝 Your repo:** ${stripMarkdown(e.summary)}
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
| Forks behind upstream | ${drifted.length} |
| Forks auto-rebased this run | ${synced.length} |
| Forks needing manual fix | ${conflicts.length} |
${driftSection}
## 📋 All Repositories

| Repo | Stars | Language | Topics | Status |
|------|-------|----------|--------|--------|
${repoTable}

## 🔍 Repo Summaries

${summaries}

---
*Generated by [repo-tracker](https://github.com/${username}/repo-tracker)*
`;
}

// ─── Render profile dashboard block ──────────────────────────────────────────

function renderProfileReadme(entries, username) {
  const now        = new Date().toUTCString();
  const totalStars = entries.reduce((s, e) => s + e.stars, 0);
  const drifted    = entries.filter((e) => e.upstream?.drifted);
  const conflicts  = entries.filter((e) => e.upstream?.sync_status === "conflict");
  const active     = entries.filter((e) => !e.archived && !e.fork);

  const topRepos = [...entries].sort((a, b) => b.stars - a.stars).slice(0, 6);

  const topLanguages = Object.entries(
    entries.reduce((acc, e) => {
      if (e.language) acc[e.language] = (acc[e.language] || 0) + 1;
      return acc;
    }, {})
  ).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const recentlyUpdated = [...entries]
    .filter((e) => e.last_pushed)
    .sort((a, b) => new Date(b.last_pushed) - new Date(a.last_pushed))
    .slice(0, 5);

  const topRepoCards = topRepos
    .map((e) => {
      // For forks: show upstream description + upstream stars
      const desc    = e.fork && e.upstream?.about?.description
                        ? e.upstream.about.description
                        : stripMarkdown(e.summary);
      const stars   = e.fork && e.upstream?.about?.stars != null
                        ? e.upstream.about.stars.toLocaleString() + " ↑"
                        : e.stars;
      const lang    = (e.fork && e.upstream?.about?.language) || e.language || "—";
      const display = desc.slice(0, 65) + (desc.length > 65 ? "…" : "");
      return `| [**${e.name}**](${e.url}) | ${display} | ⭐ ${stars} | ${lang} |`;
    })
    .join("\n");

  const langBar = topLanguages.map(([lang, count]) => `\`${lang}\` ×${count}`).join("  ");

  const recentRows = recentlyUpdated
    .map((e) => `| [${e.name}](${e.url}) | ${new Date(e.last_pushed).toDateString()} | ⭐ ${e.stars} |`)
    .join("\n");

  const driftAlert = conflicts.length > 0
    ? `\n> ⚡ **${conflicts.length} fork(s) have merge conflicts** — [view details](https://github.com/${username}/repo-tracker)\n`
    : drifted.length > 0
    ? `\n> 🔄 **${drifted.length} fork(s) were auto-rebased** this run — [view details](https://github.com/${username}/repo-tracker)\n`
    : `\n> ✅ All forks are up to date.\n`;

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
    console.warn(`⚠️  Profile README push returned HTTP ${status}. Check that your PAT has Contents: Read+Write on the ${GITHUB_USERNAME}/${GITHUB_USERNAME} repo.`);
  }

  // Final summary
  const drifted   = entries.filter((e) => e.upstream?.drifted);
  const synced    = entries.filter((e) => e.upstream?.synced);
  const conflicts = entries.filter((e) => e.upstream?.sync_status === "conflict");

  if (drifted.length > 0) {
    console.log(`\n📊 Fork sync summary:`);
    synced.forEach((e)    => console.log(`   ✅ ${e.name} — auto-rebased`));
    conflicts.forEach((e) => console.log(`   ⚡ ${e.name} — conflict, needs manual fix`));
  } else {
    console.log("\n✅ All forks up to date — no sync needed.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
