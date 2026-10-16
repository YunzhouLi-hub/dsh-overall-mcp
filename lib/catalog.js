// lib/catalog.js — live aggregation of open MCP server catalogs (pure fetch, zero-dependency).
//
// Sources (verified against the live endpoints 2026-10-12):
//   - official-registry: registry.modelcontextprotocol.io/v0/servers
//     entries are `{ server: {...}, _meta: {...} }` (nested!) and install
//     information lives in `packages` (npm/pypi) or `remotes` (streamable-http).
//     Supports `?search=` and `?cursor=`; `limit` is capped at 100 upstream.
//   - smithery: registry.smithery.ai/servers (uses `displayName`, `useCount`,
//     `iconUrl`, `verified`).
//   - awesome-list: the community index punkpeye/awesome-mcp-servers README —
//     discovery + repository links (no run command can be inferred safely).
//   - pulsemcp: DEPRECATED upstream (API_SUNSET); kept for compatibility but no
//     longer part of the default source set.
// Each source adapter degrades independently; failures are reported per-source.
//
// Every adapter normalizes to the same "card" shape consumed by the settings
// page and the `overall_mcp_catalog` tool:
//   { id, title, description, source, author, version, transport, install,
//     repository, homepage, icon, tags, installs, verified, official }

import { compareVersions } from './updates.js';

const DEFAULT_TIMEOUT_MS = 15000;
/** The official registry is periodically slow on cold reads. */
const OFFICIAL_TIMEOUT_MS = 30000;

/**
 * Identify ourselves on every upstream request.
 *
 * Measured on this host: `api.github.com/search/repositories` answers `403
 * API rate limit exceeded` with only an `accept` header, and the *same* request
 * with a `user-agent` answers `200` (x-ratelimit-remaining 8). GitHub documents
 * that requests must carry one, and an anonymous client without it lands in a
 * bucket it shares with everything else running on this IP. The other upstreams
 * do not care, and a bot that says who it is is cheaper for them to run.
 */
export const USER_AGENT = 'dsh-overall-mcp (DeepSeek Harness plugin)';

/** Every request this module makes carries the identifying User-Agent above. */
const REQUEST_HEADERS = { 'user-agent': USER_AGENT };

/**
 * Mirrors for the two awesome READMEs, in trust order.
 *
 * raw.githubusercontent.com is canonical but unreachable whenever GitHub is
 * blocked wholesale (measured on this network class: TCP connect timeout for
 * github.com, raw.githubusercontent.com AND hub.docker.com simultaneously,
 * while both MCP registries answer normally). The jsDelivr nodes serve the
 * same bytes from CDN POPs; `testingcf` was the reachable one when the others
 * were reset/timing out, so the chain is tried in order and the first ok
 * response wins. Mirror lag is harmless here: the lists change daily and a
 * walk is reused for a minute anyway (`DEFAULT_SOURCE_TTL_MS`).
 */
function awesomeMirrors(owner, repo, branch, path) {
  const gh = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
  return [
    gh,
    `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`,
    `https://fastly.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`,
    `https://testingcf.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`,
  ];
}

/**
 * Race every mirror simultaneously; the first successful body wins and the
 * losers are aborted.
 *
 * The chain used to walk mirrors in order, which is optimal on a healthy
 * network (raw answers in ~1s) but terrible exactly when mirrors matter: a
 * wholesale GitHub block fails raw and fastly with ~10s TCP connect *timeouts*
 * each, so the serial chain held the market request open ~25s before the
 * reachable CDN node even started. Racing keeps the canonical winner on a
 * healthy network (it resolves first and the rest abort mid-flight) while a
 * blocked network pays only the slowest *successful* mirror, not the sum of
 * the failures. Mirror lag is harmless: the lists change daily and a walk is
 * reused for a minute anyway (`DEFAULT_SOURCE_TTL_MS`).
 */
