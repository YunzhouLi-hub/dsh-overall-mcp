// test/github-index.test.mjs — unit tests for lib/github-index.js
//
// The walk is tested with an injected `search`, not a fake fetch: this module's
// subject is *which windows it asks for, in what order, and what it does when
// one fills up* — the HTTP half (User-Agent, retry, accept) belongs to
// `searchGithubRepos` and is covered in test/catalog.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BASE_QUERIES,
  INDEX_VERSION,
  MIN_STARS,
  MIN_INTERVAL_MS,
  crawlGithubRepos,
  githubWindowQuery,
  indexDocumentOf,
  indexFreshness,
  indexSummary,
  mergeIndexRows,
  needsGithubCrawl,
  normalizeIndexDocument,
  readIndexDocument,
} from '../lib/github-index.js';

/**
 * A repository row as GitHub's search returns it. `stars` descends with the
 * index so a window's rows are ordered exactly like the real answer.
 */
function repo(i, { stars = 5000 - i, name = `repo-${i}`, archived = false } = {}) {
  return {
    full_name: `owner-${i % 7}/${name}`,
    name,
    owner: { login: `owner-${i % 7}` },
    description: `MCP server ${i}`,
    html_url: `https://github.com/owner-${i % 7}/${name}`,
    homepage: '',
    topics: ['mcp'],
    stargazers_count: stars,
    language: 'TypeScript',
    forks_count: 3,
    open_issues_count: 1,
    pushed_at: '2026-10-01T00:00:00Z',
    archived,
  };
}

/**
 * A search that answers windows from a table.
 *
 * `windows` maps the window's *query text* to a function (page) → rows, so a
 * test can say exactly what the second window must be asked and hand back a
 * deliberate overlap at the boundary.
 */
function searchFrom(windows, { totals = {} } = {}) {
  const calls = [];
  const search = async ({ query, page }) => {
    calls.push({ query, page });
    const handler = windows[query];
    assert.ok(handler, `unexpected query: ${query}`);
    const repos = handler(page) ?? [];
    const total = totals[query] ?? repos.length;
    return { repos, totalCount: total };
  };
  search.calls = calls;
  return search;
}

function pageOf(start, count, options = {}) {
  return Array.from({ length: count }, (_, i) => repo(start + i, options));
}

test('a filled-up window is narrowed by stars instead of asking for page 11', async () => {
  const base = BASE_QUERIES[0];
  const first = githubWindowQuery(base);
  // Window 1's rows run 5000 stars down to 4001, so 4001 is the boundary the
  // walk must narrow to — inclusive, because that row is the one it can still see.
  const second = githubWindowQuery(base, { hi: 4001 });
  const search = searchFrom(
    {
      // 1200 hits: the per-window ceiling is hiding 200 of them.
      [first]: (page) => (page <= 10 ? pageOf((page - 1) * 100, 100) : []),
      [second]: (page) => {
        if (page === 1) return [repo(999), ...pageOf(2000, 99, { stars: 3900 })];
        if (page === 2) return pageOf(2100, 100, { stars: 3800 });
        return pageOf(2200, 60, { stars: 3700 });
      },
    },
    { totals: { [first]: 1200, [second]: 260 } },
  );

  const walk = await crawlGithubRepos({ search, minIntervalMs: 0, bases: [base] });

  assert.equal(search.calls.length, 13, '10 pages of the first window, then 3 of the narrowed one');
  assert.deepEqual(search.calls.at(-1), { query: second, page: 3 });
  assert.equal(walk.requests, 13);
  assert.equal(walk.rows.length, 1259, 'the one overlapping boundary row is deduped, not duplicated');
  assert.equal(walk.complete, true);
  assert.equal(walk.partial, null);
  assert.deepEqual(walk.truncations, []);
  // Ranked by stars, and every row is a market row rather than a raw payload.
  assert.ok(walk.rows.every((row) => row.id.startsWith('github:')));
  assert.ok(walk.rows.every((row) => row.source === 'github-mcp'));
  assert.ok(walk.rows.every((row) => row.raw === undefined), 'indexed rows are trimmed');
  assert.equal(walk.rows[0].stars, 5000);
  assert.equal(walk.rows.at(-1).stars, 3700);
  assert.equal(walk.rows.at(-1).language, 'TypeScript');
});

