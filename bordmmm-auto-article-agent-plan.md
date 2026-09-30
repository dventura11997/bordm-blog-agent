# Bordmmm — Auto-Article Agent Build Plan

**Site:** https://verdant-dodol-4106eb.netlify.app/ (React + Vite + TS, deployed on Netlify)
**Goal:** an automated agent that pulls anime news, writes an article in the site's existing voice, and publishes it to the live site roughly every 3 days, with no human in the loop.

---

## TL;DR

Move the articles out of `articleContent.ts` and into `src/content/articles/*.md` with a glob loader. Publishing then means dropping a new markdown file into a folder and pushing — Netlify rebuilds on push, and a bad run can never break the build.

Run the agent as a **GitHub Actions scheduled workflow**, not n8n. It's a cron job on GitHub's infrastructure that clones the repo into a throwaway VM, runs a Node script, and commits the result. No server to keep awake, no API token to manage (Actions has repo write access built in), and Claude Code can debug it in the same repo it lives in. Free: unlimited minutes on a public repo, 2,000/month on a private one, against usage of about 20 minutes a month.

The script: read four anime RSS feeds → drop anything already published → hand the candidates to Claude in a bounded tool loop (read-only tools: list candidates, list recent articles, fetch a page) so it picks the story, reads the source and avoids repeating itself → validate the JSON hard in code → write the file → commit. The model never gets a write tool.

Known trade-offs: it will eventually publish something factually wrong, it won't rank in search because it's rewriting other outlets' reporting, and it has no images. Build order is at the bottom — prove the publish path by hand before automating anything.

---

**Split of work:**
- **Phase 1** is a repo refactor — hand this whole section to Claude Code.
- **Phase 2** is the GitHub Actions workflow and the script it runs — also a Claude Code task.

---

## Core architectural decision

Articles currently live as `const`s inside a TypeScript component (`articleContent`). An automation must not edit that file. Programmatically rewriting a TS module means parsing and re-emitting code, and a single bad edit takes the whole build down — on a fully auto-publish setup, that means the site is broken until someone notices.

**Instead: move article data out of code and into content files.** The automation then only ever *creates a new file*. It never touches existing code. Worst case, a bad article appears; the site never breaks.

---

## Phase 1 — Repo refactor (Claude Code task)

### 1.1 Extract articles to markdown

Create `src/content/articles/` and move each article currently in `articleContent` into its own file, named `YYYY-MM-DD-slug.md`, with YAML frontmatter:

```yaml
---
title: "Article title"
slug: "article-title"
date: "2026-09-14"
excerpt: "One or two sentence summary used on cards and meta description."
tags: ["news", "seasonal-anime"]
sourceName: "Anime News Network"
sourceUrl: "https://..."
heroImage: ""
---

Body in markdown.
```

Keep every field the current article pages already use. If a field exists in the component but is not in this list, add it to the frontmatter rather than dropping it.

### 1.2 Build a loader

Use Vite's `import.meta.glob` with `eager: true` to load all files in `src/content/articles/`, parse frontmatter (`gray-matter` or equivalent), sort by `date` descending, and export the same shape the existing components already consume. Render the markdown body with `react-markdown`.

**Requirement: no visual or routing change.** Existing article URLs, listing cards, and page layout must render identically after the refactor. Verify by building and diffing against the current live site before deleting the old `articleContent` file.

Using a glob means no index file to maintain — dropping a new `.md` into the folder is the entire publish action.

### 1.3 Handle missing hero images

New auto-generated articles will not have images. Do not hotlink images from source outlets — that is someone else's copyright and a hotlink that breaks silently. Add a deterministic fallback in the card and article header when `heroImage` is empty (generated gradient seeded off the slug, or a small set of local placeholder art).

### 1.4 Create the style reference

Create `automation/style-samples.md` containing the three existing articles that best represent the voice you want cloned — full text, not excerpts. This file is read by the script and pasted into the writer prompt as few-shot examples. It is not imported by the app.

### 1.5 Create the kill switch

Create `automation/config.json`:

```json
{ "paused": false, "maxWords": 1200, "minWords": 300 }
```

The script reads this from the checked-out repo at the start of every run and exits immediately if `paused` is true. Flipping one boolean in the repo stops the agent.

### 1.6 Confirm and record

Claude Code should report back: the repo owner/name, default branch, the exact article folder path, and the full frontmatter schema it settled on.

---

## Phase 2 — GitHub Actions agent

### Why not n8n

The job is cron → fetch RSS → call an API → write a file → commit. GitHub Actions runs that for free, inside the repo it's committing to.