async function fetchFirstText(urls, opts = {}) {
  const { fetchImpl = fetch, cache } = opts;
  const MIRROR_TIMEOUT_MS = 30000;
  const entries = urls.map((url) => ({ url, ctl: new AbortController() }));
  const failures = [];
  // Fired in trust order (map is synchronous), so failure logs and injected
  // test fetchers both observe the canonical order.
  const attempts = entries.map(({ url, ctl }) => {
    const timer = setTimeout(() => ctl.abort(), MIRROR_TIMEOUT_MS);
    // Every mirror is asked with the validator we hold for *that* URL. The
    // canonical raw URL and the CDN nodes carry independent ETags, so a mirror
    // that has never served us simply answers 200 as before.
    const etag = cache?.etagFor(url);
    cache?.noteRequest();
    return fetchImpl(url, {
      signal: ctl.signal,
      headers: { ...REQUEST_HEADERS, accept: 'text/plain', ...(etag ? { 'if-none-match': etag } : {}) },
    })
      .then(async (res) => {
        if (res.status === 304) {
          const body = cache?.reuse(url);
          // A 304 whose remembered body is gone (evicted mid-race) cannot be
          // answered from memory: fail this mirror rather than return an empty
          // listing.
          if (body !== undefined) return body;
          throw new Error('HTTP 304 without a cached body');
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        cache?.noteDownload(text.length);
        cache?.remember(url, { etag: res.headers?.get?.('etag'), body: text, bytes: text.length });
        return text;
      })
      .catch((err) => {
        failures.push(`${new URL(url).hostname}: ${String(err?.message ?? err)}`);
        throw err;
      })
      .finally(() => clearTimeout(timer));
  });
  try {
    // Resolves after the winner's .text() completes, so aborting below never
    // cuts off a body we are about to return.
    return await Promise.any(attempts);
  } catch {
    throw new Error(`all mirrors failed — ${failures.join(' | ')}`);
  } finally {
    for (const { ctl } of entries) ctl.abort();
  }
}

// ---------------------------------------------------------------------------
// Functional taxonomy
// ---------------------------------------------------------------------------

/**
 * The functional groups the market's chip row offers.
 *
 * The two community lists carry ~75 `###` headings between them, with synonym
 * drift (Finance vs Finance & Fintech, two Multimedia, two Other Tools) and
 * near-neighbours split by upstream editorial choice (Education apart from
 * Research). A user shopping for an MCP thinks in functions, not in editorial
 * headings, so the market consolidates them into these groups. The upstream
 * heading stays on the item (`category`) and on the card's tags; `group` is
 * the consolidated layer and never overwrites it.
 *
 * A heading the table does not name falls into 其他 rather than being dropped,
 * so a new heading upstream degrades into a bigger 其他 instead of vanishing.
 */
const FUNCTIONAL_GROUPS = [
  ['开发工具', ['Developer Tools', 'Coding Agents', 'Code Execution', 'Command Line', 'Version Control']],
  ['数据与存储', ['Databases', 'Data Platforms', 'Data Science Tools', 'Data Visualization', 'File Systems', 'File Storage']],
  ['搜索与知识', ['Search & Data Extraction', 'end to end RAG platforms', 'Knowledge & Memory', 'Research', 'Science & Research', 'Conversational AI']],
  ['安全与身份', ['Security', 'Cryptography', 'Identity']],
  ['办公协作', ['Communication', 'Workplace & Productivity', 'Project Management', 'Product Management', 'Support & Service Management', 'Agreements & Coordination']],
  ['营销与客户', ['Marketing', 'Sales', 'CRM', 'Customer Data Platforms']],
  ['金融支付', ['Finance & Fintech', 'Finance', 'Payments']],
  ['商业与法律', ['E-Commerce', 'Legal', 'Real Estate']],
  ['云与运维', ['Cloud Platforms', 'Monitoring', 'OS Automation', 'Embedded System', 'Industrial & IoT']],
  ['浏览器自动化', ['Browser Automation']],
  ['社交媒体', ['Social Media']],
  ['多媒体创作', ['Multimedia Process', 'Multimedia', 'Art & Culture', 'Art & Design', 'Architecture & Design']],
  ['语音与语言', ['Text-to-Speech', 'Speech-to-Text', 'Translation Services', 'Translation & Localization', 'Podcasts']],
  ['出行与生活', ['Travel & Transportation', 'Location Services', 'Delivery', 'Food & Dining', 'Home Automation']],
  ['医疗健康', ['Biology, Medicine and Bioinformatics', 'Health & Fitness', 'Health & Wellness']],
  ['教育学术', ['Education', 'Aerospace & Astrodynamics']],
  ['游戏娱乐', ['Gaming', 'Sports', 'Spirituality & Esoterica']],
  ['自然环境', ['Environment', 'Environment & Nature', 'Agriculture']],
  ['聚合网关', ['Aggregators']],
  ['其他', ['Other Tools and Integrations', 'Other Tools & Integrations', 'Accessibility']],
];

/** heading -> group name, with 其他 as the total fallback. */
const HEADING_TO_GROUP = new Map(FUNCTIONAL_GROUPS.flatMap(([group, headings]) => headings.map((h) => [h, group])));

/**
 * Best-effort functional group for the entries whose source publishes **no**
 * category at all.
 *
 * Two of the five sources carry none — verified against their live payloads on
 * 2026-10-14: Smithery's `/servers` returns `id, qualifiedName, namespace,
 * slug, displayName, description, iconUrl, verified, useCount, remote,
 * isDeployed, unlisted, inactive, createdAt, homepage, bySmithery, owner,
 * score` and the official registry's `/v0/servers` returns `name,
 * description, title, version, remotes, packages`. `category` only exists on
 * the two community lists (their `###` headings). That is 233 of ~5.4k entries
 * overall — but the default 综合推荐 order puts exactly those entries on page
 * one (official + verified Smithery entries score highest), so the first screen
 * was 100% 未分类 and the taxonomy looked broken.
 *
 * This is a **keyword inference over `title` + `description`**, and it is
 * labelled as such: `groupSource: 'inferred'` lets the card say 「按描述推断」
 * instead of presenting a guess as an upstream fact. A description that matches
 * nothing stays uncategorized (未分类) rather than being pushed into 其他,
 * because 其他 means "upstream said something we could not place" — a different
 * statement.
 */
const GROUP_KEYWORDS = [
  ['搜索与知识', ['search', 'web search', 'deep research', 'crawl', 'scrape', 'scraping', 'rag', 'retrieval', 'knowledge base', 'knowledge graph', 'documentation', 'docs', 'wiki', 'wikipedia', 'arxiv', 'pubmed', 'semantic search', 'embedding', 'embeddings', 'research', 'reading', 'summariz', 'directory']],
  ['开发工具', ['github', 'gitlab', 'git', 'code', 'coding', 'developer', 'debug', 'debugging', 'refactor', 'lint', 'build', 'compile', 'typescript', 'javascript', 'python', 'npm', 'pypi', 'repository', 'repo', 'test', 'testing', 'ci/cd', 'sdk', 'api client', 'syntax', 'terminal', 'shell', 'ide', 'wordpress', 'headless cms']],
  ['办公协作', ['notion', 'slack', 'gmail', 'email', 'mail', 'inbox', 'draft', 'thread', 'label', 'attachment', 'messaging', 'outlook', 'calendar', 'meeting', 'spreadsheet', 'google sheets', 'google drive', 'jira', 'linear', 'asana', 'trello', 'todo', 'task management', 'project management', 'confluence', 'zendesk', 'intercom', 'productivity', 'workspace', 'note-taking', 'obsidian', 'airtable', 'monday.com', 'team']],
  ['数据与存储', ['database', 'sql', 'postgres', 'postgresql', 'mysql', 'sqlite', 'mongodb', 'redis', 'elasticsearch', 'clickhouse', 'snowflake', 'bigquery', 'data warehouse', 'etl', 'dataset', 'data science', 'analytics', 'vector database', 's3', 'filesystem', 'file storage', 'csv', 'parquet', 'duckdb', 'nosql']],
  ['云与运维', ['aws', 'azure', 'gcp', 'google cloud', 'kubernetes', 'k8s', 'docker', 'terraform', 'ansible', 'devops', 'cloud', 'monitoring', 'observability', 'grafana', 'prometheus', 'datadog', 'sentry', 'logging', 'logs', 'infrastructure', 'deploy', 'deployment', 'uptime', 'incident']],
  ['安全与身份', ['security', 'vulnerability', 'pentest', 'penetration testing', 'exploit', 'cve', 'oauth', 'authentication', 'authorization', 'secrets', 'encryption', 'password', 'sso', 'iam', 'threat', 'malware', 'forensic', 'audit log']],
  ['浏览器自动化', ['browser', 'playwright', 'puppeteer', 'selenium', 'headless', 'chromium', 'browser automation', 'web automation', 'screenshot', 'form filling', 'devtools']],
  ['社交媒体', ['twitter', 'x.com', 'reddit', 'discord', 'telegram', 'mastodon', 'bluesky', 'linkedin', 'facebook', 'instagram', 'tiktok', 'youtube', 'weibo', 'social media', 'social network', 'community platform']],
  ['多媒体创作', ['image', 'video', 'audio', 'music', 'photo', 'ffmpeg', 'design', 'figma', 'canvas', 'graphics', '3d', 'animation', 'media', 'drawing', 'render', 'illustration', 'midjourney', 'stable diffusion', 'transcod', 'gif', 'font', 'color palette']],
  ['语音与语言', ['speech', 'text-to-speech', 'tts', 'speech-to-text', 'stt', 'voice', 'transcription', 'whisper', 'translate', 'translation', 'linguistic', 'podcast', 'dub', 'subtitle', 'language detection']],
  ['金融支付', ['payment', 'stripe', 'paypal', 'invoice', 'billing', 'accounting', 'finance', 'financial', 'stock', 'trading', 'crypto', 'bitcoin', 'ethereum', 'wallet', 'banking', 'expense', 'tax', 'ledger', 'portfolio']],
  ['营销与客户', ['marketing', 'seo', 'advertising', 'campaign', 'crm', 'sales', 'lead generation', 'customer support', 'email marketing', 'brand', 'newsletter', 'outreach', 'growth', 'conversion']],
  ['商业与法律', ['legal', 'law', 'lawyer', 'contract', 'compliance', 'gdpr', 'e-commerce', 'ecommerce', 'shopify', 'real estate', 'procurement', 'human resources', 'hiring', 'resume', 'recruit', 'insurance', 'supply chain']],
  ['出行与生活', ['travel', 'flight', 'hotel', 'booking', 'map', 'geocod', 'transit', 'train', 'taxi', 'ride', 'delivery', 'food', 'recipe', 'restaurant', 'home automation', 'smart home', 'shopping', 'lifestyle']],
  ['医疗健康', ['health', 'medical', 'medicine', 'clinical', 'patient', 'fhir', 'hl7', 'drug', 'biotech', 'bioinformatics', 'genom', 'fitness', 'nutrition', 'symptom', 'hospital', 'mental health']],
  ['教育学术', ['education', 'learning', 'course', 'student', 'teacher', 'school', 'university', 'academic', 'citation', 'paper', 'exam', 'quiz', 'tutor', 'astronomy', 'aerospace', 'physics', 'chemistry', 'math']],
  ['游戏娱乐', ['game', 'gaming', 'minecraft', 'steam', 'unity', 'unreal', 'emulator', 'sports', 'esport', 'movie', 'anime', 'comic', 'music discovery', 'board game']],
  ['自然环境', ['climate', 'environment', 'environmental', 'earth', 'geo', 'gis', 'satellite', 'agriculture', 'farm', 'ocean', 'wildlife', 'biodiversity', 'carbon', 'weather', 'earthquake', 'ecology', 'energy grid']],
  ['聚合网关', ['aggregator', 'gateway', 'proxy', 'router', 'multi-server', 'marketplace', 'registry of', 'bridge', 'unified access', 'mcp hub']],
];

/**
 * Compiled matchers: `\b` in front only.
 *
 * A trailing `\b` looked right and was wrong — `\bspreadsheet\b` does not match
 * "spreadsheets", so Google Sheets' own description ("Search and inspect Google
 * Sheets, create and edit spreadsheets…") scored 1 for 搜索与知识 and 0 for
 * 办公协作. Plurals are therefore *not* listed twice: the singular form already
 * matches them.
 *
 * Scoring: each hit is worth the keyword's word count, and a hit in the **title**
 * counts double. Weight makes the specific phrase beat the generic one
 * (「google sheets」 or 「web search」 over 「search」), and the title weighting is
 * what keeps Brave Search out of 多媒体创作 — its description mentions "images
 * and videos" while its title says what it is.
 *
 * Deliberately absent: 「server」. Every entry in this catalogue is an MCP server,
 * so the word appears in most descriptions and would have dragged DevMatch
 * (an MCP *hiring* service) into 云与运维.
 */
const GROUP_MATCHERS = GROUP_KEYWORDS.map(([group, words]) => [
  group,
  words.map((w) => ({
    re: new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
    weight: w.split(/\s+/).length,
  })),
]);

/** Best-effort group from the entry's own words, or undefined when nothing matches. */
export function inferGroupOf(item) {
  const title = String(item?.title ?? '');
  const description = String(item?.description ?? '');
  if (!title.trim() && !description.trim()) return undefined;
  let best;
  let bestScore = 0;
  for (const [group, matchers] of GROUP_MATCHERS) {
    let score = 0;
    for (const { re, weight } of matchers) {
      if (re.test(title)) score += weight * 2;
      if (re.test(description)) score += weight;
    }
    // Strictly greater: a tie keeps the earlier group, which makes the answer
    // deterministic instead of dependent on the entry's wording order.
    if (score > bestScore) { bestScore = score; best = group; }
  }
  return best;
}

/** The consolidated functional group of one item, or undefined when uncategorized. */
export function functionalGroupOf(item) {
  // Upstream headings win: they are the source's own editorial answer.
  if (item?.category) return HEADING_TO_GROUP.get(item.category) ?? '其他';
  // The two registries publish no category at all — infer, and say so.
  return inferGroupOf(item);
}

/** Where an item's `group` came from: the upstream heading, or our own inference. */
export function groupSourceOf(item) {
  if (!functionalGroupOf(item)) return undefined;
  return item?.category ? 'upstream' : 'inferred';
}

/**
 * GitHub's *search* budget, as the upstream last described it.
 *
 * Anonymous search gets 10 requests per minute per IP — a budget separate from
 * the 60/hour core API, and one this machine shares with everything else behind
 * its address. Two callers here spend it: the live fallback in `fetchGithubMcp`
 * and the census walk in `lib/github-index.js`. Until this existed neither could
 * see the other, so a browse that fired its three queries while a walk was
 * mid-request pushed the IP over the limit and the *walk* — which asks hundreds
 * of questions — reported the source as broken.
 *
 * Nothing is enforced against another program's spend. What this does is refuse
 * to *add* requests while the upstream has told us the window is empty, and
 * carry the reason (and the wait) into what the panel shows.
 */
const searchQuota = { remaining: null, resetAt: 0, blockedUntil: 0, reason: null };

/** GitHub search lives behind this URL, and only its budget is tracked here. */
const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';

function isGithubSearch(url) {
  return typeof url === 'string' && url.startsWith(GITHUB_SEARCH_URL);
}

function noteSearchQuota(res, { failed = false } = {}) {
  const remaining = Number(res?.headers?.get?.('x-ratelimit-remaining'));
  if (Number.isFinite(remaining)) searchQuota.remaining = remaining;
  const reset = Number(res?.headers?.get?.('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) searchQuota.resetAt = reset * 1000;
  if (!failed) {
    if (searchQuota.blockedUntil) {
      searchQuota.blockedUntil = 0;
      searchQuota.reason = null;
    }
    return;
  }
  const retryAfter = Number(res?.headers?.get?.('retry-after'));
  const until = Number.isFinite(retryAfter) && retryAfter > 0
    ? Date.now() + retryAfter * 1000
    : (searchQuota.resetAt > Date.now() ? searchQuota.resetAt : Date.now() + 60_000);
  searchQuota.blockedUntil = Math.max(searchQuota.blockedUntil, until);
  searchQuota.reason = 'API rate limit exceeded';
}

/** The search budget's last known state — for the host's crawl pacing. */
export function githubSearchQuota() {
  return {
    remaining: searchQuota.remaining,
    resetAt: searchQuota.resetAt || null,
    blockedUntil: searchQuota.blockedUntil || null,
    waitMs: Math.max(0, searchQuota.blockedUntil - Date.now()),
    reason: searchQuota.reason,
  };
}

/** Only for tests: forget what the upstream said about the budget. */
export function forgetGithubSearchQuota() {
  searchQuota.remaining = null;
  searchQuota.resetAt = 0;
  searchQuota.blockedUntil = 0;
  searchQuota.reason = null;
}

/**
 * A 403 that is about the *budget* rather than about the request.
 *
 * GitHub says `API rate limit exceeded for <ip>` (and, for bursts,
 * `secondary rate limit` / `abuse detection`); the retry policy must not treat
 * those like Docker Hub's burst 403s, because asking again immediately spends
 * another request from the very window that is empty and can extend the block.
 */
function isSearchQuotaExhausted(err) {
  return Number(err?.status) === 403
    && (err?.code === 'quota'
      || /rate limit|secondary rate limit|abuse detection/i.test(String(err?.upstreamMessage ?? '')));
}

async function fetchJson(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, accept = 'application/json', cache, onResponse } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const etag = cache?.etagFor(url);
    // The *status* is checked inside the retried step, not after it: a 403 tells
    // us to come back later, and a retry that cannot see the 403 is not a retry.
    const res = await withFastRetry(async () => {
      cache?.noteRequest();
      const r = await fetchImpl(url, {
        signal: ctl.signal,
        headers: { ...REQUEST_HEADERS, accept, ...(etag ? { 'if-none-match': etag } : {}) },
      });
      if (!r.ok && r.status !== 304) {
        const err = new Error(`HTTP ${r.status}`);
        // The status rides on the error so `withFastRetry` can tell "the
        // upstream told us to slow down / is briefly broken" (retry) from
        // "this resource is not there" (never retry).
        err.status = r.status;
        // Registries explain themselves in the body, and some 403s are not
        // rate limits at all — Docker Hub answers "pagination offset too large
        // for anonymous requests; sign in to page further", which is the end
        // of the list for us, not a failure. Best effort: a body that is not
        // JSON, or a fake fetch in a test, must not change the error.
        try {
          const body = await r.json();
          if (typeof body?.message === 'string') err.upstreamMessage = body.message;
        } catch { /* no body to read: the status stands alone */ }
        if (isGithubSearch(url)) noteSearchQuota(r, { failed: true });
        throw err;
      }
      if (isGithubSearch(url)) noteSearchQuota(r);
      onResponse?.(r);
      return r;
    });
    if (res.status === 304) {
      const body = cache?.reuse(url);
      if (body !== undefined) return body;
      throw new Error('HTTP 304 without a cached body');
    }
    const body = await res.json();
    // Measured after parsing: the registry answers gzip, so Content-Length
    // would understate what this body actually costs us to hold.
    const size = JSON.stringify(body ?? null)?.length ?? 0;
    cache?.noteDownload(size);
    cache?.remember(url, { etag: res.headers?.get?.('etag'), body, bytes: size });
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One retry for the two failure modes that actually recover on their own:
 *
 * 1. A fast network-level failure (`fetch failed`: DNS, TCP reset, proxy
 *    refusal — the lossy-path condition this host demonstrably has). Waiting
 *    ~1.5s is enough.
 * 2. A rate-limit or transient upstream error (`403`, `408`, `425`, `429`,
 *    any `5xx`). `hub.docker.com` answers `403` in bursts (its edge limits what
 *    it thinks is a bot) and the same request succeeds moments later; GitHub's
 *    anonymous search budget answers `403` too. These get a longer pause, since
 *    the upstream is asking for time rather than having dropped a packet.
 *
 * Timeouts are deliberately NOT retried: the 90s awesome-README budget retried
 * once would hold a market request open for three minutes. `404` is not
 * retried either — a missing mirror file stays missing.
 */
async function withFastRetry(fn, { delayMs = 1500, statusDelayMs = 2500 } = {}) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    return await fn();
  } catch (err) {
    // A policy refusal does not change after 2.5 seconds: Docker Hub's
    // anonymous page cap and anything like it is final until someone signs in.
    if (isAnonymousPageLimit(err)) throw err;
    // Neither does an emptied budget. GitHub search answers
    // `API rate limit exceeded for <ip>` on a 403, and the next request in the
    // same window fails the same way — retrying here spends another token from
    // a window that has none and can extend the block. Callers that can wait
    // (the census walk) wait; this layer just reports it.
    if (isSearchQuotaExhausted(err)) throw err;
    const message = String(err?.cause?.message ?? err?.message ?? '');
    if (/fetch failed/i.test(message)) {
      await wait(delayMs);
      return fn();
    }
    const status = Number(err?.status);
    if (status === 403 || status === 408 || status === 425 || status === 429 || status >= 500) {
      await wait(statusDelayMs);
      return fn();
    }
    throw err;
  }
}

const clampText = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Docker Hub refuses anonymous pagination past the first page with a 403 whose
 * body says so. That is a policy answer about *who is asking*, not a transient
 * failure: retrying is pointless and reporting the source as broken is wrong.
 * The phrase is matched (not just the status) because a plain 403 is still a
 * rate limit worth retrying.
 */
function isAnonymousPageLimit(err) {
  return Number(err?.status) === 403
    && /pagination offset too large for anonymous requests/i.test(String(err?.upstreamMessage ?? ''));
}

/** `ai.0si/disclosures` -> `ai.0si`; `owner/repo` -> `owner`. */
function authorFromQualified(qualified) {
  const s = String(qualified ?? '');
  const slash = s.indexOf('/');
  const scope = slash > 0 ? s.slice(0, slash) : '';
  return scope.replace(/^@/, '') || undefined;
}

// ---------------------------------------------------------------------------
// official modelcontextprotocol registry
// ---------------------------------------------------------------------------

/** Hard ceiling on upstream requests per source per browse. */
const MAX_UPSTREAM_PAGES = 4;

/**
 * Fetch a page (or several) of the official registry.
 *
 * The registry stores one record *per published version*, so a plain full walk
 * returns thousands of rows for a few thousand distinct servers. Pass
 * `dedupe: true` to keep only the newest record per `name`, which is what a
 * market listing wants — it turns ~7242 records into ~2582 servers and keeps
 * the page from being 70% duplicate versions of the same project.
 */
export async function fetchOfficialRegistry({ limit = 100, cursor, query = '', pages = 1, dedupe = false, ...opts } = {}) {
  const items = [];
  let nextCursor = cursor;
  let page = 0;
  do {
    const url = new URL('https://registry.modelcontextprotocol.io/v0/servers');
    url.searchParams.set('limit', String(Math.min(limit, 100)));
    if (nextCursor) url.searchParams.set('cursor', nextCursor);
    if (query) url.searchParams.set('search', query);
    const data = await fetchJson(url.toString(), { timeoutMs: OFFICIAL_TIMEOUT_MS, ...opts });
    for (const entry of data.servers ?? []) {
      const item = normalizeOfficialItem(entry);
      if (item) items.push(item);
    }
    nextCursor = data.metadata?.nextCursor ?? null;
    page += 1;
  } while (nextCursor && page < Math.min(pages, MAX_UPSTREAM_PAGES));

  if (!dedupe) return { items, nextCursor };

  // Keep one record per server name. `isLatest` is the registry's own flag and
  // wins outright; otherwise fall back to the newest `updatedAt`, then the
  // highest version. Without this a full walk returns thousands of rows for a
  // few thousand servers and the page is mostly duplicate versions.
  const best = new Map();
  for (const item of items) {
    const key = item.raw?.name ?? item.id;
    const held = best.get(key);
    if (!held) { best.set(key, item); continue; }
    if (item.isLatest && !held.isLatest) { best.set(key, item); continue; }
    if (held.isLatest && !item.isLatest) continue;
    const rank = String(item.updatedAt ?? '');
    const heldRank = String(held.updatedAt ?? '');
    if (rank > heldRank) { best.set(key, item); continue; }
    if (rank === heldRank && compareVersions(item.version ?? '0', held.version ?? '0') > 0) best.set(key, item);
  }
  return { items: [...best.values()], nextCursor };
}

/**
 * Normalize one official-registry entry. The 2025-12 schema nests the record
 * under `server`; older payloads were flat, so both shapes are accepted.
 *
 * `_meta` (the outer wrapper) carries `io.modelcontextprotocol.registry/official`
 * with `status`, `publishedAt`, `updatedAt` and `isLatest` — the last of which
 * is the registry's own "this is the current version of this server" flag, so
 * it is the first choice when picking a representative record.
 */
function normalizeOfficialItem(entry) {
  const s = entry?.server ?? entry;
  if (!s?.name) return null;
  const meta = entry?._meta?.['io.modelcontextprotocol.registry/official'] ?? entry?._meta ?? {};

  const packages = s.packages ?? [];
  const pkg = packages.find((p) => (p.registry_type ?? p.registryType) === 'npm') ?? packages[0];
  const remote = (s.remotes ?? [])[0];
  const repoUrl = s.repository?.url ?? s.repository;
  const identifier = pkg?.identifier ?? pkg?.name;

  let install = null;
  if (identifier && (pkg.registry_type ?? pkg.registryType) === 'npm') {
    install = { transport: 'stdio', command: 'npx', args: ['-y', identifier] };
  } else if (identifier) {
    install = { transport: 'stdio', command: 'uvx', args: [identifier] };
  } else if (remote?.url) {
    install = { transport: 'streamable-http', url: remote.url };
  }

  const tags = [];
  if (identifier) tags.push((pkg.registry_type ?? pkg.registryType) === 'npm' ? 'npm' : 'pypi');

  // Most registry records are `namespace/name` with no title; the last segment
  // reads far better on a card than the raw reverse-DNS identifier.
  const lastSegment = String(s.name).split('/').filter(Boolean).pop() ?? s.name;

  return {
    id: `official:${s.name}`,
    title: s.title || lastSegment,
    description: clampText(s.description),
    source: 'official-registry',
    author: authorFromQualified(s.name),
    version: s.version ?? undefined,
    transport: install?.transport ?? 'unknown',
    install,
    repository: typeof repoUrl === 'string' ? repoUrl : undefined,
    homepage: typeof s.websiteUrl === 'string' ? s.websiteUrl : undefined,
    icon: undefined,
    tags,
    official: true,
    updatedAt: meta.updatedAt ?? meta.publishedAt ?? undefined,
    isLatest: meta.isLatest === true ? true : undefined,
    // The registry's own lifecycle flag, carried verbatim. Only `deprecated`
    // is acted on; anything else (including an unknown future status) is
    // surfaced as-is rather than guessed at.
    status: typeof meta.status === 'string' ? meta.status : undefined,
    statusMessage: typeof meta.statusMessage === 'string' ? meta.statusMessage : undefined,
    deprecated: meta.status === 'deprecated' ? true : undefined,
    raw: s,
  };
}

// ---------------------------------------------------------------------------
// Smithery
// ---------------------------------------------------------------------------

export async function fetchSmithery({ query = '', page = 1, ...opts } = {}) {
  // Public registry listing; pagination via `page`.
  const url = new URL('https://registry.smithery.ai/servers');
  if (query) url.searchParams.set('q', query);
  url.searchParams.set('page', String(page));
  const data = await fetchJson(url.toString(), opts);
  const list = data.servers ?? data ?? [];
  const items = (Array.isArray(list) ? list : []).map((s) => {
    const qualified = s.qualifiedName ?? s.name;
    return {
      id: `smithery:${qualified}`,
      title: s.displayName ?? s.name ?? qualified,
      description: clampText(s.description),
      source: 'smithery',
      author: s.namespace ?? authorFromQualified(qualified),
      version: s.version ?? undefined,
      // The card shows how *this* registry will launch it (through the Smithery
      // CLI), not how Smithery itself hosts it — the hosted/remote flag becomes
      // a tag instead, so the label and the install plan never disagree.
      transport: qualified ? 'stdio' : 'unknown',
      install: qualified
        ? { transport: 'stdio', command: 'npx', args: ['-y', '@smithery/cli', 'run', qualified] }
        : null,
      repository: s.repository?.url ?? s.homepage,
      homepage: s.homepage,
      icon: typeof s.iconUrl === 'string' ? s.iconUrl : undefined,
      tags: [s.remote ? '托管' : '本地'].filter(Boolean),
      installs: typeof s.useCount === 'number' ? s.useCount : undefined,
      // What `useCount` actually counts, so the card can say so rather than
      // presenting a platform-specific number as a universal popularity score.
      installsLabel: '次启动',
      installsWindow: undefined,
      verified: s.verified === true ? true : undefined,
      // Smithery's own lifecycle flags. `inactive` means the upstream no longer
      // serves it; `unlisted` means it is hidden from their directory but still
      // works. Only the first is a deprecation.
      status: s.inactive === true ? 'inactive' : s.unlisted === true ? 'unlisted' : 'active',
      deprecated: s.inactive === true ? true : undefined,
      raw: s,
    };
  }).filter((i) => i.title);
  return { items, hasNext: Boolean(data.nextPage ?? data.hasNext) };
}

// ---------------------------------------------------------------------------
// Docker MCP Catalog (hub.docker.com/v2/repositories/mcp/)
// ---------------------------------------------------------------------------

/**
 * Docker's MCP catalog: ~245 namespaced images under `mcp/<name>`, all of them
 * runnable via `docker run mcp/<name>`. Carries `pull_count` (a far better
 * popularity signal than stars for this list) and a description.
 *
 * `docker run` needs a Docker daemon, so these entries are reported with their
 * install plan and transport but are flagged as container-based; the caller
 * decides whether to expose them as one-click installs.
 */
export async function fetchDockerCatalog({ limit = 100, pages = 3, ...opts } = {}) {
  const items = [];
  let page = 1;
  let note;
  let lastCount;
  while (items.length < limit && page <= Math.min(pages, MAX_UPSTREAM_PAGES)) {
    const url = new URL(`https://hub.docker.com/v2/repositories/mcp/`);
    url.searchParams.set('page_size', '100');
    url.searchParams.set('page', String(page));
    let data;
    try {
      data = await fetchJson(url.toString(), opts);
    } catch (err) {
      // Anonymous pagination stops at the first page: ask for page 2 and Docker
      // Hub answers 403 "pagination offset too large for anonymous requests;
      // sign in to page further". That is the end of the list we are allowed to
      // read, not a broken source — and retrying it forever would be a lie.
      if (isAnonymousPageLimit(err)) {
        note = `Docker Hub 匿名只放出第一页（共 ${lastCount ?? '?'} 个镜像，已取 ${items.length}）——翻页需要登录。`;
        break;
      }
      throw err;
    }
    if (typeof data.count === 'number') lastCount = data.count;
    const results = data.results ?? [];
    for (const repo of results) {
      const name = repo.name?.replace(/^mcp\//, '') ?? '';
      if (!name) continue;
      const namespace = repo.namespace ?? 'library';
      items.push({
        id: `docker:mcp/${name}`,
        title: name,
        description: clampText(repo.description),
        source: 'docker-catalog',
        author: namespace,
        transport: 'stdio',
        install: { transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', `mcp/${name}`] },
        repository: `https://hub.docker.com/r/mcp/${name}`,
        homepage: `https://hub.docker.com/r/mcp/${name}`,
        tags: namespace && namespace !== 'library' ? [`Docker · ${namespace}`] : ['Docker'],
        installs: typeof repo.pull_count === 'number' ? repo.pull_count : undefined,
        // Docker reports lifetime pulls, not a rolling window — a different
        // quantity from Smithery's use count and not comparable to it.
        installsLabel: '次拉取',
        installsWindow: '累计',
        verified: repo.is_official === true || repo.affiliation === 'OFFICIAL' ? true : undefined,
        official: repo.is_official === true || undefined,
        // Docker reports a numeric status (1 = active). Anything else means the
        // image is no longer published, which is a deprecation.
        status: repo.status === 1 || repo.status === undefined ? 'active' : `status:${repo.status}`,
        deprecated: repo.status !== undefined && repo.status !== 1 ? true : undefined,
        // `last_updated` is the only staleness signal Docker gives; an image
        // untouched for years is a maintenance signal, not a verdict.
        updatedAt: typeof repo.last_updated === 'string' ? repo.last_updated : undefined,
      });
    }
    if (!data.next) break;
    page += 1;
  }
  // `note` is a coverage fact the panel shows beside the source's own row count
  // ("共 245，已取 100"): a list that is quietly a third of what the source has
  // is exactly the kind of number this plugin refuses to fake.
  return { items: items.slice(0, limit), note };
}

// ---------------------------------------------------------------------------
// GitHub search — MCP servers published as repositories
// ---------------------------------------------------------------------------

/**
 * "3 小时前" — an age as the panel and the source notes say it.
 *
 * Lives here rather than in `lib/github-index.js` because this module is what
 * composes the source notes: the Docker source already reports what it could
 * not reach, and an index-backed source has to report how old its census is in
 * the same voice.
 */
export function describeAge(ageMs) {
  if (!Number.isFinite(ageMs)) return '时间未知';
  const minutes = Math.floor(Math.max(0, ageMs) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * One search request. Split out because the index walk asks the same endpoint
 * hundreds of times with windows of its own, and both callers must send the
 * identifying User-Agent, the pinned accept type and the retry policy.
 *
 * @returns { repos, totalCount } — `totalCount` is the *window's* hit count, the
 *   number that decides whether the 1000-row ceiling is hiding more rows.
 */
export async function searchGithubRepos({ query, page = 1, perPage = 100, ...opts } = {}) {
  // The budget is shared by everything on this IP, so a caller that already
  // knows it is empty must not spend another request to be told so again. The
  // error carries the wait, and `code: 'quota'` is what lets the walk say
  // "come back in 40 seconds" instead of "HTTP 403".
  const waitMs = searchQuota.blockedUntil - Date.now();
  if (waitMs > 0) {
    const err = new Error(`搜索配额已用完（约 ${Math.ceil(waitMs / 1000)} 秒后恢复）`);
    err.status = 403;
    err.code = 'quota';
    err.upstreamMessage = searchQuota.reason ?? 'API rate limit exceeded';
    err.retryAfterMs = waitMs;
    throw err;
  }
  const url = new URL(GITHUB_SEARCH_URL);
  url.searchParams.set('q', String(query ?? ''));
  url.searchParams.set('sort', 'stars');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(Math.max(1, Math.min(100, perPage))));
  url.searchParams.set('page', String(Math.max(1, page)));
  try {
    const data = await fetchJson(url.toString(), { ...opts, accept: 'application/vnd.github+json' });
    return {
      repos: Array.isArray(data?.items) ? data.items : [],
      totalCount: Number(data?.total_count ?? 0),
    };
  } catch (err) {
    if (isSearchQuotaExhausted(err)) {
      err.code = 'quota';
      const wait = searchQuota.blockedUntil - Date.now();
      if (wait > 0) err.retryAfterMs = wait;
    }
    throw err;
  }
}

/**
 * One repository, as a market row.
 *
 * `raw` (the whole search response object) is dropped for indexed rows: an index
 * of thousands of repositories cannot carry thousands of copies of a payload
 * nothing reads — the host already strips `raw` before the panel sees it.
 * Returns null for a row without a full name, which is a fact about the answer
 * rather than something to guess around.
 */
export function githubItemOf(repo, { includeRaw = true } = {}) {
  const fullName = String(repo?.full_name ?? '');
  if (!fullName) return null;
  const [owner, name] = fullName.split('/');
  return {
    id: `github:${fullName}`,
    title: clampText(name || fullName, 120),
    description: clampText(repo.description),
    source: 'github-mcp',
    author: repo.owner?.login ?? owner,
    // Nothing here is installable on evidence: no transport is declared
    // anywhere in a repository listing.
    transport: 'unknown',
    install: null,
    repository: repo.html_url ?? `https://github.com/${fullName}`,
    homepage: repo.homepage || undefined,
    tags: Array.isArray(repo.topics) ? repo.topics.slice(0, 8) : [],
    // GitHub states no verification, and guessing "official" from a big owner
    // name would be exactly the kind of claim this panel refuses.
    verified: undefined,
    official: undefined,
    // The queries ask for `archived:false`, so this should never fire — but if
    // the upstream ever answers with an archived repository, saying so beats
    // calling a dead project active.
    status: repo.archived === true ? 'archived' : 'active',
    deprecated: repo.archived === true || undefined,
    // Stars come from the search response itself, so the card has them even
    // when the enrichment pass is skipped or its 60/hour budget is spent. The
    // same is true of the three facts below: they are already in this response,
    // and the card renders `item.*` as a fallback — a repository row should not
    // be a blank card just because /repos was not called.
    stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : undefined,
    language: typeof repo.language === 'string' && repo.language ? repo.language : undefined,
    forks: typeof repo.forks_count === 'number' ? repo.forks_count : undefined,
    openIssues: typeof repo.open_issues_count === 'number' ? repo.open_issues_count : undefined,
    updatedAt: typeof repo.pushed_at === 'string' ? repo.pushed_at : undefined,
    ...(includeRaw ? { raw: repo } : {}),
  };
}

/**
 * What an index-backed source says on its own row.
 *
 * Two facts, because they are different facts: how big the census is (and how
 * old), and how much of it this listing took. A panel that showed only "168"
 * next to a source holding 1758 rows would be the quiet half-truth this plugin
 * exists to avoid.
 */
export function githubIndexNote(index, { listed = 0 } = {}) {
  const total = index?.rows?.length ?? 0;
  const ageMs = Number.isFinite(index?.ageMs)
    ? index.ageMs
    : index?.at ? Date.now() - Date.parse(index.at) : NaN;
  const parts = [`本地索引 ${total} 行`, describeAge(ageMs)];
  if (index?.stale) parts.push('待更新');
  if (index?.partial) parts.push(`上次抓取未走完：${index.partial}`);
  return `${parts.join('・')}；本次列出 ${Math.max(0, listed)} 条`;
}

/**
 * GitHub's own repository search. This is the only source here that can see a
 * server *the day it is published*: the curated catalogues are edited by hand
 * (or by one list's maintainer), so a repository nobody has heard of yet is
 * invisible to them and visible here.
 *
 * Two ways to read it, and the index is the one that matters:
 *
 *   - **The local index** (`opts.githubIndex`, walked by `lib/github-index.js`)
 *     is a census of the population, kept on disk and read here with no
 *     request at all. This is what makes the source a catalogue rather than a
 *     sample: search reaches every row the index holds, not just the newest 200.
 *   - **The live three-query search** below stays as the first-run fallback and
 *     as what a failed index read degrades to, so the source is never empty
 *     just because a crawl has not finished yet.
 *
 * The three queries, because GitHub's search has no OR across qualifiers and
 * each one answers a different question:
 *
 *   `mcp-server in:name archived:false`  — the repository calls itself an MCP
 *       server (53.7k hits; the precise one: github-mcp-server, firecrawl-,
 *       notion-, cloudflare-mcp-server …)
 *   `topic:mcp-server mcp in:description archived:false` — the repository
 *       carries the tag *and* says MCP in its description (26.2k hits). A bare
 *       `topic:mcp-server` finds 36.7k, but its star-sorted head is n8n,
 *       gemini-cli and awesome-mcp-servers: a *tag* is applied loosely, and the
 *       biggest projects that merely ship or consume MCP outrank the servers.
 *       Requiring the description to mention MCP (measured here: the same query
 *       ranks github/github-mcp-server third) keeps the point of the tag query —
 *       finding a project that does not put "mcp" in its *name* — and drops the
 *       largest platforms. It is still a tag, so a platform with an MCP feature
 *       page survives it; the card shows language, topics and last push so that
 *       is visible rather than hidden.
 *   `topic:model-context-protocol mcp in:name archived:false` — the other tag
 *       the ecosystem actually uses, and this one is intersected with the name
 *       (22.0k hits). It exists for the gap the first two leave: a server named
 *       `…-mcp` rather than `…-mcp-server`. Measured: its star-sorted head holds
 *       DeusData/codebase-memory-mcp (46.6k) and ahujasid/mcp-for-blender
 *       (30.9k), neither of which either other query can return. The bare tag
 *       (36.7k) is not used for the same reason as above — its head is morluto/rea
 *       (263k), HKUDS/nanobot and PrefectHQ/fastmcp, i.e. products and SDKs.
 *       The bare `mcp in:name` (334.6k) is looser still and mostly round-ups.
 *
 * The three answers are then ranked against each other by stars before the cut:
 * each query is sorted upstream, but "the 200 best repositories we can find" is
 * a fact about the union, not about whichever query happened to run first.
 *
 * Rate limit: anonymous search gets **10 requests per minute** — a separate
 * budget from the 60/hour core API — so the cap is counted in requests, not
 * pages: three per browse, and the ETag layer turns most repeats into 304s.
 * Requests must carry a User-Agent (see USER_AGENT): without one the same IP
 * gets `403 API rate limit exceeded` instead of rows.
 *
 * These rows are discovery-only (`install: null`). Nothing in a repository
 * listing says how to run it — no package name, no command — and guessing
 * `npx <repo-name>` would put a button on the card that fails. The card offers
 * the repository, its stars and its topics; installation goes through the
 * project's own README.
 */
export async function fetchGithubMcp({ limit = 200, pages = 3, query = '', githubIndex = null, githubWalk = null, ...opts } = {}) {
  // The index is read, not walked: no request, no ETag, no rate limit. A query
  // filters the census here rather than after the cut, which is the whole point
  // of holding one — searching for a repository ranked 900th must not come back
  // empty because only the top 200 were handed to the merge.
  if (githubIndex?.rows?.length) {
    const q = String(query ?? '').trim();
    const rows = q ? githubIndex.rows.filter((item) => matchItem(item, q)) : githubIndex.rows;
    const items = rows.slice(0, limit);
    return {
      items,
      note: githubIndexNote(githubIndex, { listed: items.length }),
      index: {
        rows: githubIndex.rows.length,
        matched: rows.length,
        at: githubIndex.at ?? null,
        ageMs: Number.isFinite(githubIndex.ageMs) ? githubIndex.ageMs : undefined,
        stale: githubIndex.stale === true,
        complete: githubIndex.complete === true,
        partial: githubIndex.partial ?? null,
      },
      // The rows' own timestamp, so the panel reports the census's age rather
      // than the moment this listing happened to read it.
      dataAt: githubIndex.at ?? undefined,
    };
  }

  // A census walk is running and has not written a row yet. Asking for the same
  // three queries now would spend the *same* 10-per-minute budget the walk is
  // spending — which is how this source came to report itself broken. Say so
  // instead: the row count is zero and the reason is a sentence, not a 403.
  if (githubWalk) {
    const held = Number(githubWalk.rows ?? 0);
    return {
      items: [],
      note: held > 0
        ? `正在建立本机普查索引（已收 ${held} 行），稍后这里直接读索引`
        : '正在建立本机普查索引（首次建索引需要几分钟），稍后这里直接读索引',
      walk: { requests: Number(githubWalk.requests ?? 0), rows: held },
    };
  }

  const QUERIES = [
    'mcp-server in:name archived:false',
    'topic:mcp-server mcp in:description archived:false',
    'topic:model-context-protocol mcp in:name archived:false',
  ];
  const items = [];
  const seen = new Set();
  // Every selected query runs: stopping as soon as `limit` rows were collected
  // would make the third query dead weight (the first two already fill 200) and
  // would hand the market whichever query happened to be first.
  try {
    for (const q of QUERIES.slice(0, Math.max(1, pages))) {
      const { repos } = await searchGithubRepos({ query: q, perPage: 100, ...opts });
      for (const repo of repos) {
        const item = githubItemOf(repo);
        if (!item || seen.has(repo.full_name)) continue;
        seen.add(repo.full_name);
        items.push(item);
      }
    }
  } catch (err) {
    if (err?.code !== 'quota') throw err;
    // The budget is empty. Rows already read are still rows, and the reason is
    // carried on the source line: an emptied window is a wait, not a broken
    // source, and saying `HTTP 403` here made the panel call it unavailable.
    const seconds = Number.isFinite(err.retryAfterMs) ? Math.ceil(err.retryAfterMs / 1000) : null;
    const rankedSoFar = items.slice().sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0)).slice(0, limit);
    return {
      items: rankedSoFar,
      note: seconds
        ? `GitHub 搜索配额已用完（约 ${seconds} 秒后恢复）；本机普查索引建好后这里不再发请求`
        : 'GitHub 搜索配额已用完；本机普查索引建好后这里不再发请求',
      quota: githubSearchQuota(),
    };
  }
  // Rank the union, not each answer: a query's own order is only meaningful
  // inside that query. Ties keep the earlier (more precise) query's row, which
  // is why the sort is stable by insertion.
  const ranked = items.slice().sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  return { items: ranked.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// awesome-remote-mcp-servers (hosted remote endpoints)
// ---------------------------------------------------------------------------

/**
 * punkpeye/awesome-remote-mcp-servers — the companion list of *hosted* MCP
 * endpoints. Unlike the local-server list these rows carry a bare URL in
 * backticks, which is directly installable as streamable-http, so this source
 * is one-click rather than discovery-only.
 *
 * Row shape (description is a continuation line indented by two spaces):
 *   - [7Maps](https://7it.co.il/7maps/) `https://7it.co.il/7maps/mcp`
 *     [![badge](svg)](glama)  🔓 - Daily map of 22,000+ public MCP servers…
 *   🔓 means no auth, 🔐 requires a credential.
 */
export async function fetchAwesomeRemote({ limit = 200, text: injected, ...opts } = {}) {
  const text = injected ?? await fetchFirstText(
    awesomeMirrors('punkpeye', 'awesome-remote-mcp-servers', 'main', 'README.md'),
    opts,
  );
  const lines = String(text).split(/\r?\n/);
  const items = [];
  const seen = new Set();
  let category = '';
  let pending = null;   // a `- [name](home) \`url\`` row awaiting its description

  const flush = () => {
    if (!pending) return;
    if (pending.url && !seen.has(pending.url)) {
      seen.add(pending.url);
      items.push({
        id: `remote:${pending.url}`,
        title: pending.title,
        description: clampText(pending.description),
        source: 'awesome-remote',
        author: hostOf(pending.url),
        transport: 'streamable-http',
        install: { transport: 'streamable-http', url: pending.url },
        repository: undefined,
        homepage: pending.homepage,
        category: category || undefined,
        tags: [category, pending.auth === '🔐' ? '需登录' : '免登录'].filter(Boolean),
        // No lifecycle field ships with these rows either. Note that the list
        // itself is the only freshness evidence available for a hosted
        // endpoint: if the URL stops answering, nothing here says so.
        status: undefined,
        deprecated: undefined,
      });
    }
    pending = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) { flush(); category = stripAnchorTags(h3[1]).replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '').trim(); continue; }
    if (/^##\s/.test(line)) { flush(); category = ''; continue; }

    // `- [Title](homepage) \`https://endpoint/mcp\`` — the backticked URL wins.
    const bullet = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s+`([^`]+)`/);
    if (bullet) {
      flush();
      pending = { title: bullet[1], homepage: bullet[2], url: bullet[3], description: '', auth: '' };
      const auth = line.match(/(🔓|🔐)/);
      if (auth) pending.auth = auth[1];
      continue;
    }

    // Continuation: indented badge + `<flag> - description`.
    if (pending) {
      const m = line.match(/(🔓|🔐)\s*[-–—]\s*(.+)$/);
      if (m) { pending.auth = m[1]; pending.description = m[2]; continue; }
      if (!/^\[?![^\]]*\]?\(/.test(line) && pending.description) { pending.description += ` ${line}`; continue; }
    }
  }
  flush();
  return { items: items.slice(0, limit) };
}

/** `https://api.linear.app/mcp` -> `api.linear.app`. */
function hostOf(url) {
  try { return new URL(String(url ?? '')).hostname.replace(/^www\./, ''); } catch { return undefined; }
}

// ---------------------------------------------------------------------------
// awesome-mcp-servers (community index)
// ---------------------------------------------------------------------------

/** Language / scope / OS emojis documented in the README "Legend" section. */
const LEGEND = {
  '🐍': 'Python', '📇': 'TypeScript', '🏎️': 'Go', '🏎': 'Go', '🦀': 'Rust',
  '#️⃣': 'C#', '☕': 'Java', '🌊': 'C/C++', '💎': 'Ruby',
  '☁️': '云服务', '☁': '云服务', '🏠': '本地', '📟': '嵌入式',
  '🍎': 'macOS', '🪟': 'Windows', '🐧': 'Linux',
  '🎖️': '官方实现', '🎖': '官方实现',
};

/** Pull the legend emojis present in a line, in legend order, deduped. */
function legendTags(text) {
  const found = [];
  for (const [emoji, label] of Object.entries(LEGEND)) {
    if (text.includes(emoji) && !found.includes(label)) found.push(label);
  }
  return found;
}

/**
 * The first *non-image* markdown link on a line. Entries embed a glama badge
 * (`[![name MCP server](badge.svg)](glama-url)`) before the real repository
 * link, and matching naively picks the badge up as if it were the server.
 */
function firstRealLink(line) {
  const re = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[1] === '!') continue; // image/badge
    return { text: m[2], url: m[3], index: m.index, length: m[0].length };
  }
  return null;
}

/** `https://github.com/owner/repo` -> `{ owner, repo }` (else null). */
function parseGitHub(url) {
  const m = String(url ?? '').match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
}

const stripAnchorTags = (s) => String(s).replace(/<a\s+name="[^"]*"\s*><\/a>/gi, '').replace(/<[^>]+>/g, '');

/**
 * The community "awesome-mcp-servers" index. Discovery only: these rows link to
 * third-party repositories, so no run command is inferred (installing them
 * safely needs the row's own README). Parses the `### <emoji> <category>` +
 * `- [owner/repo](url) [badge] <flags> - <description>` structure.
 */
export async function fetchAwesomeList({ limit = 200, text: injected, ...opts } = {}) {
  const text = injected ?? await fetchFirstText(
    awesomeMirrors('punkpeye', 'awesome-mcp-servers', 'main', 'README.md'),
    opts,
  );
  const items = [];
  const seen = new Set();
  let category = '';

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      category = stripAnchorTags(h3[1]).replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '').trim();
      continue;
    }
    if (/^##\s/.test(line)) { category = ''; continue; }   // leave the server section

    // Legacy table shape: | [<name>](<url>) | <description> | ... |
    if (line.startsWith('|')) {
      const cells = line.split('|').map((c) => c.trim()).filter((c) => c !== '');
      if (cells.length < 2) continue;
      const link0 = firstRealLink(cells[0]);
      if (!link0) continue;
      const entry = pushAwesome(items, seen, link0, cells.slice(1).join(' '), '', category);
      if (entry && items.length >= limit) break;
      continue;
    }

    if (!/^[-*]\s/.test(line)) continue;

    const link = firstRealLink(line);
    if (!link || !/^https?:\/\//i.test(link.url)) continue;

    // Everything except the links is either legend flags or the description.
    const rest = line.replace(/!?\[[^\]]*\]\([^)\s]+\)/g, ' ').replace(/^[-*]\s*/, '').trim();
    const parts = rest.split(/\s+[-–—]\s+/);
    const flags = parts.length > 1 ? parts[0] : '';
    const description = parts.length > 1 ? parts.slice(1).join(' - ') : rest;

    const entry = pushAwesome(items, seen, link, description, flags, category);
    if (entry && items.length >= limit) break;
  }
  return { items };
}