test('a window that cannot be narrowed at the floor ends the walk with a reason', async () => {
  const base = BASE_QUERIES[0];
  const first = githubWindowQuery(base);
  // 1500 hits, all at exactly the floor: narrowing to `stars:100..100` would
  // return the same page forever.
  const search = searchFrom(
    { [first]: (page) => (page <= 10 ? pageOf((page - 1) * 100, 100, { stars: MIN_STARS }) : []) },
    { totals: { [first]: 1500 } },
  );

  const walk = await crawlGithubRepos({ search, minIntervalMs: 0, bases: [base] });

  assert.equal(search.calls.length, 10, 'the walk stops instead of re-asking the same window');
  assert.equal(walk.complete, false);
  assert.equal(walk.truncations.length, 1);
  assert.match(walk.truncations[0].reason, /超过 1000 个仓库/);
  assert.equal(walk.rows.length, 1000);
});

test('the request budget ends the walk and the reason says which budget', async () => {
  const base = BASE_QUERIES[0];
  const first = githubWindowQuery(base);
  const search = searchFrom(
    { [first]: (page) => pageOf((page - 1) * 100, 100) },
    { totals: { [first]: 3000 } },
  );

  const walk = await crawlGithubRepos({ search, minIntervalMs: 0, bases: [base], maxRequests: 3 });

  assert.equal(search.calls.length, 3);
  assert.equal(walk.requests, 3);
  assert.match(walk.partial, /请求预算用完（3 次）/);
  assert.equal(walk.complete, false);
  assert.equal(walk.rows.length, 300, 'what was collected before the budget ran out is kept');
});

test('requests are paced to the anonymous search quota', async () => {
  const base = BASE_QUERIES[0];
  const first = githubWindowQuery(base);
  const search = searchFrom(
    // 250 hits = 3 pages of 100/100/50, small enough to finish quickly.
    { [first]: (page) => pageOf((page - 1) * 100, page < 3 ? 100 : 50) },
    { totals: { [first]: 250 } },
  );
  const slept = [];
  await crawlGithubRepos({
    search,
    bases: [base],
    sleep: async (ms) => { slept.push(ms); },
  });

  assert.equal(search.calls.length, 3);
  assert.deepEqual(slept, [MIN_INTERVAL_MS, MIN_INTERVAL_MS], 'a wait between requests, none before the first');
  assert.ok(MIN_INTERVAL_MS >= 6000, '6s keeps an anonymous client inside 10 requests/minute');
});

test('every configured query is walked, and one failing query stops the walk honestly', async () => {
  const [nameQuery, topicQuery] = BASE_QUERIES;
  const firstWindow = (base) => githubWindowQuery(base);
  const search = searchFrom({
    [firstWindow(nameQuery)]: () => [repo(1)],
    [firstWindow(topicQuery)]: () => { throw new Error('HTTP 403'); },
  });

  const walk = await crawlGithubRepos({ search, minIntervalMs: 0 });

  assert.equal(search.calls.length, 2);
  assert.match(walk.partial, /第 2 次请求失败：HTTP 403/);
  assert.equal(walk.complete, false);
  assert.equal(walk.rows.length, 1, 'the query that answered keeps its rows');
});

test('a fresh walk folds into the old one: seen rows update, unseen rows age out', () => {
  const now = Date.UTC(2026, 9, 15);
  const day = 24 * 60 * 60 * 1000;
  const previous = [
    { id: 'github:a/one', stars: 10, firstSeen: new Date(now - 5 * day).toISOString(), lastSeen: new Date(now - day).toISOString() },
    { id: 'github:a/gone', stars: 9, firstSeen: new Date(now - 90 * day).toISOString(), lastSeen: new Date(now - 40 * day).toISOString() },
  ];
  const fresh = [
    { id: 'github:a/one', stars: 12, title: 'one' },
    { id: 'github:a/two', stars: 11, title: 'two' },
  ];

  const rows = mergeIndexRows(previous, fresh, { at: new Date(now).toISOString(), now: () => now });

  assert.deepEqual(rows.map((r) => r.id), ['github:a/one', 'github:a/two']);
  const one = rows.find((r) => r.id === 'github:a/one');
  assert.equal(one.stars, 12, 'the fresh facts win');
  assert.equal(one.firstSeen, previous[0].firstSeen, 'when we first saw it survives');
  assert.equal(one.lastSeen, new Date(now).toISOString());
  assert.equal(rows.some((r) => r.id === 'github:a/gone'), false, '40 days unseen is finally dropped');
});