- **The trigger actually fires.** n8n's schedule trigger runs inside the n8n process; on a Render instance that spins down when idle, cron doesn't fire. GitHub's scheduler lives in their control plane and spins up a fresh VM whether or not anything of yours is awake.
- **No token to manage.** `actions/checkout` provides a scoped `GITHUB_TOKEN` with write access to its own repo. No fine-grained PAT to create, scope or renew.
- **Debuggable by Claude Code.** It's a script in the repo, not a canvas in a web UI.
- **Failure notification is built in.** A non-zero exit fails the workflow and GitHub emails you. No error branch to wire.

n8n stays the right tool for client work where someone else needs to see the flow, or where you're juggling OAuth across several services.

### 2.1 The workflow file

`.github/workflows/publish-article.yml`:

```yaml
name: Publish article

on:
  schedule:
    - cron: '0 21 */3 * *'   # every 3rd day, ~7-8am Melbourne
  workflow_dispatch:          # manual run button in the Actions tab

permissions:
  contents: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: node automation/publish.mjs
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      - name: Commit and push
        run: |
          git config user.name "bordmmm-bot"
          git config user.email "bot@users.noreply.github.com"
          git add src/content/articles automation/published.json
          git diff --staged --quiet || git commit -m "chore: publish article"
          git push
```

Notes:
- Add `ANTHROPIC_API_KEY` under repo Settings → Secrets and variables → Actions.
- `workflow_dispatch` is what you use to test without waiting three days.
- Actions cron can run 5–20 minutes late under load. Irrelevant at this cadence.
- GitHub disables scheduled workflows after 60 days of repo inactivity — this one commits every run, so it keeps itself alive.
- Netlify deploys off the push event, so the bot's commit triggers a build normally.

### 2.2 The script — `automation/publish.mjs`

Single Node script, roughly 200 lines, run top to bottom. Any failure should `process.exit(1)` with a clear message rather than publishing something marginal — the next run is three days away.

**Step 1 — Kill switch.** Read `automation/config.json`. Exit 0 if `paused`.

**Step 2 — Ingest.** Fetch and parse these feeds (`rss-parser`), in parallel, tolerating individual failures:

- Anime News Network — `https://www.animenewsnetwork.com/all/rss.xml`
- Crunchyroll News — `https://www.crunchyroll.com/news/rss`
- MyAnimeList news — `https://myanimelist.net/rss/news.xml`
- Otaku USA — `https://otakuusamagazine.com/feed/`

Verify each returns items during the build. Feed URLs move; drop a dead one rather than letting it block the run. No Apify — these are open feeds and a scraper is cost and breakage you don't need.

**Step 3 — Normalise.** Flatten to `{ title, link, pubDate, source, summary }`. Keep items from the last 7 days.

**Step 4 — Dedupe.** Read the existing filenames in `src/content/articles/` and the URL array in `automation/published.json` (from the local checkout — no API call needed). Drop candidates whose slug already exists, or whose `link` has already been used.

**Steps 5–7 — Select, research and write (bounded tool loop).** These three collapse into one agentic call: standard tool use on the Messages API, `claude-sonnet-4-6`, `max_turns: 5`.

Everything before this point stays deterministic — fetching feeds, deduping and sorting are sequences you know in advance, and code does them cheaper, faster and with a stack trace when they break. Handing those to a model costs 10x the tokens to reach an outcome you'd have got for free. The loop earns its place at exactly two things code can't do: deciding which story is actually worth covering, and knowing what the site has already said about it.

**Tools — all read-only:**

| Tool | Returns |
|---|---|
| `list_candidates()` | the deduped feed items from step 4 |
| `list_recent_articles()` | title, excerpt and date of the last ~10 published articles |
| `fetch_url(url)` | cleaned body text of a page, capped at ~6,000 characters |

`fetch_url` should be domain-allowlisted to the four source outlets plus their common syndication hosts. It's the only tool reaching the open internet, and the model is choosing the URL.

**The model never gets a write tool.** Validation and the file write stay in your code (steps 8 and 9). An unattended loop with commit access is a different risk category, and there's no upside — writing a file isn't a decision that needs judgement.

**System prompt:** you write for Bordmmm, an anime news site. Pick the single most newsworthy story from the candidates. Check what's already been published — skip anything already covered unless there's genuine new development, in which case write it as a follow-up and reference the earlier piece. Read the source before writing; if it's thin, corroborate with a second source. Match the voice and structure of the example articles exactly. Australian English. Never invent dates, episode counts, staff names or studio names — if a detail isn't in what you read, leave it out. 400–700 words, attribute the original outlet with a link in the closing line.