/**
 * Append one parsed awesome-list row (bullet or table shape) and report whether
 * it produced an item, so callers can stop at their limit.
 */
function pushAwesome(items, seen, link, rawDescription, flags, category) {
  const gh = parseGitHub(link.url);
  const key = (gh ? `${gh.owner}/${gh.repo}` : link.url).toLowerCase();
  if (seen.has(key)) return null;

  const description = clampText(rawDescription);
  if (!description && !gh) return null;    // table-of-contents / stray bullets

  seen.add(key);
  const legend = legendTags(flags);
  const tags = legend.slice();
  if (category) tags.unshift(category);

  items.push({
    id: `awesome:${key}`,
    title: gh ? gh.repo : link.text.replace(/^@/, ''),
    description,
    source: 'awesome-list',
    author: gh?.owner,
    // The `###` heading the row sat under. A first-class field rather than
    // tags[0] so the market's category filter survives tag merging and so the
    // two lists' taxonomies (65 + 40 headings, with synonym drift between
    // them) are shown exactly as the upstreams wrote them.
    category: category || undefined,
    transport: 'unknown',
    install: null,
    repository: gh ? `https://github.com/${gh.owner}/${gh.repo}` : link.url,
    homepage: gh ? `https://github.com/${gh.owner}/${gh.repo}` : undefined,
    icon: gh ? `https://github.com/${gh.owner}.png?size=80` : undefined,
    tags: tags.filter(Boolean),
    official: legend.includes('官方实现') || undefined,
    stars: undefined,
    // No lifecycle field is published with these rows, so none is invented:
    // `status` stays absent and the UI says "未扫描" rather than "active".
    status: undefined,
    deprecated: undefined,
  });
  return items[items.length - 1];
}

