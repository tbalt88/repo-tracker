# 📦 repo-tracker

> A self-updating GitHub Action that crawls all your repos, captures star counts, topics,
> summaries, detects upstream fork drift, and auto-updates your GitHub profile dashboard.

**This README is replaced on every sync with your live repo index.**

---

## 🚀 One-time Setup

### Step 1 — Create a Fine-grained PAT

1. Go to **GitHub → Settings → Developer Settings → Personal Access Tokens → Fine-grained tokens**
2. Click **Generate new token**
3. Set expiration (90 days or no expiration)
4. Under **Repository access**, choose **All repositories**
5. Under **Permissions**, enable:
   - `Contents` → **Read and write** *(needed to update your profile README)*
   - `Metadata` → **Read-only**
6. Copy the token — you won't see it again

### Step 2 — Add Secrets to this repo

**Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
|-------------|-------|
| `TRACKER_PAT` | The PAT from Step 1 |
| `TRACKER_USERNAME` | Your GitHub username (e.g. `octocat`) |

### Step 3 — Ensure your profile README repo exists

Your GitHub profile README lives at `github.com/<username>/<username>`.
If it doesn't exist yet:
1. Create a **new public repo** named exactly your username
2. Add any README.md (it will be replaced on first sync)

### Step 4 — Trigger the first run

**Actions → 🔄 Repo Tracker Sync → Run workflow → Run workflow**

On completion:
- `README.md` in this repo → full repo index
- `repo-index.json` → structured data
- `profile-readme/README.md` → local copy of what was pushed
- Your profile at `github.com/<username>` → live dashboard

---

## ⏰ Changing the Schedule

Edit `.github/workflows/sync.yml`:

```yaml
- cron: "0 6 * * *"    # daily at 06:00 UTC  (default)
- cron: "0 */6 * * *"  # every 6 hours
- cron: "0 9 * * 1"    # every Monday at 09:00 UTC
```

---

## 📁 Output Files

| File | Description |
|------|-------------|
| `README.md` | Full repo index with summaries, stars, topics (auto-replaced each run) |
| `repo-index.json` | Complete structured data — feed other tools or dashboards from this |
| `profile-readme/README.md` | Local copy of the profile dashboard that was pushed |

---

## ⚠️ Upstream Drift Detection

For every forked repo, the tracker compares the latest commit SHA on your fork against
the upstream parent. A mismatch is flagged with ⚠️ in both outputs and on your profile.
