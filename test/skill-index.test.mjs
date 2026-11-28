// test/skill-index.test.mjs — unit tests for lib/skill-index.js
//
// The walk is tested with an injected `fetch`, because its subject is *which
// request is made next, what a resume asks for, and what is kept when one fails*
// — not the HTTP details. Rows are asserted by id, since the id is the install
// contract the host resolves (a changed prefix is an install that 404s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFeaturedGithubSkills } from '../lib/skill-market.js';

import {
	GITHUB_WINDOW_MAX,
	MAX_RUN_REQUESTS,
	MAX_RUN_REQUESTS_FULL,
	SKILL_INDEX_MAX_ROWS,
	SKILL_INDEX_MAX_ROWS_FULL,
	SKILL_INDEX_VERSION,
	SLICES,
	WALK_SOURCES,
	emptyCursors,
	cursorsForWalk,
	limitsForModes,
	minStarsForWalk,
	mergeSkillRows,
	mergeTruncations,
	needsSkillWalk,
	normalizeCursors,
	normalizeModes,
	normalizeSkillIndexDocument,
	querySkillRows,
	readSkillIndexDocument,
	resolveSlices,
	sameWalkSelection,
	skillIndexDocumentOf,
	skillIndexFreshness,
	skillIndexSummary,
	walkSkillIndex,
} from '../lib/skill-index.js';