test('the document round-trips through disk, and a damaged one is not kept', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'github-index-'));
  const file = path.join(dir, 'github-index.json');
  try {
    const doc = indexDocumentOf({
      at: '2026-10-15T00:00:00.000Z',
      rows: [{ id: 'github:a/one', stars: 5 }, { id: 'nope', stars: 1 }],
      queries: ['mcp in:name archived:false'],
      requests: 12,
      complete: true,
    });
    assert.equal(doc.version, INDEX_VERSION);
    assert.equal(doc.rows.length, 1, 'a row that is not a GitHub item is dropped, not repaired');
    await fs.writeFile(file, JSON.stringify(doc), 'utf8');

    const read = await readIndexDocument(file, fs.readFile);
    assert.equal(read.damaged, null);
    assert.equal(read.doc.rows.length, 1);
    assert.equal(read.doc.at, '2026-10-15T00:00:00.000Z');
    assert.equal(read.doc.complete, true);

    await fs.writeFile(file, '{ not json', 'utf8');
    const broken = await readIndexDocument(file, fs.readFile);
    assert.equal(broken.doc, null);
    assert.match(broken.damaged, /JSON/);

    // Absent and damaged are different answers: one is a first run.
    const missing = await readIndexDocument(path.join(dir, 'nope.json'), fs.readFile);
    assert.deepEqual(missing, { doc: null, damaged: null });

    // A parseable file with no rows is not an index either.
    await fs.writeFile(file, JSON.stringify({ version: 1, rows: [] }), 'utf8');
    assert.equal((await readIndexDocument(file, fs.readFile)).doc, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('normalizeIndexDocument fills in what a hand-edited file may omit', () => {
  const doc = normalizeIndexDocument({ rows: [{ id: 'github:a/one' }] });
  assert.equal(doc.minStars, MIN_STARS);
  assert.deepEqual(doc.queries, [...BASE_QUERIES]);
  assert.equal(doc.at, null);
  assert.equal(doc.complete, false);
});

test('the host walks again when the census is missing, old, or explicitly refreshed', () => {
  const now = Date.UTC(2026, 9, 15, 12);
  const hour = 3600_000;
  const clock = { now: () => now };
  const rows = [{ id: 'github:a/one' }];

  assert.equal(needsGithubCrawl(null, clock), true, 'no index at all');
  assert.equal(needsGithubCrawl({ rows: [] }, clock), true, 'an index with no rows is not a census');
  assert.equal(needsGithubCrawl({ rows, at: new Date(now - hour).toISOString() }, clock), false);
  assert.equal(
    needsGithubCrawl({ rows, at: new Date(now - 40 * hour).toISOString() }, clock), true,
    'stale',
  );
  assert.equal(needsGithubCrawl({ rows, at: new Date(now).toISOString() }, { ...clock, force: true }), true);
});

test('freshness is a fact about the census, and a document with no timestamp is stale', () => {  const at = Date.UTC(2026, 9, 15, 12);
  const clock = { now: () => at };
  const hour = 60 * 60 * 1000;
  const fresh = indexFreshness({ at: new Date(at - hour).toISOString() }, clock);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageMs, hour);

  const old = indexFreshness({ at: new Date(at - 30 * hour).toISOString() }, clock);
  assert.equal(old.stale, true);
  assert.equal(old.ageMs, 30 * hour);

  assert.deepEqual(indexFreshness({}, clock), { at: null, ageMs: null, stale: true });

  const summary = indexSummary(
    { at: new Date(at - hour).toISOString(), rows: [{ id: 'github:a/x' }], queries: ['q'], complete: false, partial: '预算用完', requests: 5 },
    clock,
  );
  assert.deepEqual(summary, {
    rows: 1, at: new Date(at - hour).toISOString(), ageMs: hour, stale: false,
    complete: false, partial: '预算用完', queries: 1, requests: 5,
  });
});