/**
 * @deprecated PulseMCP sunset its public API (`API_SUNSET`, v0beta returns 410
 * and the newer paths 404). Kept so an existing configuration keeps parsing if
 * the upstream returns; not part of the default source set.
 */
export async function fetchPulseMcp({ page = 1, ...opts } = {}) {
  const url = `https://api.pulsemcp.com/v0beta/servers?count_per_page=100&offset=${(page - 1) * 100}`;
  const data = await fetchJson(url, opts);
  const list = data.servers ?? [];
  const items = list.map((s) => ({
    id: `pulsemcp:${s.slug ?? s.name}`,
    title: s.name,
    description: clampText(s.short_description ?? s.description),
    source: 'pulsemcp',
    author: parseGitHub(s.source_code_url ?? s.url)?.owner,
    transport: 'unknown',
    install: null,
    repository: s.source_code_url ?? s.url,
    homepage: s.url,
    icon: parseGitHub(s.source_code_url ?? '') ? `https://github.com/${parseGitHub(s.source_code_url).owner}.png?size=80` : undefined,
    tags: [],
    raw: s,
  })).filter((i) => i.title);
  return { items };
}

/** The default market source set, in display order. */
export const CATALOG_SOURCES = [
  'official-registry',
  'smithery',
  'docker-catalog',
  'github-mcp',
  'awesome-remote',
  'awesome-list',
];

