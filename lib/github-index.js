/**
 * The local index of MCP servers that live on GitHub.
 *
 * The market's `github-mcp` source started as three live searches per browse:
 * cheap, always current, and structurally unable to be a *catalogue* — GitHub's
 * search API stops at 1000 results per query, so "everything worth having" was
 * never on the table. This module owns the other half: a census that is walked
 * slowly in the background, kept on disk, and read locally.
 *
 * Four decisions are deliberate:
 *
 *   - **Sliced by stars, not paged forever.** `page=11` does not exist: one
 *     query window holds at most 1000 rows. The walk therefore fixes a star
 *     floor (default 100) and, when a window fills up, asks the next window for
 *     `stars:<floor>..<lowest star seen>` — the boundary is inclusive and rows
 *     are deduped by full name, so the overlap costs at most one extra page and
 *     a tie block can never be skipped.
 *   - **Paced, because anonymous search is 10 requests per minute.** One
 *     refresh is ~18-40 requests, i.e. two to four minutes of waiting between
 *     them. That is a background job by nature, which is why nothing here is
 *     called on the browse path: the market reads what this module already has.
 *   - **Union, not replacement.** A repository missing from one walk is usually
 *     a partial walk, not a deleted project. Rows are kept with `lastSeen` and
 *     only dropped once they have been missing for `INDEX_KEEP_MS`.
 *   - **Derived data, so no quarantine.** `sources.json` and `registry.json`
 *     are user state — a damaged one is preserved and reported. This file can
 *     be rebuilt from upstream at any time, so a damaged one is simply ignored
 *     and re-walked.
 *
 * Rows are stored in the *catalogue item* shape (`lib/catalog.js`'s
 * `githubItemOf`) rather than as raw GitHub payloads: a listing that keeps 1758
 * repositories cannot keep 1758 copies of the search response, and the panel
 * wants exactly these fields.
 */

import { githubItemOf, searchGithubRepos } from './catalog.js';

export const INDEX_VERSION = 1;
export const INDEX_FILE = 'github-index.json';

/** The population this index is about: MCP repos people actually run. */
export const MIN_STARS = 100;

/** GitHub's search API: hard maximum, and the ceiling per query window. */
export const PER_PAGE = 100;
export const WINDOW_MAX = 1000;
export const WINDOW_PAGES_MAX = WINDOW_MAX / PER_PAGE;

/** Stop conditions for one refresh. Windows are the tie-block guard. */
export const MAX_WINDOWS = 8;
export const MAX_REQUESTS = 48;

/**
 * Anonymous search allows 10 requests per minute, counted per request rather
 * than per page. 6s sits exactly on that line; the extra 500ms is slack so a
 * retry elsewhere in the plugin cannot push a minute over the limit.
 */
export const MIN_INTERVAL_MS = 6500;

/** A row missing from this many milliseconds of walks is finally dropped. */
export const INDEX_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows kept at most, oldest `lastSeen` first out. ~10MB of JSON. */
export const INDEX_MAX_ROWS = 20000;

