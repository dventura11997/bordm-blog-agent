#!/usr/bin/env node
/**
 * Bordmmm auto-article agent
 *
 * Architecture:
 *  - OpenAI (OPENAI_MODEL)  — story selection (tool loop) + LLM-as-a-Judge
 *  - Z.ai GLM-5.3           — article writing
 *
 * Pipeline:
 *   RSS ingest -> dedupe -> OpenAI picks 5 stories -> fetch full content
 *   -> GLM writes 5 articles -> OpenAI judges each -> write passing articles to disk
 *
 * Local testing:
 *   npm install
 *   node --env-file=.env automation/publish.mjs
 *   DRY_RUN=1 node --env-file=.env automation/publish.mjs
 *
 * SITE_ROOT env var: absolute path to the bordm-site repo root.
 * Defaults to the sibling ../bordm-site folder. In GitHub Actions, set to
 * ${{ github.workspace }}.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import RSSParser from 'rss-parser';
import * as cheerio from 'cheerio';
import { buildSelectionSystem }                    from './prompts/selectionSystem.mjs';
import { TOPIC_SCANNER_SYSTEM, buildTopicScannerUser } from './prompts/topicScanner.mjs';
import { buildWriterSystem }                        from './prompts/writerSystem.mjs';
import { buildWriterUserPrompt }                    from './prompts/writerUserPrompt.mjs';
import { JUDGE_SYSTEM }                             from './prompts/judgeSystem.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Logger ────────────────────────────────────────────────────────────────────

function ts()           { return new Date().toISOString().slice(11, 19); }
function log(tag, msg)  { console.log(`${ts()}  [${tag.padEnd(8)}] ${msg}`); }
function warn(tag, msg) { console.warn(`${ts()}  [${tag.padEnd(8)}] WARN  ${msg}`); }
function fail(tag, msg) { console.error(`${ts()}  [${tag.padEnd(8)}] ERROR ${msg}`); }

// ── Paths ─────────────────────────────────────────────────────────────────────

const CONFIG_PATH  = join(__dirname, 'config.json');
const SAMPLES_PATH = join(__dirname, 'prompts', 'style-samples.md');

const SITE_ROOT      = process.env.SITE_ROOT
  ? process.env.SITE_ROOT
  : join(__dirname, '..', '..', 'bordm-site');
const ARTICLES_DIR   = join(SITE_ROOT, 'src/content/articles');
const PUBLISHED_PATH = join(SITE_ROOT, 'automation/published.json');

// ── Step 1: Startup + kill switch ────────────────────────────────────────────

log('startup', `Bordmmm publish agent starting -- ${new Date().toISOString()}`);
log('startup', `SITE_ROOT:    ${SITE_ROOT}`);
log('startup', `ARTICLES_DIR: ${ARTICLES_DIR}`);

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
log('config', `paused=${config.paused}  minWords=${config.minWords}  maxWords=${config.maxWords}`);

if (config.paused) {
  log('config', 'Agent is paused -- set paused=false in config.json to resume. Exiting.');
  process.exit(0);
}

const DRY_RUN = !!process.env.DRY_RUN;
if (DRY_RUN) log('config', 'DRY_RUN mode active -- all AI calls will be skipped with canned data.');

const SELECTION_COUNT = 5;
log('config', `Target articles per run: ${SELECTION_COUNT}`);

// ── Step 2: Ingest RSS ────────────────────────────────────────────────────────

const FEEDS = [
  { url: 'https://www.animenewsnetwork.com/all/rss.xml', name: 'Anime News Network' },
  { url: 'https://www.crunchyroll.com/news/rss',         name: 'Crunchyroll' },
  { url: 'https://myanimelist.net/rss/news.xml',         name: 'MyAnimeList' },
  { url: 'https://otakuusamagazine.com/feed/',           name: 'Otaku USA' },
  { url: 'https://animecorner.me/feed/',                 name: 'Anime Corner' },
  { url: 'https://siliconera.com/feed/',                 name: 'Siliconera' },
  { url: 'https://www.animeherald.com/feed/',            name: 'Anime Herald' },
  { url: 'https://animeuknews.net/feed/',                name: 'Anime UK News' },
  { url: 'https://comicbook.com/anime/feed/',            name: 'ComicBook Anime' },
];

log('feed', `Fetching ${FEEDS.length} RSS feeds in parallel...`);

const parser = new RSSParser({ timeout: 10000 });

async function fetchFeed(feed) {
  try {
    const parsed = await parser.parseURL(feed.url);
    const items = (parsed.items || []).map(item => ({
      title:   item.title   || '',
      link:    item.link    || item.guid || '',
      pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
      source:  feed.name,
      summary: item.contentSnippet || item.content || '',
    }));
    log('feed', `${feed.name.padEnd(22)} -> ${items.length} item(s)`);
    return items;
  } catch (e) {
    warn('feed', `${feed.name} failed: ${e.message}`);
    return [];
  }
}

const feedResults = await Promise.all(FEEDS.map(fetchFeed));
const allItems = feedResults.flat();
log('feed', `${allItems.length} total items across all feeds`);

// ── Step 3: Normalise -- last 7 days ─────────────────────────────────────────

const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);
const recentItems = allItems.filter(item => item.link && item.pubDate.getTime() > cutoff);
log('feed', `${recentItems.length} item(s) published since ${cutoffDate} (7-day window)`);

if (recentItems.length === 0) {
  log('feed', 'No recent feed items found. Exiting.');
  process.exit(0);
}

// ── Step 4: Dedupe ────────────────────────────────────────────────────────────

const publishedUrls = new Set(JSON.parse(readFileSync(PUBLISHED_PATH, 'utf8')));
log('dedupe', `${publishedUrls.size} URL(s) already recorded in published.json`);

const existingFiles = readdirSync(ARTICLES_DIR);
const existingSlugs = new Set(
  existingFiles.map(f => f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, ''))
);
log('dedupe', `${existingSlugs.size} existing article slug(s) in articles dir`);

function titleToSlug(title) {
  return title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

const candidates = recentItems.filter(item => {
  if (publishedUrls.has(item.link)) return false;
  if (existingSlugs.has(titleToSlug(item.title))) return false;
  return true;
});

if (candidates.length === 0) {
  log('dedupe', 'All recent items are already published. Exiting.');
  process.exit(0);
}

log('dedupe', `${candidates.length} new candidate(s) after deduplication`);

// ── Recent articles for context ───────────────────────────────────────────────

function parseFrontmatterTitle(raw) {
  const m = raw.match(/^title:\s*"(.*?)(?<!\\)"/m) || raw.match(/^title:\s*'(.*?)(?<!\\)'/m);
  if (m) return m[1].replace(/\\"/g, '"');
  return '';
}
function parseFrontmatterDate(raw) {
  const m = raw.match(/^date:\s*"?([^"\n]+)"?/m);
  return m ? m[1].trim() : '';
}
function parseFrontmatterExcerpt(raw) {
  const m = raw.match(/^intro:\s*"(.*?)(?<!\\)"/m);
  if (m) return m[1].replace(/\\"/g, '"').slice(0, 120);
  return '';
}

const recentArticles = existingFiles
  .slice().sort().reverse().slice(0, 10)
  .map(f => {
    try {
      const raw = readFileSync(join(ARTICLES_DIR, f), 'utf8');
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
      return { title: parseFrontmatterTitle(fm), date: parseFrontmatterDate(fm), excerpt: parseFrontmatterExcerpt(fm) };
    } catch { return null; }
  })
  .filter(Boolean);

log('context', `Loaded ${recentArticles.length} recent article(s) for deduplication context`);

// ── Fetch URL helper (allowlisted) ────────────────────────────────────────────

const ALLOWED_DOMAINS = new Set([
  'animenewsnetwork.com', 'www.animenewsnetwork.com',
  'crunchyroll.com',      'www.crunchyroll.com',
  'myanimelist.net',      'www.myanimelist.net',
  'otakuusamagazine.com', 'www.otakuusamagazine.com',
  'animecorner.me',       'www.animecorner.me',
  'siliconera.com',       'www.siliconera.com',
  'animeherald.com',      'www.animeherald.com',
  'animeuknews.net',      'www.animeuknews.net',
  'comicbook.com',        'www.comicbook.com',
]);

const EMPTY_FETCH = { text: '', ogImage: '', images: [], tweets: [], youtubeEmbeds: [] };

async function fetchArticleData(url) {
  try {
    const { hostname } = new URL(url);
    if (!ALLOWED_DOMAINS.has(hostname)) return { ...EMPTY_FETCH, text: `[blocked: domain ${hostname} not in allowlist]` };
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Bordmmm-Bot/1.0 (+https://verdant-dodol-4106eb.netlify.app)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ...EMPTY_FETCH, text: `[fetch failed: ${res.status}]` };
    const html = await res.text();
    const $ = cheerio.load(html);

    const ogImage =
      $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      '';

    // Extract tweet URLs before stripping navigation/scripts
    const tweets = [];
    const seenTweets = new Set();
    $('a[href*="twitter.com"][href*="/status/"], a[href*="x.com"][href*="/status/"]').each((_, el) => {
      const href = ($(el).attr('href') || '').split('?')[0];
      if (href && !seenTweets.has(href)) { seenTweets.add(href); tweets.push(href); }
    });

    // Extract YouTube embeds before stripping
    const youtubeEmbeds = [];
    const seenYt = new Set();
    $('iframe').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (src.includes('youtube.com/embed') || src.includes('youtube-nocookie.com/embed')) {
        const clean = src.split('?')[0];
        if (!seenYt.has(clean)) { seenYt.add(clean); youtubeEmbeds.push(clean); }
      }
    });
    $('a[href*="youtube.com/watch"], a[href*="youtu.be/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      if (m) {
        const embedUrl = `https://www.youtube.com/embed/${m[1]}`;
        if (!seenYt.has(embedUrl)) { seenYt.add(embedUrl); youtubeEmbeds.push(embedUrl); }
      }
    });

    $('script,style,nav,header,footer,aside,[class*="ad"],[id*="ad"]').remove();

    // Extract inline images from article content area only
    const images = [];
    const seenImgs = new Set();
    $('article img, .article-body img, .post-content img, main img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
      const alt = $(el).attr('alt') || '';
      if (!src || !src.startsWith('http') || seenImgs.has(src)) return;
      const lower = src.toLowerCase();
      if (/avatar|profile|author|logo|icon|badge|button|spinner|pixel|1x1/.test(lower)) return;
      if (src.endsWith('.gif') || src.endsWith('.svg')) return;
      seenImgs.add(src);
      images.push({ src, alt });
    });

    const text = $('article, .article-body, .post-content, main, body').first().text()
      .replace(/\s+/g, ' ').trim().slice(0, 6000);

    return {
      text:          text || '[no text extracted]',
      ogImage,
      images:        images.slice(0, 6),
      tweets:        tweets.slice(0, 3),
      youtubeEmbeds: youtubeEmbeds.slice(0, 2),
    };
  } catch (e) {
    return { ...EMPTY_FETCH, text: `[fetch error: ${e.message}]` };
  }
}

const BORDMMM_ICON = 'https://cdn.prod.website-files.com/650e88099aad1a83c37df57d/65713f65feba2a48bf1bfe80_bordmmm.png';

async function fetchJikanIcon(seriesName) {
  try {
    const res = await fetch(
      `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(seriesName)}&limit=1`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return '';
    const data = await res.json();
    return data.data?.[0]?.images?.jpg?.image_url || '';
  } catch {
    return '';
  }
}

// ── OpenAI helper ─────────────────────────────────────────────────────────────

async function callOpenAI(messages, tools = null) {
  const body = {
    model: process.env.OPENAI_MODEL || (() => { throw new Error('OPENAI_MODEL env var is not set'); })(),
    messages,
  };
  if (tools) { body.tools = tools; body.tool_choice = 'auto'; }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${text}`);
  }
  return res.json();
}

// ── Step 5a: Topic scanning ───────────────────────────────────────────────────

async function runTopicScan() {
  if (DRY_RUN) {
    log('topics', `[DRY_RUN] Skipping topic scan -- wrapping ${candidates.length} candidate(s) as individual topics`);
    return candidates.map(c => ({
      topic_name:        c.title.slice(0, 60),
      topic_description: (c.summary || '').slice(0, 150),
      number_sources:    1,
      primary_url:       c.link,
      sources: [{ title: c.title, url: c.link, source: c.source, published: c.pubDate.toISOString().slice(0, 10), summary: (c.summary || '').slice(0, 150) }],
    }));
  }

  log('topics', `Scanning ${candidates.length} candidate(s) for topic clusters...`);

  const data = await callOpenAI([
    { role: 'system', content: TOPIC_SCANNER_SYSTEM },
    { role: 'user',   content: buildTopicScannerUser(candidates) },
  ]);

  const content = (data.choices[0]?.message?.content || '').trim();
  const stripped = content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();

  try {
    const topics = JSON.parse(stripped);
    log('topics', `Scanner identified ${topics.length} topic(s):`);
    topics.forEach((t, i) => log('topics', `  ${i + 1}. "${t.topic_name}" (${t.number_sources} source(s))`));
    return topics;
  } catch {
    warn('topics', 'Topic scanner returned unparseable output -- falling back to flat candidate list');
    return candidates.map(c => ({
      topic_name:        c.title.slice(0, 60),
      topic_description: (c.summary || '').slice(0, 150),
      number_sources:    1,
      primary_url:       c.link,
      sources: [{ title: c.title, url: c.link, source: c.source, published: c.pubDate.toISOString().slice(0, 10), summary: (c.summary || '').slice(0, 150) }],
    }));
  }
}

const topics = await runTopicScan();
log('topics', `${topics.length} topic(s) ready for selection`);

// ── Step 5b: Story selection via OpenAI tool loop ─────────────────────────────

const SELECTION_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_topics',
      description: 'List pre-grouped topic clusters from today\'s anime RSS feeds',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_recent_articles',
      description: 'List recently published Bordmmm articles to avoid repetition',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

const SELECTION_SYSTEM = buildSelectionSystem(SELECTION_COUNT);

async function runSelectionLoop() {
  const model = process.env.OPENAI_MODEL;

  if (DRY_RUN) {
    const picks = topics.slice(0, SELECTION_COUNT).map((t, i) => ({
      selectedTitle: t.topic_name,
      selectedUrl:   t.primary_url,
      sourceName:    t.sources[0]?.source || '',
      articleType:   i < 3 ? 'news' : i === 3 ? 'opinion' : 'theories',
    }));
    log('select', `[DRY_RUN] Skipping OpenAI -- using first ${picks.length} topic(s)`);
    picks.forEach((s, i) => log('select', `  ${i + 1}. "${s.selectedTitle}" via ${s.sourceName}`));
    return picks;
  }

  log('select', `Calling OpenAI (${model}) to pick ${SELECTION_COUNT} articles from ${topics.length} topic(s)...`);

  const messages = [
    { role: 'system', content: SELECTION_SYSTEM },
    { role: 'user',   content: 'Please select the top stories for today.' },
  ];

  for (let turn = 0; turn < 5; turn++) {
    log('select', `Turn ${turn + 1}/5 -- sending request to OpenAI...`);
    const data = await callOpenAI(messages, SELECTION_TOOLS);
    const choice = data.choices[0];
    messages.push(choice.message);

    if (choice.finish_reason === 'stop' || !choice.message.tool_calls?.length) {
      log('select', `Turn ${turn + 1}/5 -- model returned final selection`);
      const content = (choice.message.content || '').trim();
      const stripped = content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
      try {
        const parsed = JSON.parse(stripped);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        throw new Error(`Selection loop returned unparseable content:\n${content}`);
      }
    }

    for (const tc of choice.message.tool_calls) {
      let result;
      if (tc.function.name === 'list_topics') {
        log('select', `Turn ${turn + 1}/5 -- tool call: list_topics (${topics.length} topic(s))`);
        result = JSON.stringify(topics);
      } else if (tc.function.name === 'list_recent_articles') {
        log('select', `Turn ${turn + 1}/5 -- tool call: list_recent_articles (${recentArticles.length} items)`);
        result = JSON.stringify(recentArticles);
      } else {
        result = '[unknown tool]';
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
    }
  }

  throw new Error('Selection loop exhausted 5 turns without a final JSON response.');
}

const selections = await runSelectionLoop();
log('select', `Selected ${selections.length} story/stories to write`);
selections.forEach((s, i) => log('select', `  ${i + 1}. [${(s.articleType || 'news').toUpperCase()}] "${s.selectedTitle}" via ${s.sourceName}`));

// ── Step 6: Fetch full article content for all selections ─────────────────────

const MAX_SOURCES_PER_ARTICLE = 5;
const CHARS_PER_SOURCE        = 2500;

log('fetch', `Fetching source content for ${selections.length} article(s) in parallel...`);

const selectionsWithContent = await Promise.all(
  selections.map(async (s, i) => {
    // Find the matching topic cluster to get all source URLs
    const matchingTopic = topics.find(t => t.primary_url === s.selectedUrl);
    const sourceUrls = matchingTopic
      ? matchingTopic.sources.slice(0, MAX_SOURCES_PER_ARTICLE).map(src => src.url).filter(Boolean)
      : [s.selectedUrl].filter(Boolean);

    if (sourceUrls.length === 0) {
      log('fetch', `  [${i + 1}/${selections.length}] No URLs for "${s.selectedTitle}" -- skipping fetch`);
      return { ...s, fetchedContent: '', ogImage: '' };
    }

    log('fetch', `  [${i + 1}/${selections.length}] Fetching ${sourceUrls.length} source(s) for "${s.selectedTitle}"`);

    const fetched = await Promise.all(sourceUrls.map(url => fetchArticleData(url)));

    const ogImage = fetched[0]?.ogImage || '';

    const successfulSources = fetched
      .map((f, j) => (f.text && !f.text.startsWith('['))
        ? `--- Source ${j + 1} (${sourceUrls[j]}) ---\n${f.text.slice(0, CHARS_PER_SOURCE)}`
        : null)
      .filter(Boolean);

    const combinedText = successfulSources.join('\n\n');

    // Collect deduplicated media across all sources, excluding the hero image
    const seenImgSrcs = new Set(ogImage ? [ogImage] : []);
    const allImages = fetched
      .flatMap(f => f.images || [])
      .filter(img => {
        if (!img.src || seenImgSrcs.has(img.src)) return false;
        seenImgSrcs.add(img.src);
        return true;
      })
      .slice(0, 5);
    const allTweets = [...new Set(fetched.flatMap(f => f.tweets || []))].slice(0, 3);
    const allYoutube = [...new Set(fetched.flatMap(f => f.youtubeEmbeds || []))].slice(0, 2);

    const mediaLog = [
      allImages.length  && `${allImages.length} image(s)`,
      allTweets.length  && `${allTweets.length} tweet(s)`,
      allYoutube.length && `${allYoutube.length} video(s)`,
    ].filter(Boolean).join(', ');

    log('fetch', `  [${i + 1}/${selections.length}] ${successfulSources.length}/${sourceUrls.length} source(s) fetched, ${combinedText.length} chars${ogImage ? ', hero image' : ''}${mediaLog ? `, media: ${mediaLog}` : ''}`);

    return { ...s, fetchedContent: combinedText, ogImage, images: allImages, tweets: allTweets, youtubeEmbeds: allYoutube };
  })
);

// ── Step 7: Write articles with GLM-5.3 ──────────────────────────────────────

const styleSamples = readFileSync(SAMPLES_PATH, 'utf8');

const WRITER_SYSTEM = buildWriterSystem(styleSamples);

const Z_AI_ENDPOINTS = [
  'https://api.z.ai/api/paas/v4/chat/completions',
  'https://api.z.ai/api/coding/paas/v4/chat/completions',
];

async function callGLM(userPrompt, articleIndex) {
  if (DRY_RUN) {
    const s = selectionsWithContent[articleIndex];
    const slug = titleToSlug(s.selectedTitle);
    log('write', `[DRY_RUN] Generating canned article for: "${s.selectedTitle}"`);
    const type = s.articleType || 'news';
    return JSON.stringify({
      title:      s.selectedTitle,
      slug:       slug + (articleIndex > 0 ? `-${articleIndex}` : ''),
      excerpt:    `A dry-run ${type} article generated for testing (article ${articleIndex + 1}).`,
      seriesSlug: 'general-anime',
      tags:       [type],
      body:       type === 'news'
        ? `This is a dry-run news article about **${s.selectedTitle}**.\n\nSource: [${s.sourceName}](${s.selectedUrl})`
        : `This is a dry-run ${type} piece about **${s.selectedTitle}**.`,
      sourceUrl:  type === 'news' ? s.selectedUrl : '',
      sourceName: type === 'news' ? s.sourceName : '',
    });
  }

  log('write', `  Calling GLM-5.3 (reasoning_effort=low)...`);
  log('write', `  Prompt size: ${userPrompt.length} chars`);

  for (const endpoint of Z_AI_ENDPOINTS) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.Z_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'glm-5.3',
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: WRITER_SYSTEM },
          { role: 'user',   content: userPrompt },
        ],
      }),
    });
    if (res.status === 404) {
      warn('write', `404 on ${endpoint} -- trying fallback endpoint...`);
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Z.ai API error ${res.status}: ${text}`);
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    log('write', `  GLM-5.3 response received (${content.length} chars)`);
    return content;
  }
  throw new Error('All z.ai endpoints returned 404.');
}

function stripFences(str) {
  return str.replace(/^```[a-z]*\n?/im, '').replace(/\n?```$/im, '').trim();
}
function countWords(str) {
  return (str || '').split(/\s+/).filter(Boolean).length;
}
function removeEmDashes(str) {
  return (str || '').replace(/—/g, ' - ');
}

const writtenArticles = [];

for (let i = 0; i < selectionsWithContent.length; i++) {
  const s = selectionsWithContent[i];
  log('write', `--- Article ${i + 1}/${selectionsWithContent.length}: "${s.selectedTitle}" ---`);

  const articleType = s.articleType || 'news';
  const userPrompt = buildWriterUserPrompt(s);

  let raw;
  try {
    raw = await callGLM(userPrompt, i);
  } catch (e) {
    warn('write', `GLM call failed for article ${i + 1}: ${e.message}`);
    continue;
  }

  let article;
  try {
    article = JSON.parse(stripFences(raw));
  } catch {
    warn('write', `Article ${i + 1} output did not parse as JSON -- skipping`);
    continue;
  }

  // Strip em dashes that slipped through
  article.title   = removeEmDashes(article.title);
  article.excerpt = removeEmDashes(article.excerpt);
  article.body    = removeEmDashes(article.body);

  const wordCount = countWords(article.body);
  if (wordCount < config.minWords || wordCount > config.maxWords) {
    warn('write', `Article ${i + 1} word count ${wordCount} outside bounds [${config.minWords}-${config.maxWords}] -- skipping`);
    continue;
  }

  if (!/^[a-z0-9-]+$/.test(article.slug)) {
    warn('write', `Article ${i + 1} slug "${article.slug}" invalid -- skipping`);
    continue;
  }

  if (!article.seriesSlug || !/^[a-z0-9-]+$/.test(article.seriesSlug)) {
    warn('write', `Article ${i + 1} seriesSlug "${article.seriesSlug}" invalid -- defaulting to general-anime`);
    article.seriesSlug = 'general-anime';
  }

  const seriesNameForIcon = article.seriesSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const jikanIcon = article.seriesSlug === 'general-anime' ? '' : await fetchJikanIcon(seriesNameForIcon);
  article.seriesIcon = jikanIcon || BORDMMM_ICON;
  log('write', `  Series icon: ${jikanIcon ? `Jikan (${seriesNameForIcon})` : 'Bordmmm fallback'}`);

  // Check for slug collisions within this run too
  const allKnownSlugs = new Set([
    ...existingSlugs,
    ...writtenArticles.map(a => a.slug),
  ]);
  if (allKnownSlugs.has(article.slug)) {
    warn('write', `Article ${i + 1} slug "${article.slug}" already exists -- skipping`);
    continue;
  }

  if (articleType === 'news' && !article.body.includes(article.sourceUrl)) {
    warn('write', `Article ${i + 1} sourceUrl not found in body -- skipping`);
    continue;
  }

  const ogImage = s.ogImage || '';

  log('write', `  Article ${i + 1} validated: "${article.title}" (${wordCount} words, slug: ${article.slug}, type: ${articleType}${ogImage ? ', has image' : ''})`);
  writtenArticles.push({ ...article, wordCount, sourceTitle: s.selectedTitle, ogImage, articleType, _userPrompt: userPrompt, _articleIndex: i });
}

log('write', `${writtenArticles.length}/${selectionsWithContent.length} article(s) passed writing + validation`);

if (writtenArticles.length === 0) {
  log('done', 'No articles survived validation. Exiting.');
  process.exit(0);
}

// ── Step 8: LLM-as-a-Judge quality review ────────────────────────────────────


async function judgeArticle(article, index) {
  if (DRY_RUN) {
    const pass = index < SELECTION_COUNT - 1; // fail the last one in dry run as a demo
    log('judge', `  [DRY_RUN] Article ${index + 1}: pass=${pass}, score=${pass ? 8 : 4}`);
    return { pass, score: pass ? 8 : 4, reason: pass ? 'Dry-run auto-pass' : 'Dry-run demo rejection' };
  }

  log('judge', `  Sending article ${index + 1} to OpenAI for quality review...`);

  const prompt = `Format: ${article.articleType || 'news'}\nTitle: ${article.title}\n\nBody:\n${article.body}`;
  const data = await callOpenAI([
    { role: 'system', content: JUDGE_SYSTEM },
    { role: 'user',   content: prompt },
  ]);

  const content = (data.choices[0]?.message?.content || '').trim();
  const stripped = content.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  try {
    return JSON.parse(stripped);
  } catch {
    warn('judge', `Judge returned unparseable output for article ${index + 1} -- defaulting to fail`);
    return { pass: false, score: 0, reason: 'Judge output unparseable' };
  }
}

const MAX_REWRITES    = 3;
const HARD_FAIL_SCORE = 5; // below this: discard immediately, no rewrite
const IDEAL_SCORE     = 8; // at or above: accept immediately

log('judge', `Running LLM-as-a-Judge quality review on ${writtenArticles.length} article(s)...`);
log('judge', `Tiers: <${HARD_FAIL_SCORE} discard | ${HARD_FAIL_SCORE}–${IDEAL_SCORE - 1} rewrite up to ${MAX_REWRITES}× | ${IDEAL_SCORE}+ accept`);

const passingArticles = [];

for (let i = 0; i < writtenArticles.length; i++) {
  let article = writtenArticles[i];
  log('judge', `--- Article ${i + 1}/${writtenArticles.length}: "${article.title}" ---`);

  let judgment;
  try {
    judgment = await judgeArticle(article, i);
  } catch (e) {
    warn('judge', `Judge call failed: ${e.message} -- defaulting to fail`);
    judgment = { pass: false, score: 0, reason: e.message };
  }

  log('judge', `  Initial: ${judgment.pass ? 'PASS' : 'FAIL'}  Score: ${judgment.score}/10`);
  log('judge', `  Reason:  ${judgment.reason}`);

  // Tier 1: hard fail -- discard without rewrite
  if (judgment.score < HARD_FAIL_SCORE) {
    log('judge', `  Score ${judgment.score} < ${HARD_FAIL_SCORE} -- discarding`);
    continue;
  }

  // Tier 3: ideal -- accept immediately
  if (judgment.score >= IDEAL_SCORE) {
    log('judge', `  Score ${judgment.score} >= ${IDEAL_SCORE} -- accepted`);
    passingArticles.push(article);
    continue;
  }

  // Tier 2: borderline (5–7) -- attempt rewrites
  log('judge', `  Score ${judgment.score} in rewrite zone -- attempting up to ${MAX_REWRITES} rewrite(s)`);

  let discarded = false;

  for (let attempt = 1; attempt <= MAX_REWRITES; attempt++) {
    log('judge', `  Rewrite ${attempt}/${MAX_REWRITES}...`);

    const rewritePrompt = article._userPrompt +
      `\n\n---\nREWRITE REQUIRED (Attempt ${attempt}/${MAX_REWRITES})\n` +
      `Your previous draft scored ${judgment.score}/10.\n` +
      `Editor feedback: ${judgment.reason}\n` +
      `Rewrite the article to address this feedback. Return the full JSON as before.`;

    let raw;
    try {
      raw = await callGLM(rewritePrompt, article._articleIndex);
    } catch (e) {
      warn('judge', `  Rewrite ${attempt} GLM call failed: ${e.message} -- stopping`);
      break;
    }

    let rewritten;
    try {
      rewritten = JSON.parse(stripFences(raw));
    } catch {
      warn('judge', `  Rewrite ${attempt} output did not parse as JSON -- stopping`);
      break;
    }

    rewritten.title   = removeEmDashes(rewritten.title   ?? article.title);
    rewritten.excerpt = removeEmDashes(rewritten.excerpt ?? article.excerpt);
    rewritten.body    = removeEmDashes(rewritten.body    ?? article.body);

    article = {
      ...article,
      title:     rewritten.title,
      excerpt:   rewritten.excerpt,
      body:      rewritten.body,
      wordCount: countWords(rewritten.body),
    };

    let newJudgment;
    try {
      newJudgment = await judgeArticle(article, i);
    } catch (e) {
      warn('judge', `  Re-judge after rewrite ${attempt} failed: ${e.message} -- stopping`);
      break;
    }

    log('judge', `  Rewrite ${attempt}: ${newJudgment.pass ? 'PASS' : 'FAIL'}  Score: ${newJudgment.score}/10 -- ${newJudgment.reason}`);
    judgment = newJudgment;

    if (judgment.score < HARD_FAIL_SCORE) {
      log('judge', `  Score dropped to ${judgment.score} -- discarding`);
      discarded = true;
      break;
    }

    if (judgment.score >= IDEAL_SCORE) {
      log('judge', `  Score reached ${judgment.score} after rewrite ${attempt} -- stopping early`);
      break;
    }
  }

  if (discarded) continue;

  if (judgment.score >= IDEAL_SCORE) {
    log('judge', `  Accepted: final score ${judgment.score}/10`);
    passingArticles.push(article);
  } else {
    log('judge', `  Did not reach ${IDEAL_SCORE}+ after ${MAX_REWRITES} rewrite(s) (score ${judgment.score}) -- discarding`);
  }
}

log('judge', `Quality review complete: ${passingArticles.length}/${writtenArticles.length} article(s) passed`);

if (passingArticles.length === 0) {
  log('done', 'No articles passed quality review. Exiting without writing any files.');
  process.exit(0);
}

// ── Step 9: Write passing articles to disk ────────────────────────────────────

function resolveTag(articleType) {
  switch (articleType) {
    case 'news':                   return { tag: 'News',     tagColor: '#e7335e' };
    case 'explainer':
    case 'analysis':               return { tag: 'Theories', tagColor: '#72f5b6' };
    case 'ranking':
    case 'spotlight':
    case 'toplist':
    default:                       return { tag: 'Opinion',  tagColor: '#ffa81e' };
  }
}

const today = new Date().toISOString().slice(0, 10);
const published = JSON.parse(readFileSync(PUBLISHED_PATH, 'utf8'));
let filesWritten = 0;

for (const article of passingArticles) {
  const filename = `${today}-${article.slug}.md`;
  const filepath = join(ARTICLES_DIR, filename);

  if (existsSync(filepath)) {
    warn('write', `File already exists on disk: ${filename} -- skipping`);
    continue;
  }

  const frontmatter = [
    '---',
    `slug: "${article.slug}"`,
    `title: "${article.title.replace(/"/g, '\\"')}"`,
    `date: "${today}"`,
    `intro: "${(article.excerpt || '').replace(/"/g, '\\"')}"`,
    `seriesSlug: "${article.seriesSlug}"`,
    `seriesName: "${article.seriesSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}"`,
    `seriesIcon: "${article.seriesIcon}"`,
    `heroImage: "${article.ogImage || ''}"`,
    `showStar: false`,
    `readTime: "${Math.max(1, Math.round(article.wordCount / 200))}m Read"`,
    `tag: "${resolveTag(article.articleType).tag}"`,
    `tagColor: "${resolveTag(article.articleType).tagColor}"`,
    `sourceName: "${article.articleType === 'news' ? (article.sourceName || '').replace(/"/g, '\\"') : ''}"`,
    `sourceUrl: "${article.articleType === 'news' ? (article.sourceUrl || '').replace(/"/g, '\\"') : ''}"`,
    `tags: [${article.articleType !== 'news' ? `"${article.articleType}"` : (article.tags || ['news']).map(t => `"${t}"`).join(', ')}]`,
    '---',
    '',
  ].join('\n');

  log('write', `Writing: ${filename}  (${article.wordCount} words)`);
  writeFileSync(filepath, frontmatter + article.body + '\n');
  filesWritten++;

  // Track source URL to avoid re-selecting this story next run
  if (article.sourceUrl && !published.includes(article.sourceUrl)) {
    published.push(article.sourceUrl);
  }
}

// Also track URLs of selections that were attempted (even if judge rejected them)
// so we don't re-select failed stories in the next run
for (const s of selectionsWithContent) {
  if (s.selectedUrl && !published.includes(s.selectedUrl)) {
    published.push(s.selectedUrl);
  }
}

writeFileSync(PUBLISHED_PATH, JSON.stringify(published, null, 2) + '\n');
log('write', `published.json updated (${published.length} total URLs tracked)`);

// ── Done ──────────────────────────────────────────────────────────────────────

log('done', '=========================================');
log('done', `Articles written:  ${filesWritten}`);
log('done', `Passed judge:      ${passingArticles.length}/${writtenArticles.length}`);
log('done', `Total selected:    ${selections.length}`);
if (passingArticles.length > 0) {
  passingArticles.forEach((a, i) => log('done', `  ${i + 1}. ${today}-${a.slug}.md`));
}
log('done', '=========================================');