/** True for the ids of user-added sources (see `lib/custom-sources.js`). */
export function isCustomSourceId(id) {
  return typeof id === 'string' && id.startsWith('custom:');
}

/**
 * Map one user-supplied registry document into catalogue items.
 *
 * The accepted shapes are the plugin's own registry (`{ servers: [...] }`, which
 * is what the GitHub Action in the README emits), a plain array of rows, or a
 * `{ items: [...] }` wrapper. Only fields that can be *acted on* are read: a
 * name, a description, and a command/URL that the install button can use.
 *
 * Deliberately not read: any popularity or download figure the document claims.
 * The built-in sources publish counts this panel cannot verify either, but those
 * at least come from a registry with its own moderation; a number in someone's
 * own file is an assertion, and the listing orders by it.
 */
export function mapCustomEntries(doc, def, { max = 1000 } = {}) {
  const rows = Array.isArray(doc) ? doc : Array.isArray(doc?.servers) ? doc.servers : Array.isArray(doc?.items) ? doc.items : [];
  const items = [];
  const seen = new Set();
  for (const row of rows) {
    if (items.length >= max) break;
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const title = String(row.name ?? row.title ?? '').trim().slice(0, 120);
    if (!title) continue;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `row-${items.length}`;
    const id = `${def.id}:${slug}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const gh = parseGitHub(row.repository);
    // A row is installable only if it carries a command or an endpoint; the
    // install button needs one of the two and nothing is inferred for it.
    let install = null;
    if (typeof row.command === 'string' && row.command.trim()) {
      install = {
        transport: 'stdio',
        command: row.command.trim(),
        args: Array.isArray(row.args) ? row.args.filter((a) => typeof a === 'string').slice(0, 32) : [],
      };
    } else if (typeof row.url === 'string' && row.url.trim()) {
      install = { transport: 'streamable-http', url: row.url.trim() };
    }
    items.push({
      id,
      title,
      description: clampText(row.description),
      source: def.id,
      author: typeof row.author === 'string' && row.author ? row.author : gh?.owner,
      transport: install?.transport ?? 'unknown',
      install,
      repository: typeof row.repository === 'string' && row.repository ? row.repository : undefined,
      homepage: typeof row.homepage === 'string' && row.homepage ? row.homepage : undefined,
      icon: gh ? `https://github.com/${gh.owner}.png?size=80` : undefined,
      tags: (Array.isArray(row.tags) ? row.tags : []).filter((t) => typeof t === 'string').slice(0, 8),
      category: typeof row.category === 'string' && row.category ? row.category : undefined,
      version: typeof row.version === 'string' && row.version ? row.version : undefined,
      verified: row.verified === true || undefined,
      official: row.official === true || undefined,
      deprecated: row.deprecated === true || undefined,
      status: undefined,
      raw: row,
    });
  }
  return items;
}