/** How long a completed census is trusted before a browse offers to redo it. */
export const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The two shapes this index is about. `mcp in:name` finds repositories named
 * for what they are; the topic query finds the ones named something else
 * (`TrendRadar`, `pal-mcp-server`'s neighbours) that tagged themselves.
 *
 * The topic query must also require `mcp` in the description. A bare
 * `topic:mcp-server stars:>=1000` was measured (2026-10-15) to return n8n
 * (207k stars), gemini-cli (107k) and worldmonitor (88k) first — products and
 * SDKs that merely mention or embed MCP. The star floor does not remove them;
 * it only removes the small fry. The live search path narrows for the same
 * reason, and a census whose head is n8n would put that noise at the top of
 * the market's GitHub source.
 */
export const BASE_QUERIES = [
  'mcp in:name archived:false',
  'topic:mcp-server mcp in:description archived:false',
];

/** One window's query text. `hi === null` means "from the floor upwards". */
export function githubWindowQuery(base, { minStars = MIN_STARS, hi = null } = {}) {
  return hi === null ? `${base} stars:>=${minStars}` : `${base} stars:${minStars}..${hi}`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function clampText(value, max = 500) {
  if (typeof value !== 'string') return value === undefined ? undefined : String(value);
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Walk GitHub search for one refresh.
 *
 * @param options.search - injectable `searchGithubRepos` (tests).
 * @param options.bases - query texts to walk, each with its own windows.
 * @param options.minStars - the star floor; also the population's definition.
 * @param options.maxRequests - total request budget for this refresh.
 * @param options.minIntervalMs - pacing between requests (anonymous quota).
 * @param options.sleep - injectable sleep (tests; the host passes an unref'd one).
 * @param options.onProgress - called after each request with `{requests, rows, query}`.
 * @param options.signal - abort between requests (plugin disposal).
 * @returns { rows, requests, at, complete, partial, truncations } where `rows`
 *   are fresh item-shaped rows and `partial` is null or a reason worth showing.
 */
export async function crawlGithubRepos({
  search = searchGithubRepos,
  bases = BASE_QUERIES,
  minStars = MIN_STARS,
  maxRequests = MAX_REQUESTS,
  minIntervalMs = MIN_INTERVAL_MS,
  maxWindows = MAX_WINDOWS,
  sleep = defaultSleep,
  onProgress,
  signal,
  now = Date.now,
} = {}) {
  const started = now();
  const byName = new Map();
  const truncations = [];
  let requests = 0;
  let partial = null;

  const exhausted = () => requests >= maxRequests;
  const aborted = () => signal?.aborted === true;

  /**
   * One search request, paced and counted. Pages of the same window are
   * separate requests, which is exactly how the upstream quota counts them.
   */
  const ask = async (query, page) => {
    if (requests > 0 && minIntervalMs > 0) await sleep(minIntervalMs);
    if (aborted()) {
      const err = new Error('github index walk aborted');
      err.code = 'aborted';
      throw err;
    }
    if (exhausted()) {
      const err = new Error(`github index request budget spent (${maxRequests})`);
      err.code = 'budget';
      throw err;
    }
    requests += 1;
    const answer = await search({ query, page, perPage: PER_PAGE });
    onProgress?.({ requests, rows: byName.size, query, page });
    return answer;
  };

  const keep = (repos, base, at) => {
    let added = 0;
    for (const repo of repos ?? []) {
      const fullName = String(repo?.full_name ?? '');
      if (!fullName || byName.has(fullName)) continue;
      const item = githubItemOf(repo, { includeRaw: false });
      if (!item) continue;
      byName.set(fullName, { ...item, query: base, lastSeen: at });
      added += 1;
    }
    return added;
  };

  for (const base of bases) {
    if (partial || aborted() || exhausted()) break;
    let hi = null;
    let windows = 0;
    while (windows < maxWindows) {
      windows += 1;
      const query = githubWindowQuery(base, { minStars, hi });
      let first;
      try {
        first = await ask(query, 1);
      } catch (err) {
        if (err?.code === 'aborted') return finish(byName, { partial: '已中止', requests, started, truncations, now });
        // A budget stop is a normal outcome of a pace-limited walk; anything
        // else (a rate limit that never lifted, a network fault) is reported as
        // this refresh's reason.
        partial = err?.code === 'budget'
          ? `请求预算用完（${maxRequests} 次），未走完`
          : `第 ${requests} 次请求失败：${String(err?.message ?? err)}`;
        return finish(byName, { partial, requests, started, truncations, now });
      }
      const total = Number(first?.totalCount ?? 0);
      const at = new Date(now()).toISOString();
      keep(first?.repos, base, at);

      const pages = Math.min(
        total > 0 ? Math.ceil(total / PER_PAGE) : 1,
        WINDOW_PAGES_MAX,
      );
      let reached = 1;
      for (let page = 2; page <= pages; page += 1) {
        let answer;
        try {
          answer = await ask(query, page);
        } catch (err) {
          if (err?.code === 'aborted') return finish(byName, { partial: '已中止', requests, started, truncations, now });
          partial = err?.code === 'budget'
            ? `请求预算用完（${maxRequests} 次），未走完`
            : `第 ${requests} 次请求失败：${String(err?.message ?? err)}`;
          return finish(byName, { partial, requests, started, truncations, now });
        }
        reached = page;
        keep(answer?.repos, base, at);
      }

      // The window is fully covered: this query is done.
      if (total <= WINDOW_MAX) break;

      // It filled up, so the 1000-row ceiling is hiding the rest of it. Narrow
      // by the lowest star seen; inclusive, so a tie block at that value is
      // re-asked rather than skipped.
      const window = [...byName.values()].filter((row) => row.query === base);
      const minSeen = window.reduce((min, row) => (typeof row.stars === 'number' && row.stars < min ? row.stars : min), Infinity);
      if (!(minSeen > minStars)) {
        // Every row in the window sits at the floor: narrowing cannot make
        // progress, so the remaining rows at that value are out of reach.
        truncations.push({ query: base, reason: `stars:${minStars} 处有超过 ${WINDOW_MAX} 个仓库，同一 Star 值无法继续收窄` });
        break;
      }
      if (reached < pages) {
        truncations.push({ query: base, reason: `窗口只取到第 ${reached} 页` });
      }
      hi = minSeen;
    }
    if (windows >= maxWindows) truncations.push({ query: base, reason: `窗口数上限 ${maxWindows}` });
  }

  return finish(byName, { partial, requests, started, truncations, now });
}

function finish(byName, { partial, requests, started, truncations, now }) {
  const rows = [...byName.values()].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  return {
    rows,
    requests,
    at: new Date(now()).toISOString(),
    tookMs: Math.max(0, now() - started),
    complete: !partial && truncations.length === 0,
    partial,
    truncations,
  };
}

/**
 * Fold a fresh walk into what the file already held.
 *
 * New rows win (they carry the current stars and description); rows this walk
 * did not see keep the `lastSeen` they had, and are dropped only once that is
 * older than `keepMs`. `firstSeen` is preserved so a row's age in the index is
 * a fact rather than a guess.
 */
export function mergeIndexRows(previous, fresh, { at = new Date().toISOString(), keepMs = INDEX_KEEP_MS, maxRows = INDEX_MAX_ROWS, now = Date.now } = {}) {
  const merged = new Map();
  const cutoff = now() - keepMs;
  for (const row of previous ?? []) {
    const name = String(row?.id ?? '');
    if (!name) continue;
    const seen = Date.parse(row.lastSeen ?? '') || 0;
    if (seen && seen < cutoff) continue;
    merged.set(name, row);
  }
  for (const row of fresh ?? []) {
    const name = String(row?.id ?? '');
    if (!name) continue;
    const held = merged.get(name);
    merged.set(name, { ...row, firstSeen: held?.firstSeen ?? row.firstSeen ?? at, lastSeen: at });
  }
  const rows = [...merged.values()].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  return rows.slice(0, maxRows);
}

/** Coerce whatever is on disk into rows this module can read. */
export function normalizeIndexDocument(raw) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : [];
  const clean = [];
  const seen = new Set();
  for (const row of rows) {
    const id = String(row?.id ?? '');
    if (!id.startsWith('github:') || seen.has(id)) continue;
    seen.add(id);
    clean.push({ ...row, id });
  }
  return {
    version: INDEX_VERSION,
    at: typeof raw?.at === 'string' ? raw.at : null,
    minStars: Number.isFinite(raw?.minStars) ? raw.minStars : MIN_STARS,
    queries: Array.isArray(raw?.queries) ? raw.queries.filter((q) => typeof q === 'string') : [...BASE_QUERIES],
    requests: Number.isFinite(raw?.requests) ? raw.requests : undefined,
    complete: raw?.complete === true,
    partial: typeof raw?.partial === 'string' ? raw.partial : null,
    rows: clean,
  };
}

/** The document as it is written to disk (and nothing else). */
export function indexDocumentOf(doc) {
  const normalized = normalizeIndexDocument(doc);
  return {
    version: INDEX_VERSION,
    at: normalized.at,
    minStars: normalized.minStars,
    queries: normalized.queries,
    requests: normalized.requests,
    complete: normalized.complete,
    partial: normalized.partial,
    rows: normalized.rows,
  };
}

/**
 * Read the file. A missing file is a first run (`doc: null`); a damaged one is
 * reported but not kept, because this document is derived and rebuilding it is
 * simply the next walk.
 */
export async function readIndexDocument(file, readFileImpl) {
  let raw;
  try {
    raw = await readFileImpl(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { doc: null, damaged: null };
    return { doc: null, damaged: String(err?.message ?? err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return { doc: null, damaged: 'JSON 顶层不是对象' };
    const doc = normalizeIndexDocument(parsed);
    return { doc: doc.rows.length ? doc : null, damaged: null };
  } catch (err) {
    return { doc: null, damaged: String(err?.message ?? err) };
  }
}

/** Rows older than the TTL are still usable, just visibly behind. */
export function indexFreshness(doc, { now = Date.now, ttlMs = INDEX_TTL_MS } = {}) {
  const at = typeof doc?.at === 'string' ? Date.parse(doc.at) : NaN;
  if (!Number.isFinite(at)) return { at: null, ageMs: null, stale: true };
  const ageMs = Math.max(0, now() - at);
  return { at: doc.at, ageMs, stale: ageMs > ttlMs };
}

/**
 * Whether the host should walk the census again.
 *
 * A missing index and an old one are the same answer here ("we do not hold a
 * current census"), while `force` is the panel's 刷新 button saying so out loud.
 * Kept as a named predicate because it is the *decision*, not the walk type:
 * it is what the host consults before spending minutes of someone's quota.
 */
export function needsGithubCrawl(doc, { force = false, ...freshness } = {}) {
  if (force) return true;
  if (!doc?.rows?.length) return true;
  return indexFreshness(doc, freshness).stale;
}

/** The one-line state the panel and the host both read. */export function indexSummary(doc, { now = Date.now, ttlMs = INDEX_TTL_MS } = {}) {
  const rows = doc?.rows?.length ?? 0;
  const { at, ageMs, stale } = indexFreshness(doc, { now, ttlMs });
  return {
    rows,
    at,
    ageMs,
    stale,
    complete: doc?.complete === true,
    partial: doc?.partial ?? null,
    queries: doc?.queries?.length ?? 0,
    requests: doc?.requests,
  };
}

/** "3 小时前" lives in `lib/catalog.js` (see `describeAge`), where the notes are written. */