/** A response the module can read: JSON body, or a bare status with headers. */
function json(body, status = 200, headers = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

/** Route by URL substring; every request is recorded so order is assertable. */
function routedFetch(routes) {
	const calls = [];
	const impl = async (url, init = {}) => {
		const text = String(url);
		calls.push({ url: text, headers: init.headers ?? {} });
		for (const [needle, answer] of routes) {
			if (text.includes(needle)) return typeof answer === 'function' ? answer(text, init) : answer;
		}
		throw new Error(`unexpected request: ${text}`);
	};
	impl.calls = calls;
	return impl;
}

/** Page number out of a URL, whichever source asked. */
function pageOf(url) {
	const match = /[?&]page=(\d+)/.exec(url);
	return match ? Number(match[1]) : 0;
}

function skillhubRow(i) {
	return {
		slug: `hub-${i}`,
		name: `hub-${i}`,
		description_zh: `技能 ${i}`,
		downloads: 10_000 - i,
		stars: i,
		category: 'dev-programming',
		version: '1.0.0',
	};
}

function githubRow(i) {
	return {
		full_name: `owner-${i % 5}/skills-${i}`,
		name: `skills-${i}`,
		description: `skills repo ${i}`,
		html_url: `https://github.com/owner-${i % 5}/skills-${i}`,
		stargazers_count: 900 - i,
		pushed_at: '2026-10-01T00:00:00Z',
	};
}

function clawhubRow(i) {
	return {
		ownerHandle: `owner${i % 3}`,
		slug: `claw-${i}`,
		displayName: `claw ${i}`,
		summary: 'a clawhub skill',
		latestVersion: { version: '2.0.0' },
		stats: { downloads: 500 - i, stars: 10 },
	};
}

function range(count, start = 0) {
	return Array.from({ length: count }, (_, i) => start + i);
}

/** Slices shrunk for tests; pacing off so a walk is a handful of awaits. */
function fastSlices(over = {}) {
	return {
		skillhub: { target: 250, pageSize: 100, pacingMs: 0, maxPages: 10 },
		// Three pages of 100 is one full GitHub band; the descent narrows after it.
		github: { target: 3000, pageSize: 100, pacingMs: 0, pagesPerWindow: 3, minStars: 5, maxWindows: 6 },
		clawhub: { target: 60, pageSize: 20, pacingMs: 0, maxPages: 10 },
		...over,
	};
}

/** The three empty routes a walk needs, so a test only states what it varies. */
function emptyRoutes() {
	return [
		['skillhub.cn', () => json({ data: { skills: [], total: 0 } })],
		['api.github.com/search/repositories', () => json({ total_count: 0, items: [] })],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	];
}

test('SkillHub walks by page and stops at the slice budget', async () => {
	const pages = new Map([
		[1, json({ data: { skills: range(100, 0).map(skillhubRow), total: 209606 } })],
		[2, json({ data: { skills: range(100, 100).map(skillhubRow), total: 209606 } })],
		[3, json({ data: { skills: range(100, 200).map(skillhubRow), total: 209606 } })],
	]);
	const fetchImpl = routedFetch([
		['skillhub.cn', (url) => pages.get(pageOf(url)) ?? json({ data: { skills: [], total: 209606 } })],
		['api.github.com/search/repositories', () => json({ total_count: 0, items: [] })],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);

	const walk = await walkSkillIndex({
		fetch: fetchImpl,
		slices: fastSlices(),
		sleep: async () => {},
	});

	const asked = fetchImpl.calls.filter((call) => call.url.includes('skillhub.cn')).map((call) => pageOf(call.url));
	assert.deepEqual(asked, [1, 2, 3], 'the walk did not ask for consecutive pages');
	assert.equal(walk.cursors.skillhub.page, 3);
	assert.equal(walk.cursors.skillhub.total, 209606, 'the upstream total was not recorded');
	assert.equal(walk.cursors.skillhub.done, true, 'a slice that reached its budget is not done');
	assert.equal(walk.rows.filter((row) => row.source === 'skillhub').length, 300,
		'the slice budget is a row budget: it overshoots by at most one page');
	// The id is the install contract: this must be the same id the live source makes.
	assert.ok(walk.rows.some((row) => row.id === 'skillhub:hub-0'));
});

test('a resumed SkillHub slice asks for the next page, not page 1', async () => {
	// Page 3 carries the 50 new rows (ids 200-249) that bring the slice to its
	// 250 target, so the only page it may ask for is 3 — asking 1 again would
	// re-spend the budget on rows the file already has.
	const fetchImpl = routedFetch([
		['skillhub.cn', (url) => json({
			data: { skills: range(50, (pageOf(url) - 1) * 100).map(skillhubRow), total: 209606 },
		})],
		['api.github.com/search/repositories', () => json({ total_count: 0, items: [] })],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);

	const walk = await walkSkillIndex({
		fetch: fetchImpl,
		slices: fastSlices(),
		sleep: async () => {},
		previous: range(200, 0).map((i) => ({ id: `skillhub:hub-${i}`, source: 'skillhub' })),
		cursors: { skillhub: { page: 2, rows: 200, done: false, total: 209606 } },
	});

	assert.equal(pageOf(fetchImpl.calls[0].url), 3, 'a resumed walk re-asked a page it already had');
	assert.equal(walk.cursors.skillhub.page, 3);
	assert.equal(walk.cursors.skillhub.rows, 250);
});

test('rows already on disk count once towards the target, not twice', async () => {
	// The first real build counted "rows on disk + rows seen this run", so a
	// resumed slice that re-read 5,562 of its own ids thought it held 12,044 and
	// stopped a third short of its population. The union is the honest number.
	const previous = range(200, 0).map((i) => ({ id: `skillhub:hub-${i}`, source: 'skillhub', name: `hub-${i}` }));
	const fetchImpl = routedFetch([
		// Page 1 and 2 hand back rows the file already has; page 3 is new.
		['skillhub.cn', (url) => {
			const page = pageOf(url);
			const start = (page - 1) * 100;
			return json({ data: { skills: range(100, start).map(skillhubRow), total: 209606 } });
		}],
		['api.github.com/search/repositories', () => json({ total_count: 0, items: [] })],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);
	const slices = fastSlices({ skillhub: { target: 250, pageSize: 100, pacingMs: 0, maxPages: 10 } });

	const walk = await walkSkillIndex({ fetch: fetchImpl, slices, previous, sleep: async () => {} });

	assert.deepEqual(
		fetchImpl.calls.filter((call) => call.url.includes('skillhub.cn')).map((call) => pageOf(call.url)),
		[1, 2, 3],
		'a resumed slice stopped once its double-counted rows passed the target',
	);
	assert.equal(walk.cursors.skillhub.rows, 300, 'the held count must be the size of the union');
});

test('a slice keeps paging while its row target is unmet, even past target/pageSize pages', async () => {
	// Each page carries one row: the drifting listing this slice reads in
	// production behaves the same way at a smaller scale (100 pages of 100 items
	// produced 9,767 distinct rows on the first real build). A ceiling derived
	// from `target / pageSize` would have stopped at page 2 with 2 rows.
	const fetchImpl = routedFetch([
		['skillhub.cn', (url) => json({ data: { skills: [skillhubRow(pageOf(url))], total: 209606 } })],
		['api.github.com/search/repositories', () => json({ total_count: 0, items: [] })],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);
	const slices = fastSlices({ skillhub: { target: 200, pageSize: 100, pacingMs: 0, maxPages: 5 } });

	const walk = await walkSkillIndex({ fetch: fetchImpl, slices, sleep: async () => {} });

	assert.deepEqual(
		fetchImpl.calls.filter((call) => call.url.includes('skillhub.cn')).map((call) => pageOf(call.url)),
		[1, 2, 3, 4, 5],
		'a slice that gains one row per page stopped early at target/pageSize pages',
	);
	assert.equal(walk.cursors.skillhub.done, true);
	assert.equal(walk.rows.filter((row) => row.source === 'skillhub').length, 5);
	// Cut by the page ceiling with rows still owed is a truncation, not an end.
	const [truncation] = walk.truncations.filter((entry) => entry.source === 'skillhub');
	assert.ok(truncation, 'a slice cut by its own page ceiling must say so');
	assert.match(truncation.reason, /页数上限 5 页/);
});

test('GitHub descends through star bands instead of stopping at page 10', async () => {
	// A band is three pages of 100 here, so a total above 300 means "there are
	// more repositories under this one" and the walk must narrow the query.
	const seen = [];
	const fetchImpl = routedFetch([
		['skillhub.cn', () => json({ data: { skills: [], total: 0 } })],
		['api.github.com/search/repositories', (url) => {
			const decoded = decodeURIComponent(url);
			const band = /stars:5\.\./.test(decoded) ? 1 : 0;
			const page = pageOf(url);
			seen.push({ band, page });
			const base = band === 0 ? (page - 1) * 100 : 300 + (page - 1) * 100;
			return json({
				// First band holds more than one window's worth; the second fits.
				total_count: band === 0 ? 500 : 200,
				items: range(100, base).map(githubRow),
			});
		}],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);

	const walk = await walkSkillIndex({ fetch: fetchImpl, slices: fastSlices(), sleep: async () => {} });

	const github = seen;
	assert.equal(github.filter((call) => call.band === 0).length, 3, 'the first band was not read page by page');
	assert.deepEqual(github.filter((call) => call.band === 1).map((call) => call.page), [1, 2],
		'the descent did not restart at page 1 of the narrower band');
	// Page 3 of the first band ends at stars 601 (githubRow: 900 - i), so the
	// second band is `5..601` — inclusive, so a tie block is re-read, not skipped.
	assert.equal(walk.cursors.github.hi, 601);
	assert.equal(walk.cursors.github.done, true);
	assert.equal(walk.cursors.github.windows, 2);
	// The population is the first band's total, not the sum of what we read.
	assert.equal(walk.cursors.github.total, 500);
	assert.equal(walk.rows.filter((row) => row.source === 'github').length, 500);
	assert.equal(walk.truncations.filter((entry) => entry.source === 'github').length, 0);
});

test('a band that fits in one window ends the descent', async () => {
	const seen = [];
	const fetchImpl = routedFetch([
		['skillhub.cn', () => json({ data: { skills: [], total: 0 } })],
		['api.github.com/search/repositories', (url) => {
			const page = pageOf(url);
			seen.push(page);
			return json({ total_count: 150, items: range(page === 1 ? 100 : 50, (page - 1) * 100).map(githubRow) });
		}],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);

	const walk = await walkSkillIndex({ fetch: fetchImpl, slices: fastSlices(), sleep: async () => {} });

	assert.deepEqual(seen, [1, 2], 'a 150-row band is two pages, and then there is nothing left to narrow');
	assert.equal(walk.cursors.github.done, true);
	assert.equal(walk.cursors.github.hi, null, 'a complete band must not pretend it narrowed');
	assert.equal(walk.cursors.github.windows, 1);
	assert.equal(walk.rows.filter((row) => row.source === 'github').length, 150);
});

test('a floor band that overflows the window is reported, never silently cut', async () => {
	const fetchImpl = routedFetch([
		['skillhub.cn', () => json({ data: { skills: [], total: 0 } })],
		['api.github.com/search/repositories', (url) => json({
			total_count: 900,
			// Every row sits exactly on the floor, so no narrower query exists.
			items: range(100, (pageOf(url) - 1) * 100).map((i) => ({ ...githubRow(i), stargazers_count: 5 })),
		})],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);
	const slices = fastSlices({ github: { target: 3000, pageSize: 100, pacingMs: 0, pagesPerWindow: 2, minStars: 5, maxWindows: 6 } });

	const walk = await walkSkillIndex({ fetch: fetchImpl, slices, sleep: async () => {} });

	assert.equal(walk.cursors.github.done, true);
	const [truncation] = walk.truncations.filter((entry) => entry.source === 'github');
	assert.ok(truncation, 'an unreachable remainder must be named');
	assert.match(truncation.reason, /无法继续收窄/);
});

test('a tie block that fills a window makes the descent go below it, not round in circles', async () => {
	// The first band ends inside a 200-star block that is wider than a window, so
	// the inclusive band `5..200` starts with new rows but still ends at 200 and
	// can never narrow. The walk must notice (that is the stall measured on the
	// first real build) and step to `5..199`, naming what that cost.
	const fetchImpl = routedFetch([
		['skillhub.cn', () => json({ data: { skills: [], total: 0 } })],
		['api.github.com/search/repositories', (url) => {
			const decoded = decodeURIComponent(url);
			const page = pageOf(url);
			if (/stars:5\.\.199/.test(decoded)) {
				return json({ total_count: 150, items: range(50, (page - 1) * 50).map((i) => ({ ...githubRow(i + 900), stargazers_count: 100 })) });
			}
			if (/stars:5\.\.200/.test(decoded)) {
				// This band gains rows (they are new ids) but still bottoms out at 200.
				return json({ total_count: 5000, items: range(100, 200 + (page - 1) * 100).map((i) => ({ ...githubRow(i), stargazers_count: 200 })) });
			}
			// The unfiltered band: the top 100 rows sit above the block, the next
			// 100 are its beginning.
			return json({
				total_count: 5000,
				items: range(100, (page - 1) * 100).map((i) => ({ ...githubRow(i), stargazers_count: page === 1 ? 300 : 200 })),
			});
		}],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);
	const slices = fastSlices({ github: { target: 5000, pageSize: 100, pacingMs: 0, pagesPerWindow: 2, minStars: 5, maxWindows: 6 } });

	const walk = await walkSkillIndex({ fetch: fetchImpl, slices, sleep: async () => {} });

	assert.deepEqual(
		fetchImpl.calls.filter((call) => call.url.includes('api.github.com')).map((call) => pageOf(call.url)),
		[1, 2, 1, 2, 1, 2],
		'the tie band was re-read instead of stepping below it',
	);
	assert.equal(walk.cursors.github.hi, 199, 'the second descent was not strictly narrower');
	assert.equal(walk.cursors.github.done, true);
	// The band gained rows yet could not narrow, so the share of 200-star rows
	// below the cut is unreachable — and that is named rather than dropped.
	const ties = walk.truncations.filter((entry) => /stars:200/.test(entry.reason));
	assert.equal(ties.length, 1, 'an unreachable tie block must be reported once');
});

test('a resumed GitHub walk continues inside the band it was in', async () => {
	const seen = [];
	const fetchImpl = routedFetch([
		['skillhub.cn', () => json({ data: { skills: [], total: 0 } })],
		['api.github.com/search/repositories', (url) => {
			seen.push({ page: pageOf(url), narrow: /stars:5\.\.601/.test(decodeURIComponent(url)) });
			return json({ total_count: 300, items: range(100, (pageOf(url) - 1) * 100).map(githubRow) });
		}],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);

	const walk = await walkSkillIndex({
		fetch: fetchImpl,
		slices: fastSlices(),
		sleep: async () => {},
		// The rows the resumed slice already holds: page 3 hands back ids 200-299,
		// so the union is 200 and only this page's rows are new.
		previous: range(100, 100).map((i) => ({ id: `github:owner-${i % 5}/skills-${i}`, source: 'github' })),
		cursors: { github: { hi: 601, page: 2, rows: 100, windows: 1, done: false, total: 300 } },
	});

	assert.equal(seen[0].page, 3, 'a resumed band restarted instead of continuing');
	assert.equal(seen[0].narrow, true, 'the resumed walk went back to the unfiltered query');
	assert.equal(walk.cursors.github.windows, 1, 'resuming must not count the same band twice');
	assert.equal(walk.cursors.github.total, 300, 'the recorded population was lost on resume');
	assert.equal(walk.cursors.github.done, true);
	// Only the rows this run fetched are in `walk.rows`; the cursor counts what
	// the slice holds, which is the resumed 100 plus this page.
	assert.equal(walk.rows.filter((row) => row.source === 'github').length, 100);
	assert.equal(walk.cursors.github.rows, 200);
});

test('GitHub sends the resolved credential, and nothing when there is none', async () => {
	const withToken = routedFetch(emptyRoutes());
	await walkSkillIndex({ fetch: withToken, token: 'ghp_test', slices: fastSlices(), sleep: async () => {} });
	const authed = withToken.calls.find((call) => call.url.includes('api.github.com'));
	assert.equal(authed.headers.authorization, 'Bearer ghp_test');

	const anonymous = routedFetch(emptyRoutes());
	await walkSkillIndex({ fetch: anonymous, slices: fastSlices(), sleep: async () => {} });
	const bare = anonymous.calls.find((call) => call.url.includes('api.github.com'));
	assert.equal(bare.headers.authorization, undefined, 'an index walk must not invent a credential');
});

test('ClawHub follows nextCursor and stops when there is none', async () => {
	const cursors = [null, 'c2', 'c3'];
	const fetchImpl = routedFetch([
		['skillhub.cn', () => json({ data: { skills: [], total: 0 } })],
		['api.github.com/search/repositories', () => json({ total_count: 0, items: [] })],
		['clawhub.ai/api/v1/skills', (url) => {
			const at = /[?&]cursor=([^&]+)/.exec(url);
			const index = at ? cursors.indexOf(decodeURIComponent(at[1])) : 0;
			const next = index + 1 < cursors.length ? cursors[index + 1] : null;
			return json({ items: range(20, index * 20).map(clawhubRow), nextCursor: next });
		}],
	]);

	const walk = await walkSkillIndex({
		fetch: fetchImpl,
		slices: fastSlices(),
		sleep: async () => {},
	});

	assert.equal(fetchImpl.calls.filter((call) => call.url.includes('clawhub')).length, 3,
		'the cursor walk did not stop when the upstream ran out');
	assert.equal(walk.cursors.clawhub.cursor, null);
	assert.equal(walk.cursors.clawhub.done, true);
	assert.equal(walk.rows.filter((row) => row.source === 'clawhub').length, 60);
	assert.ok(walk.rows.some((row) => row.id === 'clawhub:owner0/claw-0'));
});

test('a spent request budget stops the walk and keeps its cursors', async () => {
	const fetchImpl = routedFetch([
		['skillhub.cn', () => json({ data: { skills: range(100, 0).map(skillhubRow), total: 209606 } })],
		['api.github.com/search/repositories', () => json({ total_count: 0, items: [] })],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);

	const walk = await walkSkillIndex({
		fetch: fetchImpl,
		slices: fastSlices(),
		maxRequests: 1,
		sleep: async () => {},
	});

	assert.equal(walk.requests, 1);
	assert.match(walk.partial, /请求预算用完/);
	assert.equal(walk.complete, false);
	assert.equal(walk.cursors.skillhub.page, 1, 'the page already read was not recorded for the next run');
	assert.equal(walk.rows.length, 100, 'rows already collected were thrown away');
});

test('a rate limit is reported as a wait, not as a broken source', async () => {
	const fetchImpl = routedFetch([
		['skillhub.cn', () => json({ error: 'slow down' }, 429, { 'retry-after': '30' })],
		['api.github.com/search/repositories', () => json({ total_count: 0, items: [] })],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);

	const walk = await walkSkillIndex({ fetch: fetchImpl, slices: fastSlices(), sleep: async () => {} });

	assert.match(walk.partial, /限流/);
	assert.match(walk.partial, /30 秒/);
	assert.equal(walk.cursors.skillhub.page, 0, 'a failed request advanced the cursor');
	assert.equal(walk.complete, false);
});

test('aborting between requests ends the walk with what it had', async () => {
	const controller = new AbortController();
	const fetchImpl = routedFetch([
		['skillhub.cn', () => {
			controller.abort();
			return json({ data: { skills: [skillhubRow(1)], total: 209606 } });
		}],
		['api.github.com/search/repositories', () => json({ total_count: 0, items: [] })],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);

	const walk = await walkSkillIndex({
		fetch: fetchImpl,
		slices: fastSlices(),
		sleep: async () => {},
		signal: controller.signal,
	});

	assert.equal(walk.partial, '已中止');
	assert.equal(walk.rows.length, 1);
	assert.equal(walk.cursors.skillhub.page, 1);
});

test('merge keeps firstSeen, refreshes what was seen, and drops what is gone', async () => {
	const at = '2026-10-29T00:00:00.000Z';
	const old = '2026-09-01T00:00:00.000Z';
	const previous = [
		// Seen yesterday, first seen long ago: the walk must refresh it and keep
		// the original firstSeen instead of resetting the row's age.
		{ id: 'skillhub:a', source: 'skillhub', name: 'a', downloads: 1, firstSeen: old, lastSeen: '2026-10-28T00:00:00.000Z' },
		// Last seen before the keep window: it is gone, and must be dropped.
		{ id: 'skillhub:gone', source: 'skillhub', name: 'gone', downloads: 2, firstSeen: old, lastSeen: old },
	];
	const fresh = [{ id: 'skillhub:a', source: 'skillhub', name: 'a', downloads: 9 }];
	const merged = mergeSkillRows(previous, fresh, {
		at,
		keepMs: 7 * 24 * 60 * 60 * 1000,
		now: () => Date.parse('2026-10-29T00:00:00.000Z'),
	});

	assert.equal(merged.length, 1, 'a row unseen past the keep window stayed in the index');
	assert.equal(merged[0].downloads, 9, 'the newer row did not win');
	assert.equal(merged[0].firstSeen, old, 'firstSeen was rewritten by the walk');
	assert.equal(merged[0].lastSeen, at);
});

test('merge orders by downloads and honours the row cap', async () => {
	const rows = [
		{ id: 'skillhub:low', source: 'skillhub', downloads: 1 },
		{ id: 'skillhub:high', source: 'skillhub', downloads: 100 },
	];
	const merged = mergeSkillRows([], rows, { maxRows: 1 });
	assert.deepEqual(merged.map((row) => row.id), ['skillhub:high']);
});

test('the document round-trips through disk, and damage is reported not repaired', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-index-'));
	const file = path.join(dir, 'skills-index.json');
	try {
		const missing = await readSkillIndexDocument(file, (f, enc) => fs.readFile(f, enc));
		assert.equal(missing.doc, null);
		assert.equal(missing.damaged, null);

		await fs.writeFile(file, '{ not json', 'utf8');
		const broken = await readSkillIndexDocument(file, (f, enc) => fs.readFile(f, enc));
		assert.equal(broken.doc, null);
		assert.ok(broken.damaged, 'a damaged file was not reported');

		const doc = skillIndexDocumentOf({
			at: '2026-10-29T00:00:00.000Z',
			complete: true,
			partial: null,
			requests: 7,
			cursors: { skillhub: { page: 100, done: true, rows: 10000, total: 209606 } },
			rows: [{ id: 'skillhub:a', source: 'skillhub', name: 'a' }],
		});
		await fs.writeFile(file, JSON.stringify(doc), 'utf8');
		const read = await readSkillIndexDocument(file, (f, enc) => fs.readFile(f, enc));
		assert.equal(read.damaged, null);
		assert.equal(read.doc.rows.length, 1);
		assert.equal(read.doc.cursors.skillhub.page, 100);
		assert.equal(read.doc.cursors.skillhub.total, 209606);
		assert.equal(read.doc.version, SKILL_INDEX_VERSION);
		assert.deepEqual(read.doc.cursors.github, emptyCursors().github, 'a missing cursor was not defaulted');
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test('a document only keeps rows of known sources, deduped by id', () => {
	const doc = normalizeSkillIndexDocument({
		rows: [
			{ id: 'skillhub:a', source: 'skillhub', name: 'a' },
			{ id: 'skillhub:a', source: 'skillhub', name: 'dupe' },
			{ id: 'nope:x', source: 'nope', name: 'x' },
			{ id: 'official:pdf', source: 'official', name: 'pdf' },
		],
	});
	assert.deepEqual(doc.rows.map((row) => row.id).sort(), ['official:pdf', 'skillhub:a']);
	assert.equal(WALK_SOURCES.includes('official'), false, 'official is live-only, never walked');
});

test('a search runs over the whole index and pages by offset', () => {
	const rows = [
		...range(30, 0).map((i) => ({ id: `skillhub:s${i}`, source: 'skillhub', name: `skill ${i}`, title: `skill ${i}`, summary: 'pdf tool', downloads: 100 - i })),
		...range(20, 0).map((i) => ({ id: `clawhub:c${i}`, source: 'clawhub', name: `claw ${i}`, title: `claw ${i}`, summary: 'pdf tool' })),
	];

	const all = querySkillRows(rows, { offset: 0, limit: 10 });
	assert.equal(all.matched, 50, 'the search did not see the whole index');
	assert.equal(all.items.length, 10, 'the page size was ignored');
	assert.equal(all.items[0].source, 'clawhub', 'the top ranks are reserved before paging');

	const third = querySkillRows(rows, { offset: 20, limit: 10 });
	assert.equal(third.items[0].id, 'skillhub:s0');
	assert.equal(third.matched, 50);

	const onlyClaw = querySkillRows(rows, { source: 'clawhub' });
	assert.equal(onlyClaw.matched, 20);

	const term = querySkillRows(rows, { query: 'PDF' });
	assert.equal(term.matched, 50, 'the query is not case-insensitive over name/summary');

	assert.equal(querySkillRows(rows, { query: 'nothing-here' }).matched, 0);
});

test('exact collection searches rank verified skills before popular mirrors and before paging', () => {
	const repo = 'obra/superpowers';
	const mirrors = range(22, 0).map(i => ({
		id: `github:mirror${i}/superpowers:`, source: 'github', name: `AAA Mirror ${i}`,
		summary: `Mirror of ${repo}`, stars: 1000 - i,
		install: { repo: `mirror${i}/superpowers`, dir: '' },
	}));
	const rows = withFeaturedGithubSkills(mirrors);
	for (const query of ['superpower', 'Superpowers', repo, `https://github.com/${repo}/`, `https://github.com/${repo}.git`, `https://github.com/${repo}/tree/main/skills`]) {
		const first = querySkillRows(rows, { query, limit: 15 });
		assert.equal(first.items.length, 15, query);
		assert.ok(first.items.every(item => item.collection === repo), query);
		assert.equal(first.matched, mirrors.length + 15, query);
		const next = querySkillRows(rows, { query, limit: 15, offset: 15 });
		assert.ok(next.items.every(item => item.collection !== repo), query);
	}
	for (const sort of ['popular', 'name']) {
		assert.equal(querySkillRows(rows, { query: repo, sort, limit: 1 }).items[0].id, mirrors[0].id);
	}
	assert.equal(querySkillRows(rows, { query: repo, source: 'clawhub' }).matched, 0);
	const development = querySkillRows(rows, { query: repo, category: 'dev' });
	assert.ok(development.items.length > 0);
	assert.ok(development.items.every(item => item.marketCategory === 'dev'));
});

test('the summary reports what is held per source, never as a population total', () => {
	const doc = {
		at: '2026-10-29T00:00:00.000Z',
		complete: true,
		rows: [
			{ id: 'skillhub:a', source: 'skillhub' },
			{ id: 'skillhub:b', source: 'skillhub' },
			{ id: 'github:o/r', source: 'github' },
		],
		cursors: {
			skillhub: { page: 1, done: false, rows: 2, total: 209606 },
			github: { page: 1, done: true, rows: 1, total: 38161 },
			clawhub: { page: 0, done: false, rows: 0 },
		},
	};
	const summary = skillIndexSummary(doc, { now: () => Date.parse('2026-10-29T01:00:00.000Z') });
	assert.equal(summary.rows, 3);
	assert.deepEqual(summary.counts, { skillhub: 2, github: 1 });
	assert.equal(summary.sources.find((row) => row.id === 'skillhub').rows, 2);
	assert.equal(summary.sources.find((row) => row.id === 'skillhub').total, 209606,
		'the upstream total and the held row count must stay separate facts');
	assert.equal(summary.sources.find((row) => row.id === 'clawhub').total, undefined,
		'ClawHub reports no total; the index must not invent one');
	assert.equal(skillIndexFreshness(doc, { now: () => Date.parse('2026-10-31T00:00:00.000Z') }).stale, true);
});

test('needsSkillWalk is true for nothing held, unfinished, or stale', () => {
	const fresh = {
		at: new Date().toISOString(),
		complete: true,
		rows: [{ id: 'skillhub:a', source: 'skillhub' }],
	};
	const now = () => Date.now();
	assert.equal(needsSkillWalk(null, { now }), true, 'no index must be walked');
	assert.equal(needsSkillWalk(fresh, { now }), false, 'a fresh, finished index was re-walked');
	assert.equal(needsSkillWalk(fresh, { force: true, now }), true, 'force must always walk');
	assert.equal(needsSkillWalk({ ...fresh, complete: false }, { now }), true,
		'an unfinished walk must be resumed');
	assert.equal(
		needsSkillWalk({ ...fresh, at: '2026-01-01T00:00:00.000Z' }, { now }),
		true,
		'a stale index must be walked again',
	);
});

test('cursors default for every source and survive a malformed file', () => {
	const cursors = normalizeCursors({ skillhub: { page: 'nope', done: 'yes' }, clawhub: null });
	assert.deepEqual(Object.keys(cursors).sort(), [...WALK_SOURCES].sort());
	assert.equal(cursors.skillhub.page, 0);
	assert.equal(cursors.skillhub.done, false, 'a non-boolean done was trusted');
	assert.equal(cursors.clawhub.cursor, null);
	assert.equal(cursors.github.done, false);
});

test('full mode widens only the chosen sources, and widens their caps', () => {
	// The default is the slice: 10k / 2k / 8.4k is what makes the market usable
	// in fifteen minutes, and nothing about it changes unless the user asks.
	assert.deepEqual(resolveSlices([]), SLICES);
	assert.equal(SLICES.github.minStars, 5, 'the slice floor drifted');
	// Asking for GitHub in full drops the floor and gives the descent room for
	// the whole theme (38,486 repositories measured, ~39 bands).
	const full = resolveSlices(['github']);
	assert.equal(full.github.minStars, 0);
	assert.ok(full.github.maxWindows >= 39, 'the full GitHub walk cannot reach its population');
	assert.equal(full.skillhub.target, SLICES.skillhub.target, 'a source that was not chosen changed');
	// A stale or hostile client cannot name a source that is not walked.
	assert.deepEqual(resolveSlices(['nope', 'official']), SLICES);
	assert.deepEqual(normalizeModes({ github: 'full', clawhub: 'full', skillhub: 'slice' }),
		{ skillhub: 'slice', clawhub: 'full', github: 'full' });
	assert.deepEqual(normalizeModes({ skillhub: 'FULL' }), { skillhub: 'slice', clawhub: 'slice', github: 'slice' });
	// The caps travel with the modes, so a caller cannot take the wide slices
	// and the narrow row cap together.
	assert.deepEqual(limitsForModes(normalizeModes({})), { maxRequests: MAX_RUN_REQUESTS, maxRows: SKILL_INDEX_MAX_ROWS });
	assert.deepEqual(limitsForModes(normalizeModes({ skillhub: 'full' })),
		{ maxRequests: MAX_RUN_REQUESTS_FULL, maxRows: SKILL_INDEX_MAX_ROWS_FULL });
});

test('the merge keeps what the mode allows — a full walk must not be trimmed to the slice cap', () => {
	// The host merges with `limitsForModes(...).maxRows`. Forgetting it once
	// meant a full walk was written back with 24,000 rows and `complete: true`:
	// the tail it spent fourteen minutes fetching was silently dropped, and the
	// file claimed the crawl had finished.
	const rows = range(SKILL_INDEX_MAX_ROWS + 1500).map((i) => ({
		id: `skillhub:s${i}`,
		source: 'skillhub',
		name: `s${i}`,
		title: `s${i}`,
		summary: '',
		downloads: 100000 - i,
	}));
	const sliced = mergeSkillRows([], rows, {});
	assert.equal(sliced.length, SKILL_INDEX_MAX_ROWS, 'the slice cap stopped trimming the file');
	const full = mergeSkillRows([], rows, { maxRows: SKILL_INDEX_MAX_ROWS_FULL });
	assert.equal(full.length, rows.length, 'a merge with the full cap lost rows the mode allows');
	assert.ok(full.length > SKILL_INDEX_MAX_ROWS, 'the full cap is not wider than the slice cap');
	// The population floor travels with the mode: 0 means "no star floor", and a
	// document that records it must not be normalised back to the slice's 5.
	assert.equal(normalizeSkillIndexDocument({ minStars: 0 }).minStars, 0,
		'a full GitHub walk would be relabelled as the ≥5-star slice');
});

test('a slice run never shrinks a file a full run filled', () => {
	// The cap bounds growth; it is not permission to delete rows already earned.
	// A 210k full crawl followed by a slice run used to be rewritten as 24k.
	const held = range(SKILL_INDEX_MAX_ROWS + 30_000).map((i) => ({
		id: `skillhub:s${i}`,
		source: 'skillhub',
		name: `s${i}`,
		title: `s${i}`,
		summary: '',
		downloads: 100000 - i,
		lastSeen: new Date().toISOString(),
	}));
	const kept = mergeSkillRows(held, [], { maxRows: SKILL_INDEX_MAX_ROWS });
	assert.equal(kept.length, held.length, 'a slice-capped merge threw away rows already on disk');
	// `maxRows` becomes max(cap, held): with more rows held than the slice cap
	// allows, a slice run may replace rows but must not grow the file — the mode
	// that earned them is what set the ceiling.
	const grown = mergeSkillRows(held, range(5000, held.length).map((i) => ({
		id: `skillhub:s${i}`, source: 'skillhub', name: `s${i}`, title: `s${i}`, summary: '', downloads: 1,
	})), { maxRows: SKILL_INDEX_MAX_ROWS });
	assert.equal(grown.length, held.length, 'a slice run grew a file it was not allowed to grow');
	// With nothing on disk the cap is a real ceiling.
	assert.equal(mergeSkillRows([], held, { maxRows: SKILL_INDEX_MAX_ROWS }).length, SKILL_INDEX_MAX_ROWS);
});

test('sameWalkSelection tells a repeat click from a changed one', () => {
	// A walk in flight cannot change its plan, so the route must be able to tell
	// "same selection, nothing to do" from "different selection, say so".
	assert.equal(sameWalkSelection({ skillhub: 'slice', clawhub: 'slice', github: 'full' }, ['github']), true);
	assert.equal(sameWalkSelection({ skillhub: 'slice', clawhub: 'slice', github: 'full' }, []), false);
	assert.equal(sameWalkSelection({ skillhub: 'slice', clawhub: 'slice', github: 'slice' }, ['github']), false);
	assert.equal(sameWalkSelection({ skillhub: 'full', clawhub: 'slice', github: 'full' }, ['github', 'skillhub']), true);
	// Unknown names cannot make a selection "different", or a stale client could
	// provoke a 409 for a walk that is doing exactly what was asked.
	assert.equal(sameWalkSelection({ skillhub: 'slice', clawhub: 'slice', github: 'slice' }, ['official', 'nope']), true);
});

test('the document says which sources are full, not just how many rows it has', () => {
	// "SkillHub 210k rows" and "SkillHub 10k of 210k" are the same number of
	// digits and opposite claims; the file has to carry the difference.
	const doc = normalizeSkillIndexDocument({ rows: [], modes: { github: 'full' } });
	assert.deepEqual(doc.modes, { skillhub: 'slice', clawhub: 'slice', github: 'full' });
	assert.deepEqual(skillIndexDocumentOf(doc).modes, doc.modes);
	const summary = skillIndexSummary(doc);
	assert.equal(summary.modes.github, 'full');
	assert.equal(summary.sources.find((row) => row.id === 'github').mode, 'full');
	assert.equal(summary.sources.find((row) => row.id === 'skillhub').mode, 'slice');
	// An old file without modes reads as slices, never as a full crawl.
	assert.ok(WALK_SOURCES.every((id) => normalizeSkillIndexDocument({}).modes[id] === 'slice'));
});

test('the shipped slices are the ones the plan promised', async () => {
	assert.equal(SLICES.skillhub.target, 10000);
	assert.equal(SLICES.skillhub.pageSize, 100, 'SkillHub 400s above 100 rows per page (measured)');
	// Its listing is sorted by a live number, so rows shift while it is paged:
	// two pages of 100 held 165 distinct rows when measured, which is why the
	// page ceiling is well above target/pageSize.
	assert.ok(SLICES.skillhub.maxPages > SLICES.skillhub.target / SLICES.skillhub.pageSize,
		'a live-sorted listing needs page headroom or the slice stops short of its target');
	// GitHub no longer has a row limit at all: it descends through star bands,
	// and one band must stay exactly at the search ceiling of 1000 results.
	assert.equal(SLICES.github.pagesPerWindow * SLICES.github.pageSize, GITHUB_WINDOW_MAX,
		'a band that asked for more than the search API returns would re-read page 10 forever');
	assert.ok(SLICES.github.target > GITHUB_WINDOW_MAX, 'the safety cap must admit more than one band');
	assert.equal(SLICES.github.minStars, 5, 'the floor is the population definition and must not drift silently');
	// Measured 2026-10-29: 8,387 repositories at >=5 stars, i.e. nine bands.
	const bandsNeeded = Math.ceil(8387 / GITHUB_WINDOW_MAX);
	assert.ok(SLICES.github.maxWindows >= bandsNeeded,
		`${SLICES.github.maxWindows} windows cannot reach the ${bandsNeeded} the floor needs`);
	assert.ok(SLICES.clawhub.target > 0, 'ClawHub needs a safety cap, not an open-ended walk');
	// A whole walk must stay a background job rather than an all-day crawl.
	assert.ok(MAX_RUN_REQUESTS <= 400, 'one run must not be able to spend an unbounded number of requests');
});

test('a snapshot taken one page past the window re-reads the band instead of finishing GitHub', async () => {
	// The 5-second snapshot can land between the last page of a band and the band
	// decision, leaving `page = pagesPerWindow + 1`. That used to mark the source
	// done: every remaining band went unread and nothing recorded a truncation.
	const asked = [];
	const fetchImpl = routedFetch([
		['skillhub.cn', () => json({ data: { skills: [], total: 0 } })],
		['api.github.com/search/repositories', (url) => {
			const page = pageOf(url);
			asked.push(page);
			return json({
				total_count: 500,
				items: range(100, (page - 1) * 100).map(githubRow),
			});
		}],
		['clawhub.ai/api/v1/skills', () => json({ items: [], nextCursor: null })],
	]);
	const cursors = {
		skillhub: { page: 0, done: true, rows: 0 },
		clawhub: { page: 0, done: true, rows: 0 },
		// pagesPerWindow is 3 in fastSlices(); 4 is the "one past the window" case.
		github: { page: 4, done: false, rows: 0, hi: null, windows: 0 },
	};

	const walk = await walkSkillIndex({ fetch: fetchImpl, cursors, slices: fastSlices(), sleep: async () => {} });

	assert.ok(asked.length > 0, 'the resumed walk never asked GitHub anything — it called the source finished');
	assert.ok(asked.includes(1), 'the band was not re-read from its top');
	// And it kept descending instead of calling the source finished after one
	// re-read band: the fixture's bands never fit, so it walks on until the window
	// budget stops it, which is recorded as a truncation.
	assert.ok(walk.cursors.github.windows >= 2, 'the descent stopped one band after resuming');
	assert.ok(walk.truncations.some((entry) => entry.source === 'github'),
		'nothing recorded why the descent stopped');
});

test('a run keeps truncations it did not re-walk, and drops the ones that are now finished', () => {
	// A run where every cursor is already `done` walks nothing. Replacing the list
	// with `[]` would erase "ClawHub stopped at the page ceiling" while the file
	// calls itself complete.
	const previous = [
		{ source: 'clawhub', reason: '页数上限 100 页，还没走到底' },
		{ source: 'github', reason: 'stars:7 的同星块超过窗口容量，这一档少收了若干行' },
	];
	const dangling = mergeTruncations(previous, [], { clawhub: { done: false }, github: { done: false } });
	assert.equal(dangling.length, 2, 'a no-op run erased admissions it never re-walked');

	// The source that was finally finished loses its old admission; a fresh one is
	// added once, even if it repeats a reason already on file.
	const settled = mergeTruncations(previous, [{ source: 'github', reason: previous[1].reason }],
		{ clawhub: { done: true }, github: { done: false } });
	assert.deepEqual(settled, [{ source: 'github', reason: previous[1].reason }]);
	assert.equal(mergeTruncations([], [], {}).length, 0);
});

test('a mode change resets only that source, and the headless runner shares the rule', () => {
  const done = { done: true, page: 103, rows: 10067 };
  const cursors = cursorsForWalk(
    { skillhub: done, clawhub: { done: true, page: 100 }, github: { done: true, page: 1, hi: 50 } },
    { skillhub: 'slice', clawhub: 'slice', github: 'slice' },
    { skillhub: 'full', clawhub: 'slice', github: 'slice' },
  );
  assert.equal(cursors.skillhub.done, false, 'the source that changed mode was not reset');
  assert.equal(cursors.skillhub.page, 0);
  assert.equal(cursors.skillhub.rows, 10067, 'the reset threw away the held count');
  assert.equal(cursors.clawhub.done, true, 'an untouched source was reset anyway');
  assert.equal(cursors.github.done, true, 'an untouched source was reset anyway');
  // Same modes twice: nothing moves.
  const same = cursorsForWalk(cursors, { skillhub: 'full', clawhub: 'slice', github: 'slice' }, { skillhub: 'full', clawhub: 'slice', github: 'slice' });
  assert.equal(same.skillhub.done, false, 'a resumed full walk must stay resumable');
  assert.equal(same.skillhub.page, 0);
});

test('the recorded GitHub floor follows the rows, and a slice run cannot raise it', () => {
  const slices = resolveSlices(['skillhub']);
  // A full GitHub walk records its own (absent) floor…
  assert.equal(minStarsForWalk({ previous: { minStars: 5 }, modes: { github: 'full' }, slices: resolveSlices(['github']) }), 0,
    'a full GitHub walk still recorded the slice floor');
  // …and a later slice-only run keeps it, rather than claiming the full rows are a >=5★ sample.
  assert.equal(minStarsForWalk({ previous: { minStars: 0 }, modes: { github: 'slice' }, slices }), 0,
    'a slice run raised the floor above the rows in the file');
  // A first run has no previous floor: the slice's own floor is the truth.
  assert.equal(minStarsForWalk({ previous: null, modes: { github: 'slice' }, slices }), slices.github.minStars);
});

test('a walk retires only the admissions of the sources it actually visited', () => {
	const previous = [{ source: 'github', reason: 'stars:7 的同星块超过窗口容量，这一档少收了若干行' }];
	// The cursor was inherited as done by an earlier run: nobody walked GitHub now,
	// so its admission still stands.
	const inherited = { github: { done: true }, skillhub: { done: true } };
	assert.deepEqual(mergeTruncations(previous, [], inherited, ['skillhub']), previous,
		'a SkillHub-only run dropped GitHub\'s admission');
	// A run that did walk it to its end retires it.
	assert.deepEqual(mergeTruncations(previous, [], inherited, ['skillhub', 'github']), []);
	// Without a visited list the old meaning stays: done is stale.
	assert.deepEqual(mergeTruncations(previous, [], inherited), []);
});

test('the walk reports which sources it visited', async () => {
	const fetchImpl = routedFetch([
		['skillhub.cn', () => json({ data: { skills: [], total: 209606 } })],
		['api.github.com/search/repositories', () => { throw new Error('github was done — it must not be asked again'); }],
		['clawhub.ai/api/v1/skills', () => { throw new Error('clawhub was done — it must not be asked again'); }],
	]);
	const walk = await walkSkillIndex({
		fetch: fetchImpl,
		slices: fastSlices(),
		sleep: async () => {},
		cursors: { clawhub: { done: true }, github: { done: true } },
	});
	assert.deepEqual(walk.walked, ['skillhub'], 'the walk named sources it never touched');
	const previous = [{ source: 'github', reason: 'stars:7 的同星块超过窗口容量，这一档少收了若干行' }];
	assert.deepEqual(mergeTruncations(previous, walk.truncations, walk.cursors, walk.walked), previous,
		'walking SkillHub erased GitHub\'s admission');
});


test('category and weighted popularity apply to the full set before paging', () => {
  const row = (id, source, name, summary, downloads = 0) => ({ id, source, name, summary, downloads });
  const rows = [
    row('hub', 'skillhub', 'PDF', 'PDF', 10000000),
    row('weather', 'clawhub', 'Weather', 'Get current weather forecasts (no API key required).'),
    row('code', 'github', 'TypeScript', 'development'),
    row('claw', 'clawhub', 'Zeta PDF', 'PDF', 99),
    row('repo', 'github', 'Alpha PDF', 'PDF', 10),
  ];
  const office = querySkillRows(rows, { category: 'office', limit: 2 });
  assert.deepEqual(office.items.map(x => x.id), ['claw', 'repo']);
  assert.deepEqual(office.categories, { office: 3, other: 1, dev: 1 });
  assert.equal(office.matched, 2);
  assert.equal(office.deferredSkillHub, 1);
  assert.equal(querySkillRows(rows, { category: 'office', limit: 2, offset: 2 }).offset, 0);
  assert.equal(querySkillRows(rows, { category: 'office', sort: 'popular', source: 'skillhub', limit: 1 }).items[0].id, 'hub');
  assert.equal(querySkillRows(rows, { category: 'office', sort: 'name', limit: 1 }).items[0].id, 'repo');
  for (const sort of ['default', 'popular']) {
    const search = querySkillRows(rows, { query: ' PDF ', category: 'office', sort, limit: 2 });
    assert.deepEqual(search.items.map(x => x.id), ['hub', 'claw']);
    assert.equal(search.matched, 3);
    assert.equal(search.deferredSkillHub, undefined);
    const next = querySkillRows(rows, { query: 'pdf', category: 'office', sort, limit: 2, offset: 2 });
    assert.deepEqual(next.items.map(x => x.id), ['repo']);
  }
  assert.equal(querySkillRows(rows, { category: 'dev', offset: 100 }).offset, 0);
});


test('default and explicit popularity discount only SkillHub, without changing displayed counts', () => {
  const row = (id, source, downloads, stars = 0) => ({ id, source, name: id, downloads, stars });
  const rows = [
    ...range(20, 0).map(i => row('front-' + i, 'clawhub', 1000 - i)),
    row('hub-top', 'skillhub', 400), row('hub-mid', 'skillhub', 250),
    row('claw', 'clawhub', 100), row('official', 'official', 95), row('github', 'github', 90),
    row('hub-stars', 'skillhub', 0, 100), row('github-stars', 'github', 0, 35),
  ];
  const expected = ['hub-top', 'claw', 'official', 'github', 'hub-mid', 'github-stars', 'hub-stars'];
  for (const sort of ['default', 'popular']) {
    const first = querySkillRows(rows, { sort });
    assert.equal(first.items.length, 20);
    assert.ok(first.items.every(item => item.source !== 'skillhub'));
    const second = querySkillRows(rows, { sort, offset: 20 });
    assert.deepEqual(second.items.map(item => item.id), expected);
    assert.equal(second.items[4].downloads, 250);
    assert.equal(second.items[6].stars, 100);
    const widePage = querySkillRows(rows, { sort, limit: 50 });
    assert.deepEqual(widePage.items.map(item => item.id), [...first.items.map(item => item.id), ...expected]);
  }
});


test('completed skill sampling starts a new generation instead of reusing a full old budget', async () => {
  const now = () => Date.parse('2026-11-09T00:00:00Z');
  const previous = [{ id: 'skillhub:demo', source: 'skillhub', name: 'demo', downloads: 1, lastSeen: '2026-11-01T00:00:00Z' }];
  const modes = normalizeModes({});
  const cursors = cursorsForWalk({ skillhub: { done: true, page: 1, rows: 1 } }, modes, modes, { restartCompleted: true, now });
  assert.equal(cursors.skillhub.done, false);
  const fetch = routedFetch([['api.skillhub.cn', () => json({ data: { total: 1, skills: [{ slug: 'demo', name: 'demo', downloads: 99 }] } })]]);
  const result = await walkSkillIndex({ cursors, previous, now, fetch, sleep: async () => {}, slices: {
    skillhub: { target: 1, pageSize: 1, pacingMs: 0, maxPages: 1 },
    clawhub: { target: 0, pageSize: 1, pacingMs: 0, maxPages: 1 },
    github: { target: 0, pageSize: 1, pacingMs: 0, maxPages: 1 },
  } });
  assert.equal(fetch.calls.length, 1);
  assert.equal(result.rows[0].downloads, 99);
  assert.equal(result.cursors.skillhub.sampleStartedAt, new Date(now()).toISOString());
});