**Few-shot:** full contents of `automation/style-samples.md`, read from disk so the samples stay editable in the repo.

**Final output:** JSON only, no fences, no preamble — keys `title`, `slug`, `excerpt`, `tags`, `body`, `sourceUrl`, `sourceName`.

**Loop guards:** if the model burns all 5 turns without producing final JSON, exit 1 rather than retrying. If it returns "nothing worth covering", exit 0 — a skipped cycle is better than a filler article, and the next run is three days away.

**Fallback if you want to start simpler:** a single call with the top-sorted story and its pre-fetched text works and costs ~7 cents. You lose topical judgement and continuity, which is the whole reason for the loop. Build it as the loop; the deterministic version is only worth it if the loop proves flaky in practice.

**Step 8 — Validate (hard gate).** Exit 1 if any of these fail:

- JSON does not parse (strip fences first, then parse)
- `body` outside the word bounds in `config.json`
- `slug` does not match `^[a-z0-9-]+$`
- `slug` already exists in the articles folder
- the source URL is missing from the body

This gate is what stands between you and a broken article going live.

**Step 9 — Write to disk.** Compose frontmatter + body, write to `src/content/articles/{YYYY-MM-DD}-{slug}.md`. Append the source URL to `automation/published.json`. The workflow's final step commits both and Netlify takes it from there.

### 2.3 Language, dependencies and local testing

Plain Node.js (`.mjs`), not TypeScript — no compile step between you and running it, and the site's TS build doesn't touch `automation/`. Dependencies: `rss-parser`, `gray-matter` (already added in Phase 1), and `cheerio` for extracting body text from fetched article HTML. `fetch` is built into Node 20, so no HTTP library.

The script's job ends at *writing a file*. Committing is the workflow's final step, not the script's — so running it locally does exactly what CI does, minus the push:

```bash
node --env-file=.env automation/publish.mjs
npm run dev        # view the article on localhost
git checkout .     # discard it if it's no good
```

Two things to set up before the first local run:

- **`.env` at the repo root** with `ANTHROPIC_API_KEY=sk-...`, and `.env` added to `.gitignore` first. A committed key is the one mistake here that actually costs money.
- **`DRY_RUN=1` support** — when set, skip the Anthropic call and return a canned JSON blob instead. You want this while debugging the RSS, dedupe and validation logic so you're not paying and waiting 30 seconds to test a filter.

Once it behaves locally, push the script and the workflow file, then use **Run workflow** in the Actions tab (`workflow_dispatch`) to prove the CI path end to end — checkout, `npm ci`, secret injection, commit, Netlify build — without waiting three days for the cron.

### 2.4 Cost

Roughly 10 runs a month. The tool loop makes several calls per run with a growing context (style samples, candidate list, fetched pages), so budget ~60–80k input and ~2k output tokens per run — about 20–30 US cents. Call it US$3 a month. Actions minutes: ~20 a month against 2,000 free on a private repo, unlimited on a public one. Nothing else to pay for.

---

## What this won't handle

- **Factual accuracy.** The validation gate catches malformed output, not wrong output. Writing only from fetched source text keeps this low, but it will eventually publish something inaccurate.
- **SEO.** These are rewrites of other outlets' reporting. Google treats that as thin, derivative content and is unlikely to rank it. Fine if this is a portfolio piece or a build exercise; not fine if the site is meant to attract organic traffic.
- **Images.** No hero images beyond the placeholder fallback.
- **Topical judgement.** The loop picks the story rather than taking the top of a sorted list, which helps — but its sense of what matters to your readers is generic. Some weeks it'll still lead with a minor licensing announcement.
- **Editorial continuity.** It can see the last ten articles and avoid straight repeats, but it has no view of anything older and no editorial line to hold.

## Maintenance burden

Low but non-zero. Realistic failure modes: an RSS feed URL changes (a few times a year), a source site adds bot protection and the article fetch starts returning nothing, or the Anthropic model string is deprecated. All of them fail the workflow loudly and GitHub emails you, which is the main reason for exiting non-zero rather than publishing degraded output.

## Build order

1. Phase 1 refactor, deploy, confirm the site is unchanged.
2. Hand-write one markdown article file, push, confirm it appears live. This proves the publish mechanism before any automation exists.
3. Write `publish.mjs`. Run it locally with `DRY_RUN=1` until the feed, dedupe and validation logic is right, then once for real and inspect the generated markdown on `npm run dev`.
4. Add the workflow file, trigger it manually with `workflow_dispatch`, let it commit once.
5. Only then enable the schedule.