/** Fetch one user-added source document. Validators travel with it (304 reuse). */
async function fetchCustomSource(def, opts = {}) {
  const doc = await fetchJson(def.url, { ...opts, accept: 'application/json' });
  return { items: mapCustomEntries(doc, def) };
}

/**
 * How much of each source a single *browse* reads, as `{ pages, items }`.
 *
 * `pages` bounds the upstream requests (the official registry and Docker are
 * paginated at 100 per page; the two awesome-lists are one README each).
 * `items` bounds how many rows of that source are kept.
 *
 * The two awesome-lists are read in full: together they hold ~5150 entries and
 * they are the reason a market built only on the official registry looks thin.
 * Reading them whole costs two requests, the same as reading a slice of them.
 */
const SOURCE_BROWSE_CAPS = {
  'official-registry': { pages: 8, items: 800 },   // 8 pages x 100 records, deduped to servers
  smithery: { pages: 1, items: 10 },               // the upstream listing caps at 10
  'docker-catalog': { pages: 3, items: 300 },
  // Three search requests (100 rows each) against a 10-per-minute anonymous
  // budget when there is no index yet; every query has tens of thousands of
  // hits, so that path is a slice by design and the three are ranked against
  // each other before the cut. With a local index the cap is the merge's, not
  // the request budget's: the index is filtered by the query *before* this cut,
  // so up to 800 of its rows may enter the listing without costing a request.
  'github-mcp': { pages: 3, items: 800 },
  'awesome-remote': { pages: 1, items: 1000 },
  'awesome-list': { pages: 1, items: 5000 },
};

/**
 * What a user-added source may contribute. One document, read whole: the user
 * pointed us at their own catalogue, so a slice of it would be a surprise. The
 * cap only bounds a runaway document (and the memory it would take).
 */
const CUSTOM_BROWSE_CAP = { pages: 1, items: 1000 };

/** Run one named source adapter, returning [id, items]. */
function runSource(id, { query = '', perSource = 100, customSources = [], ...opts } = {}) {
  const cap = SOURCE_BROWSE_CAPS[id] ?? (isCustomSourceId(id) ? CUSTOM_BROWSE_CAP : { pages: 1, items: perSource });
  if (isCustomSourceId(id)) {
    // A filter may name a source that was just removed; that is the same
    // "unknown source" answer the fixed ids give, not a crash.
    const def = (customSources ?? []).find((s) => s?.id === id);
    if (!def) return Promise.reject(new Error(`unknown catalog source: ${id}`));
    return fetchCustomSource(def, opts).then((r) => [id, r.items.slice(0, cap.items)]);
  }
  switch (id) {
    case 'official-registry':
      return fetchOfficialRegistry({ ...opts, query, limit: 100, pages: cap.pages, dedupe: true })
        .then((r) => [id, r.items.slice(0, cap.items)]);
    case 'smithery':
      return fetchSmithery({ ...opts, query }).then((r) => [id, r.items.slice(0, cap.items)]);
    case 'docker-catalog':
      // The third element is the source's own coverage note (see
      // `fetchDockerCatalog`): a partial list must say so on its own row.
      return fetchDockerCatalog({ ...opts, limit: cap.items, pages: cap.pages })
        .then((r) => [id, r.items, r.note ? { note: r.note } : undefined]);
    case 'github-mcp':
      // The third element carries what this source has to say about its own
      // coverage: an index-backed read reports the census's size and age (see
      // `githubIndexNote`), and the row count in the panel is only the slice of
      // it this listing took.
      return fetchGithubMcp({ ...opts, query, limit: cap.items, pages: cap.pages })
        .then((r) => [id, r.items, (r.note || r.index)
          ? {
            note: r.note,
            index: r.index,
            dataAt: r.dataAt,
            // "A census walk is building this" is an answer about *now*; it is
            // not a listing, so it must not be remembered as one.
            transient: r.walk !== undefined,
          }
          : undefined]);
    case 'awesome-remote':
      return fetchAwesomeRemote({ ...opts, limit: cap.items }).then((r) => [id, r.items]);
    case 'awesome-list':
      return fetchAwesomeList({ ...opts, limit: cap.items }).then((r) => [id, r.items]);
    case 'pulsemcp':
      return fetchPulseMcp(opts).then((r) => [id, r.items]);
    default: return Promise.reject(new Error(`unknown catalog source: ${id}`));
  }
}

function matchItem(item, query) {
  const q = query.toLowerCase();
  return (
    item.title?.toLowerCase().includes(q) ||
    item.description?.toLowerCase().includes(q) ||
    item.author?.toLowerCase().includes(q) ||
    // The install command is searchable too: "docker run mcp/fetch" should find
    // `fetch`, and an endpoint hostname should find its remote server.
    JSON.stringify(item.install ?? {}).toLowerCase().includes(q) ||
    (item.tags ?? []).some((t) => String(t).toLowerCase().includes(q))
  );
}

/**
 * Market relevance: installable first, then popularity, then provenance.
 *
 * Popularity is deliberately a weak signal (max 400 against 1000 for being
 * installable) because the two numbers that exist are NOT comparable: Smithery's
 * `useCount` counts launches on its platform, Docker's `pull_count` counts
 * lifetime image pulls, and the official registry publishes neither. A log10
 * scale keeps a 1.9M-pull image from flattening everything else, but it does
 * not make the two units the same unit — the card labels each one instead.
 */
function itemScore(item) {
  let score = 0;
  if (item.install) score += 1000;
  // A deprecated entry keeps its install plan but drops below every live one,
  // so it is still findable and installable (a user may need it) without being
  // offered first.
  if (item.deprecated) score -= 500;
  if (item.verified) score += 150;
  if (item.official) score += 80;
  if (typeof item.installs === 'number') score += Math.min(400, Math.log10(item.installs + 1) * 80);
  if (typeof item.stars === 'number') score += Math.min(400, Math.log10(item.stars + 1) * 80);
  if (item.source === 'official-registry') score += 30;
  if (item.source === 'smithery') score += 20;
  return score;
}

/**
 * Merge the same server seen through more than one catalog. GitHub repositories
 * are the reliable shared identity; anything without one stays keyed by id.
 * The surviving record is the highest scoring one (so an installable Smithery
 * row wins over the same repo's discovery-only awesome-list row).
 */
function mergeItems(collected) {
  const byKey = new Map();
  for (const item of collected) {
    const gh = parseGitHub(item.repository);
    const key = gh ? `repo:${gh.owner}/${gh.repo}`.toLowerCase() : `id:${item.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      // `tags` is copied, not shared: the merge below appends to it, and a
      // source's result may now be a cached array we must not write through.
      byKey.set(key, { ...item, tags: [...(item.tags ?? [])], sources: [item.source] });
      continue;
    }
    existing.sources = existing.sources.includes(item.source) ? existing.sources : [...existing.sources, item.source];
    if (itemScore(item) > itemScore(existing)) {
      const sources = existing.sources;
      Object.assign(existing, item, { sources, tags: [...(item.tags ?? [])] });
    } else {
      // keep the richer half of the pair
      if (!existing.icon && item.icon) existing.icon = item.icon;
      if (existing.stars === undefined && item.stars !== undefined) existing.stars = item.stars;
      if (existing.installs === undefined && item.installs !== undefined) {
        existing.installs = item.installs;
        // The unit travels with the number: a merged record must not describe
        // Docker pulls with Smithery's label.
        existing.installsLabel = item.installsLabel;
        existing.installsWindow = item.installsWindow;
      }
      if (!existing.version && item.version) existing.version = item.version;
      if (!existing.author && item.author) existing.author = item.author;
      if (!existing.description && item.description) existing.description = item.description;
      if (!existing.repository && item.repository) existing.repository = item.repository;
      if (!existing.status && item.status) existing.status = item.status;
      if (existing.deprecated === undefined && item.deprecated !== undefined) existing.deprecated = item.deprecated;
      if (!existing.statusMessage && item.statusMessage) existing.statusMessage = item.statusMessage;
      // A category from the community index survives a merge that promoted a
      // registry record as the winner, so filtering still finds the entry.
      if (!existing.category && item.category) existing.category = item.category;
      for (const tag of item.tags ?? []) if (!existing.tags.includes(tag)) existing.tags.push(tag);
    }
  }
  return [...byKey.values()];
}

/**
 * Browse the open MCP marketplaces without requiring a query: pulls one page
 * per source with a generous per-source cap, merges, dedupes and ranks the
 * result. This is what the settings page's "MCP 市场" tab lists on open, and
 * what `overall_mcp_catalog` returns for the agent.
 *
 * @param options.query - optional case-insensitive substring filter.
 * @param options.limit - maximum merged items returned (default 400).
 * @param options.perSource - per-source item cap (default: see SOURCE_BROWSE_CAPS).
 * @param options.source - optional single source id filter.
 * @param options.customSources - user-added sources (`{ id, label, url }`), from
 *   `lib/custom-sources.js`. They are browsed after the built-in five, and
 *   naming one that no longer exists is the same "unknown source" error.
 * @param options.fetchImpl - injectable fetch (tests).
 * @param options.cache - a `createCatalogCache()` instance. Omitted (the tests'
 *   case) every walk reaches upstream exactly as it always did.
 * @param options.force - ignore remembered source results and walk them again.
 *   Validators are still sent, so the walk usually costs a 304 rather than a body.
 * @returns { items, errors, counts, total, sources } where counts is kept per
 *   source before merge and `sources` records each source's age, cache state and
 *   304 count for the panel.
 */
export async function browseCatalog({ query = '', limit = 400, perSource = 100, source = '', customSources = [], cache, force = false, ...opts } = {}) {
  const ids = source ? [source] : [...CATALOG_SOURCES, ...(customSources ?? []).map((s) => s.id)];
  const settled = await Promise.allSettled(ids.map(async (id) => {
    // `perSource` is part of the key because it caps sources that have no
    // entry in SOURCE_BROWSE_CAPS; today's two callers both take the default.
    const key = `${id}|${query}|${perSource}`;
    // Inside the TTL the market does not ask at all: the freshness this buys is
    // spent deliberately (one walk per source per minute), not by accident.
    // `force` (the panel's 刷新) accepts nothing remembered, not even something
    // a second old — and still sends the validators, so it costs a 304.
    const hit = force ? undefined : cache?.sourceResult(key);
    if (hit !== undefined) return { items: hit.items, at: hit.at, cached: true, stale: false, notModified: 0, note: hit.note, index: hit.index, dataAt: hit.dataAt };
    const before = cache?.stats().notModified ?? 0;
    try {
      // `cache` travels with the walk: it is what puts the validators on the
      // requests the adapters make below. `customSources` too — it was
      // destructured out of `opts`, so it has to be handed back explicitly.
      const [, items, meta] = await runSource(id, { ...opts, query, perSource, cache, customSources });
      const at = Date.now();
      const notModified = (cache?.stats().notModified ?? 0) - before;
      // A source may answer "not yet" — the GitHub census says so while its
      // first walk is in flight, and that answer must not be remembered: the
      // next browse has to see the rows once they exist, not a cached empty
      // listing for the rest of the TTL.
      if (!meta?.transient) {
        cache?.storeSourceResult(key, { items, at, note: meta?.note, index: meta?.index, dataAt: meta?.dataAt });
      }
      return {
        items, at, cached: false, stale: false, notModified,
        note: meta?.note, index: meta?.index, dataAt: meta?.dataAt, transient: meta?.transient === true,
      };
    } catch (err) {
      // A source that fails while we still hold its last answer keeps its rows:
      // the listing degrades to "this source is behind", never to an empty
      // market. The error still travels, so the panel can say so.
      const fallback = cache?.sourceResult(key, { fresh: false });
      if (fallback === undefined) throw err;
      return {
        items: fallback.items,
        at: fallback.at,
        cached: true,
        stale: true,
        notModified: 0,
        note: fallback.note,
        index: fallback.index,
        dataAt: fallback.dataAt,
        error: String(err?.message ?? err),
      };
    }
  }));
  const errors = [];
  const counts = {};
  const sources = {};
  const collected = [];

  settled.forEach((result, i) => {
    const sourceId = ids[i];
    if (result.status === 'rejected') {
      const message = String(result.reason?.message ?? result.reason);
      errors.push({ source: sourceId, message });
      sources[sourceId] = { error: message };
      return;
    }
    const { items, at, cached, stale, notModified, error, note, index, dataAt } = result.value;
    counts[sourceId] = items.length;
    sources[sourceId] = {
      // A source reading a local index reports when its census was walked, not
      // when this listing read the file: the panel's timestamp is about the
      // data, and "just now" over a day-old census would be the wrong claim.
      at: new Date(dataAt ?? at).toISOString(),
      cached: cached === true,
      stale: stale === true,
      notModified,
      items: items.length,
    };
    // A source that only got part of its list says so on its own row: "100 条"
    // next to a source that has 245 is the kind of quiet half-truth this
    // plugin exists to avoid.
    if (note !== undefined) sources[sourceId].note = note;
    // For an index-backed source that is a structured fact rather than prose:
    // the panel shows the census size, its age and whether a walk is running.
    if (index !== undefined) sources[sourceId].index = index;
    if (error !== undefined) {
      sources[sourceId].error = error;
      errors.push({ source: sourceId, message: error, stale: true });
    }
    for (const item of items) {
      if (query && !matchItem(item, query)) continue;
      collected.push(item);
    }
  });

  const merged = mergeItems(collected);
  // Derive the functional group after the merge, so a merged record whose
  // winning half came from a registry still gets a group from the community
  // heading the merge preserved.
  for (const item of merged) {
    item.group = functionalGroupOf(item);
    // `inferred` marks a group we read out of the entry's own words (the two
    // registries publish no category), so the card never presents our guess as
    // the source's own heading.
    item.groupSource = groupSourceOf(item);
  }
  const items = orderItems(merged, source).slice(0, limit);
  return { items, errors, counts, total: merged.length, sources };
}

/**
 * Order the merged market listing.
 *
 * A single-source listing (or a keyword search) is simply ranked by relevance.
 * The combined "all markets" listing is interleaved round-robin per source
 * instead: the catalogs have very different sizes (the community index has
 * hundreds of rows, Smithery ten), so pure score ordering buries two of the
 * three catalogs entirely and the page stops showing what is actually on the
 * market. Within one source the relevance order is preserved.
 */
function orderItems(items, sourceFilter) {
  const byScore = (a, b) => itemScore(b) - itemScore(a) || a.title.localeCompare(b.title);
  if (sourceFilter) return items.slice().sort(byScore);

  const buckets = new Map();
  for (const item of items) {
    if (!buckets.has(item.source)) buckets.set(item.source, []);
    buckets.get(item.source).push(item);
  }
  const order = CATALOG_SOURCES.filter((id) => buckets.has(id));
  for (const id of buckets.keys()) if (!order.includes(id)) order.push(id);
  const queues = order.map((id) => buckets.get(id).sort(byScore));

  const out = [];
  for (let round = 0; out.length < items.length; round += 1) {
    let progressed = false;
    for (const queue of queues) {
      if (round < queue.length) { out.push(queue[round]); progressed = true; }
    }
    if (!progressed) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// GitHub star / author enrichment (used by the market cards, lazily)
// ---------------------------------------------------------------------------

/** Extract the distinct `owner/repo` pairs of a list of catalog items. */
export function githubReposOf(items, max = 40) {
  const out = [];
  const seen = new Set();
  for (const item of items ?? []) {
    const gh = parseGitHub(item?.repository);
    if (!gh) continue;
    const key = `${gh.owner}/${gh.repo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, owner: gh.owner, repo: gh.repo, url: item.repository });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Fetch GitHub stars/description for a bounded set of repositories. One request
 * per repo (the REST API has no batch endpoint), so callers keep the list short.
 *
 * Returns `{ [owner/repo]: stats, rateLimited }`. A repo that fails for any
 * reason is simply absent rather than fabricated, and once GitHub answers with
 * a rate-limit error the remaining repos are skipped and `rateLimited` is set,
 * so the caller stops spending its hour on guaranteed failures.
 */
export async function fetchRepoStats(repos, { fetchImpl = fetch } = {}) {
  const entries = await Promise.allSettled((repos ?? []).map(async ({ key, owner, repo, url }) => {
    const data = await fetchJson(`https://api.github.com/repos/${owner}/${repo}`, {
      timeoutMs: 12000,
      fetchImpl,
      accept: 'application/vnd.github+json',
    });
    return [key, {
      stars: typeof data.stargazers_count === 'number' ? data.stargazers_count : undefined,
      author: data.owner?.login ?? owner,
      avatar: data.owner?.avatar_url,
      description: clampText(data.description, 200) || undefined,
      homepage: data.homepage || url,
      topics: Array.isArray(data.topics) ? data.topics.slice(0, 6) : [],
      pushedAt: data.pushed_at,
      forks: typeof data.forks_count === 'number' ? data.forks_count : undefined,
      openIssues: typeof data.open_issues_count === 'number' ? data.open_issues_count : undefined,
      watchers: typeof data.subscribers_count === 'number' ? data.subscribers_count : undefined,
      language: data.language || undefined,
      license: data.license?.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? data.license.spdx_id : undefined,
      archived: data.archived === true || undefined,
      createdAt: data.created_at,
    }];
  }));
  const stats = {};
  let rateLimited = false;
  entries.forEach((r) => {
    if (r.status === 'fulfilled') stats[r.value[0]] = r.value[1];
    else if (isRateLimitError(r.reason)) rateLimited = true;
  });
  return { ...stats, rateLimited };
}

/** 403 with an empty/0 remaining header is GitHub's unauthenticated quota wall. */
function isRateLimitError(reason) {
  const message = String(reason?.message ?? reason ?? '');
  return /HTTP 403|HTTP 429|rate limit/i.test(message);
}

/** Build a registry entry from a catalog item's install plan (user-confirmed). */
export function catalogItemToEntry(item) {
  if (!item?.install) return null;
  const name = item.title.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'mcp';
  if (item.install.transport === 'stdio') {
    return {
      name,
      source: `catalog:${item.source}`,
      transport: 'stdio',
      command: item.install.command,
      args: item.install.args ?? [],
      env: {},
      enabled: true,
    };
  }
  if (item.install.transport === 'streamable-http') {
    return { name, source: `catalog:${item.source}`, transport: 'streamable-http', url: item.install.url, headers: {}, enabled: true };
  }
  return null; // unknown transport — needs manual wiring (repo link shown to user)
}
