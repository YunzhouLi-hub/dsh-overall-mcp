// The skill market's local index.
//
// The market's four sources are live reads: one page each, opened when somebody
// looks. That is the right shape for "what is new", and the wrong shape for
// "what exists" — SkillHub reports 209k rows and ClawHub pages by cursor, so a
// listing can only ever show the first screen of each. This module owns the
// other half, the same way `lib/github-index.js` does for MCP servers: a walk
// that is paced, resumable, and kept on disk, so the panel can page through
// thousands of rows at zero request cost.
//
// Five decisions are deliberate:
//
//   - **Slices, not completeness.** SkillHub is asked for its 10,000 most
//     downloaded rows, GitHub for the 1,000 a repository search can reach, and
//     ClawHub for whatever its cursor yields up to a safety cap. None of those
//     is "the catalogue", so nothing here is ever reported as a population
//     total: `cursor.total` is what the upstream claimed, `rows` is what we
//     hold, and the panel keeps the two apart.
//   - **Resume from cursors, not from zero.** Each source carries its own page
//     number or cursor, written with every progress tick. A walk that is stopped
//     or killed resumes where it was; a slice that is finished is marked `done`
//     and skipped on the next run.
//   - **Paced per source, because the ceilings differ.** SkillHub has no
//     published quota (400ms between pages), ClawHub asks third-party
//     directories to be gentle (3s), GitHub's anonymous search allows ten
//     requests a minute (6.5s, shared with the census through `catalog.js`).
//   - **Union, not replacement.** A row missing from one walk is a partial walk,
//     not a deleted skill. Rows keep `firstSeen`/`lastSeen` and are only dropped
//     once unseen for `SKILL_INDEX_KEEP_MS`.
//   - **Derived data, so no quarantine.** Damaged file → report it, ignore it,
//     walk again. Nothing here is user state.
//
// The row shape is the market's own item shape (`lib/skill-market.js`), because
// the panel renders index rows and live rows with the same card and the install
// route resolves them by the same id. That is why the two mappers are borrowed
// from `_internal` rather than reimplemented: an id that differs by one character
// is an install that 404s.

import { USER_AGENT } from './catalog.js';
import { _internal } from './skill-market.js';
import { githubOwnerIcon } from './item-icons.js';

const { skillhubItem, clawhubItem } = _internal;

export const SKILL_INDEX_VERSION = 1;
export const SKILL_INDEX_FILE = 'skills-index.json';

/** How long a finished slice is trusted before a browse offers to redo it. */
export const SKILL_INDEX_TTL_MS = 24 * 60 * 60 * 1000;

/** A row unseen for this long is finally dropped. */
export const SKILL_INDEX_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows kept at most, regardless of how the slices add up. */
export const SKILL_INDEX_MAX_ROWS = 24000;

/**
 * The same cap for a full walk. SkillHub's own listing is 210,208 rows, so a
 * full build needs room for roughly 300k; anything above that is a runaway.
 */
export const SKILL_INDEX_MAX_ROWS_FULL = 400000;

/**
 * The sources this index walks, in walk order. `official` is 19 fixed
 * directories: live, always.
 *
 * GitHub is last on purpose. Its search budget is shared with the MCP census
 * and an empty window stops the walk, so putting the rate-limited source at the
 * end means a spent quota cannot starve SkillHub and ClawHub of the same run.
 */
export const WALK_SOURCES = ['skillhub', 'clawhub', 'github'];

/**
 * One slice per source: what to ask for, how fast, and when to stop.
 *
 * `target` is a row budget, not a promise about the upstream. `maxPages` is the
 * slice's own page ceiling so a walk cannot spend an hour before writing
 * anything.
 *
 * SkillHub's ceiling is 150 rather than the 100 a clean 100-rows-per-page read
 * would need, because its listing is sorted by a live number and therefore
 * moves while it is being paged: measured 2026-10-29, two consecutive pages of
 * 100 held only 165 distinct slugs (18 repeated across the boundary, the rest
 * duplicated inside a page). Ten thousand distinct rows therefore costs about
 * 120 requests, not 100 — with the drift seen, 150 pages is enough headroom and
 * the walk still stops as soon as the row target is met. `pageSize` cannot go
 * above 100: the API answers 400.
 */
export const SLICES = {
	skillhub: { target: 10000, pageSize: 100, pacingMs: 400, maxPages: 150 },
	// GitHub is not paged to a row limit any more: a search cannot pass 1000
	// results, so the slice descends through star bands instead (see
	// `walkGithubWindows`). `minStars` defines the population — measured
	// 2026-10-29, `topic:agent-skills` holds 38,486 repositories with no floor,
	// 20,503 at >=1, 8,387 at >=5, 2,521 at >=20 and 1,584 at >=50. Five is the
	// first floor that is a real long tail rather than a stub, and it costs
	// about nine windows; `target` stays as a safety cap above that population.
	github: {
		target: 12000,
		pageSize: 100,
		pacingMs: 6500,
		pagesPerWindow: 10,
		minStars: 5,
		// Nine bands cover the floor; the extra headroom is for tie blocks, where
		// the descent has to spend one band proving it cannot page past 1,000.
		maxWindows: 16,
	},
	// ClawHub publishes no total, so this is a safety cap rather than a slice of
	// a known population: 100 pages of 20 is where a background walk stops.
	clawhub: { target: 2000, pageSize: 20, pacingMs: 3000, maxPages: 100 },
};

/** Rows one query window can return, the reason the GitHub slice descends. */
export const GITHUB_WINDOW_MAX = 1000;

/**
 * The same three sources walked to their real end instead of to a slice.
 *
 * The user chooses this per source: the slice is what makes the market usable in
 * fifteen minutes, and a full walk is what makes it complete. The numbers are
 * the measured populations (2026-10-29) plus headroom, and the row caps are
 * safety nets rather than targets — a listing that is shorter than the cap just
 * ends (`done`), and one that is longer stops with a truncation.
 *
 * Sizes worth showing to the user before they pick: SkillHub's 210,208 rows are
 * about 200 MB of JSON, ClawHub has no total and paces at 3 s per 20 rows (a
 * full walk is hours, not minutes), and GitHub without a star floor is 38,486
 * repositories, i.e. about 39 windows and 4 minutes per window anonymously.
 */
export const FULL_SLICES = {
	skillhub: { target: 400000, pageSize: 100, pacingMs: 400, maxPages: 3000 },
	github: {
		target: 60000,
		pageSize: 100,
		pacingMs: 6500,
		pagesPerWindow: 10,
		// No floor: the population becomes every repository with the topic. The
		// descent then ends by proving the 0-star band is wider than a window,
		// which is reported like any other unreachable tie block.
		minStars: 0,
		maxWindows: 80,
	},
	clawhub: { target: 60000, pageSize: 20, pacingMs: 3000, maxPages: 3000 },
};

/** Total requests one run may spend across all sources, slice mode. */
export const MAX_RUN_REQUESTS = 400;
/**
 * The same ceiling for a full walk: SkillHub alone is 2,102 pages, GitHub ~390,
 * ClawHub unbounded. A run still resumes where it stopped, so this only decides
 * how much one background job may spend before giving the process back.
 */
export const MAX_RUN_REQUESTS_FULL = 3500;

/**
 * Slices for a walk where `full` names the sources the user wants in full.
 * Unknown names are ignored, so a stale client cannot widen the crawl.
 */
export function resolveSlices(full = []) {
	const wanted = new Set((Array.isArray(full) ? full : []).filter((id) => SLICES[id]));
	const slices = { ...SLICES };
	for (const id of wanted) slices[id] = { ...FULL_SLICES[id] };
	return slices;
}

/** The per-source mode recorded in the index: `full` only when asked for. */
export function normalizeModes(modes) {
	const out = {};
	for (const id of WALK_SOURCES) out[id] = modes?.[id] === 'full' ? 'full' : 'slice';
	return out;
}

/**
 * Whether a run for these modes needs the full caps. Kept next to the slices so
 * the host cannot pick one without the other.
 */
export function limitsForModes(modes) {
	const full = WALK_SOURCES.some((id) => modes?.[id] === 'full');
	return {
		maxRequests: full ? MAX_RUN_REQUESTS_FULL : MAX_RUN_REQUESTS,
		maxRows: full ? SKILL_INDEX_MAX_ROWS_FULL : SKILL_INDEX_MAX_ROWS,
	};
}

/**
 * Whether a start request asks for the selection a walk in flight is already
 * walking.
 *
 * A second 收录 click while a walk runs cannot change the run — the plan is fixed
 * when it starts — so the route has to say which case it is: the same selection
 * (nothing to do, answer quietly) or a different one (the click would be
 * silently dropped, answer 409 and let the panel say "stop it first").
 */
export function sameWalkSelection(modes, full) {
	const wanted = new Set((Array.isArray(full) ? full : []).filter((id) => WALK_SOURCES.includes(id)));
	for (const id of WALK_SOURCES) {
		if ((modes?.[id] === 'full') !== wanted.has(id)) return false;
	}
	return true;
}

/**
 * The truncation list a finished run should keep.
 *
 * The walk only knows what *this* run truncated; a run where every cursor was
 * already `done` walks nothing and would otherwise write `truncations: []`,
 * erasing admissions like "ClawHub stopped at the page ceiling" while the file
 * still calls itself complete. Keep an old entry until its source is either
 * truncated again or walked to completion.
 */
export function mergeTruncations(previous, fresh, cursors, walked = null) {
	const visited = Array.isArray(walked) ? new Set(walked.map(String)) : null;
	const kept = (Array.isArray(previous) ? previous : []).filter((entry) => {
		const source = String(entry?.source ?? '');
		if (!source) return false;
		// Not finished: the admission still stands.
		if (cursors?.[source]?.done !== true) return true;
		// "done" can be inherited from an earlier run. Only a walk that actually
		// visited this source may retire what it admitted — otherwise walking
		// SkillHub to its end would quietly drop GitHub's "six star bands were
		// wider than a window" from a file it never touched.
		if (visited === null) return false;
		return !visited.has(source);
	});
	const out = [];
	const seen = new Set();
	for (const entry of [...kept, ...(Array.isArray(fresh) ? fresh : [])]) {
		const source = String(entry?.source ?? '');
		const reason = String(entry?.reason ?? '');
		if (!source || !reason) continue;
		const key = `${source}\u0000${reason}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ source, reason });
	}
	return out;
}

const REQUEST_TIMEOUT_MS = 20000;

const SKILLHUB_LIST = 'https://api.skillhub.cn/api/skills';
const CLAWHUB_LIST = 'https://clawhub.ai/api/v1/skills';
const GITHUB_SEARCH = 'https://api.github.com/search/repositories';
/** The repository shape this index is about (same query the live source uses). */
export const GITHUB_QUERY = 'topic:agent-skills';

function clip(text, limit) {
	if (typeof text !== 'string') return '';
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function defaultSleep(ms) {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function abortError() {
	const err = new Error('skill index walk aborted');
	err.code = 'aborted';
	return err;
}

/* ------------------------------------------------------------------- rows */

/**
 * One GitHub repository as a market row.
 *
 * Deliberately identical to `lib/skill-market.js`'s token-less branch: same id,
 * same install recipe, so a row installed from the index is the same row the
 * live listing would have installed.
 */
function githubRepoItem(repo) {
	const fullName = typeof repo?.full_name === 'string' ? repo.full_name : '';
	if (!fullName) return null;
	const name = typeof repo.name === 'string' && repo.name ? repo.name : fullName.split('/').pop();
	return {
		id: `github:${fullName}`,
		source: 'github',
		name,
		title: fullName,
		icon: githubOwnerIcon(repo.owner?.login ?? fullName.split('/')[0]),
		summary: clip(repo.description || '', 200),
		stars: Number.isFinite(repo.stargazers_count) ? repo.stargazers_count : undefined,
		updatedAt: repo.pushed_at ? Date.parse(repo.pushed_at) : undefined,
		pageUrl: repo.html_url,
		installable: true,
		install: { kind: 'github-dir', repo: fullName, dir: '', ref: repo.default_branch },
		installNote: '没有 GitHub token 时只能按仓库找；安装会取仓库根目录的 SKILL.md',
	};
}

// Discount only the displayed ranking; collection and displayed counts stay raw.
const SKILLHUB_POPULARITY_WEIGHT = 0.3;
const SKILLHUB_FIRST_RANK = 21;
function compareRows(a, b, market = false) {
	const weightA = market && a?.source === 'skillhub' ? SKILLHUB_POPULARITY_WEIGHT : 1;
	const weightB = market && b?.source === 'skillhub' ? SKILLHUB_POPULARITY_WEIGHT : 1;
	const downloads = (Number(b?.downloads) || 0) * weightB - (Number(a?.downloads) || 0) * weightA;
	if (downloads !== 0) return downloads;
	const stars = (Number(b?.stars) || 0) * weightB - (Number(a?.stars) || 0) * weightA;
	if (stars !== 0) return stars;
	return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

/* ---------------------------------------------------------------- cursors */

/** Where each source stands. A finished slice is `done` and skipped. */
export function emptyCursors() {
	const cursors = {};
	for (const source of WALK_SOURCES) {
		cursors[source] = { page: 0, cursor: null, done: false, rows: 0, total: undefined, hi: null, windows: 0 };
	}
	return cursors;
}

function normalizeCursor(raw) {
	const held = raw && typeof raw === 'object' ? raw : {};
	// The key already names the source; a `source` field here would make this
	// shape disagree with `emptyCursors()` for no gain. `hi`/`windows` belong to
	// the GitHub descent: the band's star ceiling and how many bands were read.
	return {
        ...(typeof raw?.sampleStartedAt === 'string' && Number.isFinite(Date.parse(raw.sampleStartedAt)) ? { sampleStartedAt: raw.sampleStartedAt } : {}),
		page: Number.isFinite(held.page) && held.page > 0 ? Math.floor(held.page) : 0,
		cursor: typeof held.cursor === 'string' && held.cursor ? held.cursor : null,
		done: held.done === true,
		rows: Number.isFinite(held.rows) && held.rows > 0 ? Math.floor(held.rows) : 0,
		total: Number.isFinite(held.total) ? held.total : undefined,
		hi: Number.isFinite(held.hi) ? held.hi : null,
		windows: Number.isFinite(held.windows) && held.windows > 0 ? Math.floor(held.windows) : 0,
	};
}

/**
 * Cursors for a walk, given what the file already held.
 *
 * A source whose mode changed has to start over: a slice cursor that already
 * says `done` would otherwise be skipped, and GitHub's band descent would keep
 * the old floor. The selection is the whole desired state, so this is not a
 * diff. Living here means the host walk and the headless runner cannot drift.
 */
export function cursorsForWalk(previousCursors, previousModes, modes, { restartCompleted = false, now = Date.now } = {}) {
	const before = normalizeModes(previousModes);
	const cursors = normalizeCursors(previousCursors);
	for (const id of WALK_SOURCES) {
		if (modes?.[id] === before[id] && !(restartCompleted && cursors[id].done)) continue;
		cursors[id] = { ...cursors[id], done: false, page: 0, windows: 0, hi: null, cursor: null, sampleStartedAt: new Date(now()).toISOString() };
	}
	return cursors;
}

/**
 * The GitHub floor the rows in the file were actually walked under.
 *
 * A full GitHub walk has no floor, and its rows stay in the file when a later
 * run walks only the other two sources as slices. Recording that run's slice
 * floor (5) would claim the 38k full rows are a ≥5★ sample — so the floor may
 * only be lowered by a walk that really walked below it, never raised.
 */
export function minStarsForWalk({ previous, modes, slices } = {}) {
	const sliceFloor = slices?.github?.minStars ?? null;
	if (modes?.github === 'full') return sliceFloor ?? 0;
	const held = Number(previous?.minStars);
	if (!Number.isFinite(held)) return sliceFloor;
	return sliceFloor === null ? held : Math.min(held, sliceFloor);
}

export function normalizeCursors(raw) {
	const cursors = emptyCursors();
	for (const source of WALK_SOURCES) cursors[source] = normalizeCursor(raw?.[source]);
	return cursors;
}

/* ------------------------------------------------------------------- walk */

function reasonOf(err, { maxRequests, requests }) {
	if (err?.code === 'aborted') return '已中止';
	if (err?.code === 'quota') {
		const seconds = Number.isFinite(err.retryAfterMs) ? Math.ceil(err.retryAfterMs / 1000) : null;
		return seconds ? `上游限流（约 ${seconds} 秒后恢复），下次继续` : '上游限流，下次继续';
	}
	if (err?.code === 'budget') return `请求预算用完（${maxRequests} 次），下次继续`;
	return `第 ${requests} 次请求失败：${String(err?.message ?? err)}`;
}

/**
 * Walk the three sliced sources, resuming from `cursors`.
 *
 * @param options.fetch - injected fetch (tests); the host passes its
 *   `withGithubAuth` wrapper so the GitHub slice uses whatever credential the
 *   panel resolved.
 * @param options.cursors - where to resume (from the file, via `normalizeCursors`).
 * @param options.slices - per-source budget/pacing (tests shrink this).
 * @param options.maxRequests - total request budget for this run.
 * @param options.sleep - injected sleep; the host passes an abort-aware one so
 *   「停止」 does not wait out a 6.5s GitHub gap.
 * @param options.onProgress - called after every request with
 *   `{ requests, rows, source, page, cursors, items }`, where `items` is the live
 *   Map of rows collected so far (the host persists a snapshot mid-walk).
 * @param options.signal - abort between requests.
 * @returns { rows, cursors, requests, at, tookMs, complete, partial, truncations }
 */
export async function walkSkillIndex({
	fetch: fetchImpl = (...args) => globalThis.fetch(...args),
	token = null,
	cursors = {},
	// Rows already on disk. Needed because a resumed slice re-reads bands and
	// pages it already has: counting "baseline + this run" double-counts every
	// repeated id and makes a safety cap fire long before the slice is full.
	previous = [],
	slices = SLICES,
	maxRequests = MAX_RUN_REQUESTS,
	sleep = defaultSleep,
	signal = null,
	onProgress,
	now = Date.now,
} = {}) {
	const started = now();
	const state = normalizeCursors(cursors);
	const byId = new Map();
	const truncations = [];
	let requests = 0;
	let partial = null;

	const aborted = () => signal?.aborted === true;
	const baselineIds = {};
	for (const source of WALK_SOURCES) baselineIds[source] = new Set();
	for (const row of Array.isArray(previous) ? previous : []) {
		const id = String(row?.id ?? '');
		const source = String(row?.source ?? '');
		const ids = baselineIds[source];
		if (!id || !ids) continue;
        const generation = Date.parse(state[source]?.sampleStartedAt ?? '');
        if (Number.isFinite(generation) && !(Date.parse(row.lastSeen ?? '') >= generation)) continue;
		ids.add(id);
	}
	/**
	 * Rows held per source, as the union of what was already on disk and what
	 * this run collected. The target is a budget over the index, not over one
	 * run — otherwise resuming a half-done slice would collect another 10,000.
	 */
	const heldOf = (source) => {
		const ids = new Set(baselineIds[source]);
		for (const row of byId.values()) if (row.source === source) ids.add(row.id);
		return ids.size;
	};

	const keep = (source, items, at) => {
		for (const item of items ?? []) {
			if (!item?.id) continue;
			const held = byId.get(item.id);
			byId.set(item.id, { ...item, firstSeen: held?.firstSeen ?? at, lastSeen: at });
		}
	};

	const headersFor = (source) => {
		const headers = { 'user-agent': USER_AGENT };
		if (source === 'github') {
			headers.accept = 'application/vnd.github+json';
			if (token) headers.authorization = `Bearer ${token}`;
		}
		return headers;
	};

	/** One paced, budgeted request. Throws `{ code: 'quota' | 'budget' | 'aborted' }`. */
	const ask = async (source, url, pacingMs, firstOfSource) => {
		if (aborted()) throw abortError();
		if (requests >= maxRequests) {
			const err = new Error(`skill index request budget spent (${maxRequests})`);
			err.code = 'budget';
			throw err;
		}
		if (!firstOfSource && pacingMs > 0) await sleep(pacingMs);
		if (aborted()) throw abortError();
		requests += 1;
		const response = await fetchImpl(url, {
			headers: headersFor(source),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const status = Number(response?.status ?? 0);
		if (status === 429 || (status === 403 && Number(response?.headers?.get?.('x-ratelimit-remaining')) === 0)) {
			const retryAfter = Number(response?.headers?.get?.('retry-after'));
			const reset = Number(response?.headers?.get?.('x-ratelimit-reset'));
			const err = new Error(`${source} rate limited`);
			err.code = 'quota';
			err.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0
				? retryAfter * 1000
				: Number.isFinite(reset) && reset * 1000 > Date.now()
					? reset * 1000 - Date.now()
					: 60_000;
			throw err;
		}
		if (!response?.ok) {
			const text = await response?.text?.().catch(() => '') ?? '';
			throw new Error(`${source} returned ${status}: ${clip(text, 200) || 'no body'}`);
		}
		return response.json();
	};

	const tick = (source, page, at) => {
		onProgress?.({
			requests,
			rows: byId.size,
			source,
			page,
			cursors: JSON.parse(JSON.stringify(state)),
			items: byId,
			at,
		});
	};

	/**
	 * GitHub, one star band at a time.
	 *
	 * A repository search cannot page past 1000 results, so "every repository
	 * tagged agent-skills" is not one query — it is a descent through star bands:
	 * read the top 1000 of `stars:>=floor`, then `stars:floor..<lowest star seen>`,
	 * and repeat until a band fits inside one window or the floor itself
	 * overflows. `cursor.hi` is that moving upper bound, and it is persisted: a
	 * resumed walk continues inside the same band instead of starting the
	 * descent over. The boundary is inclusive so a tie block at `lowest` is
	 * re-read rather than skipped — duplicates cost one page, misses cost rows.
	 */
	async function walkGithubWindows(cursor, plan) {
		const windowMax = plan.pagesPerWindow * plan.pageSize;
		let firstOfSource = true;
		// Rows held when the current band started, so a band that adds nothing is
		// recognisable as a repeat instead of looking like slow progress.
		let bandStartRows = cursor.rows;
		while (!cursor.done) {
			const qualifier = cursor.hi === null
				? `stars:>=${plan.minStars}`
				: `stars:${plan.minStars}..${cursor.hi}`;
			const page = cursor.page + 1;
			if (page === 1) bandStartRows = cursor.rows;
			if (page > plan.pagesPerWindow) {
				// A snapshot can land after the last page of a band and before the
				// band decision below, leaving `page` one past the window. Re-read
				// that band from its top (duplicates collapse by id) instead of
				// calling the descent finished — finishing here lost every remaining
				// band and recorded no truncation.
				cursor.page = 0;
				continue;
			}
			let body;
			try {
				const query = `${GITHUB_QUERY} ${qualifier}`;
				const url = `${GITHUB_SEARCH}?q=${encodeURIComponent(query)}`
					+ `&sort=stars&order=desc&per_page=${plan.pageSize}&page=${page}`;
				body = await ask('github', url, plan.pacingMs, firstOfSource);
			} catch (err) {
				partial = reasonOf(err, { maxRequests, requests });
				return;
			}
			firstOfSource = false;

			const at = new Date(now()).toISOString();
			const raw = Array.isArray(body?.items) ? body.items : [];
			const total = Number(body?.total_count);
			// The population this slice is about is the first band's total: every
			// repository above the floor. Later bands are fractions of that number.
			if (Number.isFinite(total) && cursor.hi === null) cursor.total = total;
			cursor.page = page;
			if (page === 1) cursor.windows += 1;
			keep('github', raw.map(githubRepoItem).filter(Boolean), at);
			cursor.rows = heldOf('github');
			tick('github', cursor.page, at);

			if (raw.length === 0 || cursor.rows >= plan.target) {
				cursor.done = true;
				break;
			}

			const pagesInWindow = Math.min(
				plan.pagesPerWindow,
				Math.max(1, Math.ceil((Number.isFinite(total) ? total : windowMax) / plan.pageSize)),
			);
			if (page < pagesInWindow) continue;

			// The band is read to its end. If it fit in one window, the descent is
			// complete: every band above it was covered by an earlier iteration.
			if (Number.isFinite(total) && total <= windowMax) {
				cursor.done = true;
				break;
			}

			const lowest = raw.reduce((min, repo) => {
				const stars = Number(repo?.stargazers_count);
				return Number.isFinite(stars) && stars < min ? stars : min;
			}, Infinity);
			if (!Number.isFinite(lowest)) {
				cursor.done = true;
				break;
			}
			// How to narrow the next band.
			//
			// The default is inclusive (`stars:floor..lowest`): it re-reads the
			// boundary rows instead of skipping them, and collapsing them by id
			// costs nothing. That only works while it is genuinely narrower — and
			// when the 1,000th row sits inside a tie block bigger than a window, the
			// next band starts with the same rows and ends at the same value, so the
			// walk re-reads one band until its window budget runs out (measured on
			// the first real build: 44 requests that added 25 rows). A star value
			// cannot be paged past 1,000, so once a band proves it makes no progress
			// the walk descends *below* the value and says what that cost.
			const gained = cursor.rows - bandStartRows;
			const bandCeiling = cursor.hi;
			const repeatsBand = !(lowest < (bandCeiling ?? Infinity)) || gained === 0;
			const nextHi = repeatsBand ? lowest - 1 : lowest;
			if (nextHi < plan.minStars) {
				// More than a window's worth of repositories sit at the floor: no
				// narrower query exists, so the rest of that value is out of reach.
				truncations.push({
					source: 'github',
					reason: `stars:${plan.minStars} 一档就有超过 ${windowMax} 个仓库，同一 Star 值无法继续收窄`,
				});
				cursor.done = true;
				break;
			}
			if (cursor.windows >= plan.maxWindows) {
				truncations.push({ source: 'github', reason: `窗口数上限 ${plan.maxWindows}，停在 ${cursor.rows} 行` });
				cursor.done = true;
				break;
			}
			if (repeatsBand && gained > 0) {
				// New rows arrived yet the band cannot narrow: a tie block at
				// `lowest` is wider than what one query can page through. The share
				// below the 1,000-row cut is unreachable, and that is worth naming.
				// (`gained === 0` is a band that was already covered — nothing was
				// lost there, so it steps down silently.)
				truncations.push({
					source: 'github',
					reason: `stars:${lowest} 的同星块超过窗口容量，这一档少收了若干行`,
				});
			}
			cursor.hi = nextHi;
			cursor.page = 0;
		}
	}

	// Sources this run actually asked upstream about. A source whose cursor was
	// already "done" is skipped entirely — and that distinction is what keeps a
	// // SkillHub-only run from retiring GitHub's admission on its behalf.
	const walked = new Set();
	for (const source of WALK_SOURCES) {
		if (partial) break;
		const plan = slices?.[source] ?? SLICES[source];
		const cursor = state[source];
		if (cursor.done) continue;
		// A resumed slice counts the rows it already holds towards its target;
		// otherwise a resumed walk would ask for 10,000 *more*.
		cursor.rows = heldOf(source);
		if (cursor.rows >= plan.target) {
			cursor.done = true;
			continue;
		}
		walked.add(source);
		if (source === 'github') {
			await walkGithubWindows(cursor, plan);
			continue;
		}
		/**
		 * The slice's own page ceiling. It is a *total*, not a per-run limit:
		 * a per-run limit would stop at the cap and then, on resume, ask for
		 * `cap + 1` and stop again — a walk that can never make progress.
		 * The per-run bound is `maxRequests`, which is checked per request.
		 *
		 * It must not be tightened to `target / pageSize`: that assumes every
		 * request yields a full page of *new* rows, and SkillHub's drifting
		 * listing does not (100 pages produced 9,767 distinct rows on the first
		 * real build). The row target is checked separately, so a slice that
		 * reaches it stops there anyway.
		 */
		const pageCap = Math.max(1, plan.maxPages);
		let firstOfSource = true;
		let stop = false;

		while (!cursor.done && !stop) {
			const page = cursor.page + 1;
			if (page > pageCap) {
				cursor.done = true;
				break;
			}

			let body;
			try {
				if (source === 'skillhub') {
					const url = `${SKILLHUB_LIST}?page=${page}&pageSize=${plan.pageSize}&sortBy=downloads&order=desc`;
					body = await ask(source, url, plan.pacingMs, firstOfSource);
				} else {
					const params = new URLSearchParams({
						limit: String(plan.pageSize),
						sort: 'downloads',
						nonSuspiciousOnly: 'true',
					});
					if (cursor.cursor) params.set('cursor', cursor.cursor);
					body = await ask(source, `${CLAWHUB_LIST}?${params}`, plan.pacingMs, firstOfSource);
				}
			} catch (err) {
				partial = reasonOf(err, { maxRequests, requests });
				stop = true;
				break;
			}
			firstOfSource = false;

			const at = new Date(now()).toISOString();
			let empty = false;
			if (source === 'skillhub') {
				const raw = Array.isArray(body?.data?.skills) ? body.data.skills : [];
				const total = Number(body?.data?.total);
				if (Number.isFinite(total)) cursor.total = total;
				cursor.page = page;
				keep(source, raw.map(skillhubItem).filter((item) => item && item.name), at);
				empty = raw.length === 0;
			} else {
				const raw = Array.isArray(body?.items) ? body.items : Array.isArray(body?.results) ? body.results : [];
				cursor.page = page;
				cursor.cursor = typeof body?.nextCursor === 'string' && body.nextCursor ? body.nextCursor : null;
				keep(source, raw.map(clawhubItem).filter(Boolean), at);
				// No cursor means the upstream said "that is all of it", which is
				// the one stop that is not a budget at all.
				empty = raw.length === 0 || !cursor.cursor;
			}

			cursor.rows = heldOf(source);
			tick(source, cursor.page, at);

			if (empty) cursor.done = true;
			else if (cursor.rows >= plan.target) {
				// ClawHub publishes no total, so stopping at the safety cap means
				// there is probably more behind it. Say so instead of implying the
				// catalogue ended.
				if (source === 'clawhub' && cursor.cursor) {
					truncations.push({ source, reason: `安全上限 ${plan.target} 行，游标还没走完` });
				}
				cursor.done = true;
			} else if (page >= pageCap) {
				// The page ceiling, not the row budget. A slice whose rows arrive
				// slower than one per request (SkillHub's listing drifts, so pages
				// repeat) can reach this with rows still short of its target; a
				// slice cut by a ceiling must say so instead of looking finished.
				const moreRemains = source === 'clawhub'
					? Boolean(cursor.cursor)
					: Number.isFinite(cursor.total) ? page * plan.pageSize < cursor.total : true;
				if (moreRemains) truncations.push({ source, reason: `页数上限 ${pageCap} 页，还没走到底` });
				cursor.done = true;
			} else if (source === 'skillhub' && Number.isFinite(cursor.total) && page * plan.pageSize >= cursor.total) {
				// The listing shrank under us (or the slice is the whole listing).
				cursor.done = true;
			}
			if (cursor.done) break;
		}
	}

	return {
		rows: [...byId.values()].sort(compareRows),
		cursors: state,
		requests,
		at: new Date(now()).toISOString(),
		tookMs: Math.max(0, now() - started),
		// "Complete" means every source reached *its own* stop condition — the
		// slice budget, the upstream end, or the API ceiling. It never means "this
		// is the catalogue": `truncations` is where a source admits it stopped
		// before the end, and the panel repeats that instead of hiding it.
		complete: !partial && WALK_SOURCES.every((source) => state[source].done),
		partial,
		truncations,
		walked: [...walked],
	};
}

/* --------------------------------------------------------------- document */

/**
 * Fold a fresh walk into what the file already held.
 *
 * New rows win (they carry current downloads and descriptions); rows this walk
 * did not see keep the `lastSeen` they had and are dropped only once that is
 * older than `keepMs`. `firstSeen` is preserved, so "how long have we known this
 * one" stays a fact instead of becoming "when did we last walk".
 *
 * `maxRows` is a ceiling on growth, never a reason to shrink: the effective cap
 * is max(mode cap, rows already on disk). A full SkillHub crawl (210k rows)
 * followed by a slice run (cap 24,000) used to write those 210k rows back as
 * 24k — the file silently threw away everything the user had paid fourteen
 * minutes for. Stale pruning still shrinks the file; a mode that allowed the rows
 * keeps them, and only a mode with a wider cap may grow past them.
 */
export function mergeSkillRows(previous, fresh, {
	at = new Date().toISOString(),
	keepMs = SKILL_INDEX_KEEP_MS,
	maxRows = SKILL_INDEX_MAX_ROWS,
	now = Date.now,
} = {}) {
	const merged = new Map();
	const cutoff = now() - keepMs;
	const previousRows = Array.isArray(previous) ? previous.filter((row) => row?.id) : [];
	for (const row of previousRows) {
		const seen = Date.parse(row.lastSeen ?? '') || 0;
		if (seen && seen < cutoff) continue;
		merged.set(String(row.id), row);
	}
	for (const row of fresh ?? []) {
		const id = String(row?.id ?? '');
		if (!id) continue;
		const held = merged.get(id);
		merged.set(id, { ...row, firstSeen: held?.firstSeen ?? row.firstSeen ?? at, lastSeen: at });
	}
	// The ceiling may bound what a walk adds, but it must not delete rows that are
	// already held — those were earned under a mode that allowed them.
	const cap = Math.max(1, Number(maxRows) || 0, previousRows.length);
	return [...merged.values()].sort(compareRows).slice(0, cap);
}

/** Coerce whatever is on disk into a document this module can read. */
export function normalizeSkillIndexDocument(raw) {
	// One source of truth for "which sources exist": a source added to
	// WALK_SOURCES must not also need a fourth edit here, or its rows vanish
	// silently on the next read.
	const sources = new Set([...WALK_SOURCES, 'official']);
	const rows = [];
	const seen = new Set();
	for (const row of Array.isArray(raw?.rows) ? raw.rows : []) {
		const id = String(row?.id ?? '');
		if (!id || seen.has(id) || !sources.has(String(row?.source ?? ''))) continue;
		seen.add(id);
		rows.push({ ...row, id });
	}
	return {
		version: SKILL_INDEX_VERSION,
		at: typeof raw?.at === 'string' ? raw.at : null,
		complete: raw?.complete === true,
		partial: typeof raw?.partial === 'string' ? raw.partial : null,
		requests: Number.isFinite(raw?.requests) ? raw.requests : undefined,
		// The GitHub slice is "above this star floor", so the file has to say what
		// the floor was: a row count without it is not a population definition.
		minStars: Number.isFinite(raw?.minStars) ? raw.minStars : SLICES.github.minStars,
		// Which sources the user asked to walk to their end. Recorded because a
		// row count alone cannot say whether this file is a slice of SkillHub or
		// all of it, and the panel must be able to tell the two apart.
		modes: normalizeModes(raw?.modes),
		cursors: normalizeCursors(raw?.cursors),
		truncations: Array.isArray(raw?.truncations)
			? raw.truncations
				.filter((entry) => entry && typeof entry.reason === 'string')
				.map((entry) => ({ source: String(entry.source ?? ''), reason: entry.reason }))
			: [],
		rows: rows.sort(compareRows),
	};
}

/** The document as it is written to disk (and nothing else). */
export function skillIndexDocumentOf(doc) {
	const normalized = normalizeSkillIndexDocument(doc);
	return {
		version: SKILL_INDEX_VERSION,
		at: normalized.at,
		complete: normalized.complete,
		partial: normalized.partial,
		requests: normalized.requests,
		minStars: normalized.minStars,
		modes: normalized.modes,
		cursors: normalized.cursors,
		truncations: normalized.truncations,
		rows: normalized.rows,
	};
}

/**
 * Read the file. Missing is a first run; damaged is reported but not kept,
 * because rebuilding it is simply the next walk.
 */
export async function readSkillIndexDocument(file, readFileImpl) {
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
		const doc = normalizeSkillIndexDocument(parsed);
		return { doc: doc.rows.length ? doc : null, damaged: null };
	} catch (err) {
		return { doc: null, damaged: String(err?.message ?? err) };
	}
}

/** Rows older than the TTL are still usable, just visibly behind. */
export function skillIndexFreshness(doc, { now = Date.now, ttlMs = SKILL_INDEX_TTL_MS } = {}) {
	const at = typeof doc?.at === 'string' ? Date.parse(doc.at) : NaN;
	if (!Number.isFinite(at)) return { at: null, ageMs: null, stale: true };
	const ageMs = Math.max(0, now() - at);
	return { at: doc.at, ageMs, stale: ageMs > ttlMs };
}

/** Whether a walk is worth starting: nothing held, unfinished, or stale. */
export function needsSkillWalk(doc, { force = false, ...freshness } = {}) {
	if (force) return true;
	if (!doc?.rows?.length) return true;
	if (doc.complete !== true) return true;
	return skillIndexFreshness(doc, freshness).stale;
}

/** The one-line state the panel and `/status` both read. */
export function skillIndexSummary(doc, { now = Date.now, ttlMs = SKILL_INDEX_TTL_MS } = {}) {
	const rows = Array.isArray(doc?.rows) ? doc.rows : [];
	const counts = {};
	for (const row of rows) counts[row.source] = (counts[row.source] ?? 0) + 1;
	const { at, ageMs, stale } = skillIndexFreshness(doc, { now, ttlMs });
	const cursors = normalizeCursors(doc?.cursors);
	// Normalised once: it is read per source below and once for the file itself.
	const modes = normalizeModes(doc?.modes);
	return {
		rows: rows.length,
		counts,
		at,
		ageMs,
		stale,
		complete: doc?.complete === true,
		partial: doc?.partial ?? null,
		requests: doc?.requests,
		// The population definition for the GitHub slice: repositories at or above
		// this star count. Without it, "GitHub 8.4k" would read as "all of them".
		minStars: Number.isFinite(doc?.minStars) ? doc.minStars : SLICES.github.minStars,
		// Which sources were walked to their end rather than to a slice.
		modes,
		truncations: Array.isArray(doc?.truncations) ? doc.truncations : [],
		sources: WALK_SOURCES.map((source) => ({
			id: source,
			rows: counts[source] ?? 0,
			total: Number.isFinite(cursors[source].total) ? cursors[source].total : undefined,
			done: cursors[source].done,
			page: cursors[source].page,
			mode: modes[source],
			// Only the GitHub slice descends; how many bands it has read is the
			// one progress fact a page number cannot express.
			windows: cursors[source].windows,
		})),
	};
}

/**
 * One page of index rows, filtered on the whole index.
 *
 * This is the payoff of keeping the file: a search costs zero requests and sees
 * every row, instead of the first screen of each upstream. `matched` is the size
 * of the filtered set, so the pager knows how many pages exist.
 */
export const SKILL_MARKET_CATEGORIES = ['dev', 'search', 'office', 'content', 'data', 'knowledge', 'agent', 'other'];
const skillHubBuckets = new Map(Object.entries({
	'dev-programming': 'dev', 'it-ops-security': 'dev', 'ai-agent': 'agent',
	'office-efficiency': 'office', 'business-ops': 'office', professional: 'office',
	'content-creation': 'content', 'design-media': 'content', 'data-analysis': 'data',
	'knowledge-management': 'knowledge', education: 'knowledge', 'life-service': 'other',
}));
const bucketRules = [
	['search', /\b(?:search|web browser|browser automation|crawler|scraping|news|rss|research)\b|搜索|检索|爬虫/iu],
	['office', /\b(?:pdf|docx|xlsx|excel|spreadsheet|slides?|pptx|powerpoint|office|document|invoice)\b|办公|公文|表格|文档/iu],
	['content', /\b(?:image|video|audio|music|design|branding|writing|translate|subtitle|poster)\b|视频|音频|创作|翻译/iu],
	['data', /\b(?:data analysis|analytics|sql|database|charts?|metrics?|statistics|pandas|csv)\b|数据分析|数据库/iu],
	['knowledge', /\b(?:notes?|memory|knowledge|wiki|obsidian|notion|learning)\b|知识库|笔记/iu],
	['agent', /\b(?:agents?|automation|workflow|mcp|llm|prompts?|orchestration)\b|智能体|自动化/iu],
	['dev', /\b(?:code|coding|development|developer|git|github|typescript|python|rust|java|cli|debugging|deployment|docker|refactor|security)\b|编程|代码|开发|调试/iu],
];
const marketRowInfo = new WeakMap();
function infoFor(row) {
	let info = marketRowInfo.get(row);
	if (info) return info;
	const name = String(row.name ?? '').toLowerCase();
	const title = String(row.title ?? '').toLowerCase();
	const topics = Array.isArray(row.topics) ? row.topics.join(' ') : '';
	const category = row.source === 'skillhub' ? skillHubBuckets.get(String(row.category ?? '').toLowerCase()) : undefined;
	const classify = text => bucketRules.find(([, pattern]) => pattern.test(text))?.[0];
	info = {
		name, title, text: [name, title, row.summary, row.category, topics, row.owner, row.install?.owner, row.install?.repo].join(' ').toLowerCase(),
		category: category ?? classify(topics) ?? classify(name + ' ' + title) ?? classify(row.summary ?? '') ?? 'other',
	};
	marketRowInfo.set(row, info);
	return info;
}
const titleOrder = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export function querySkillRows(rows, { query = '', source = 'all', category = 'all', sort = 'default', offset = 0, limit = 20 } = {}) {
	const term = typeof query === 'string' ? query.trim().toLowerCase() : '';
	const wanted = source && source !== 'all' ? String(source) : null;
	const matches = [];
	const categories = {};
	for (const row of Array.isArray(rows) ? rows : []) {
		if (wanted && row.source !== wanted) continue;
		const info = infoFor(row);
		if (term && !info.text.includes(term)) continue;
		categories[info.category] = (categories[info.category] ?? 0) + 1;
		if (category !== 'all' && info.category !== category) continue;
		matches.push({ row, info });
	}
	matches.sort((a, b) => {
		if (sort === 'name') return titleOrder.compare(a.info.title || a.info.name, b.info.title || b.info.name) || a.row.id.localeCompare(b.row.id);
		return compareRows(a.row, b.row, true);
	});
	let ranked = matches;
	let deferredSkillHub = 0;
	if (!wanted && sort !== 'name') {
		// Reserve ranks, not page slots: changing the page size must not shift the boundary.
		const front = [];
		const rest = [];
		for (const match of matches) {
			if (front.length < SKILLHUB_FIRST_RANK - 1 && match.row.source !== 'skillhub') front.push(match);
			else rest.push(match);
		}
		if (front.length === SKILLHUB_FIRST_RANK - 1) ranked = front.concat(rest);
		else {
			// All remaining matches are SkillHub. A source-only view can still show them.
			ranked = front;
			deferredSkillHub = rest.length;
		}
	}
	const size = Math.min(Math.max(Math.floor(Number(limit) || 20), 1), 200);
	const requested = Math.floor(Math.max(0, Number(offset) || 0) / size) * size;
	const last = Math.floor(Math.max(0, ranked.length - 1) / size) * size;
	const start = Math.min(requested, last);
	return {
		items: ranked.slice(start, start + size).map(({ row, info }) => ({
			...row,
			marketCategory: info.category,
			icon: row.icon || (row.source === 'github' ? githubOwnerIcon(row.install?.repo?.split('/')[0]) : undefined),
		})),
		matched: ranked.length,
		...(deferredSkillHub ? { deferredSkillHub } : {}),
		categories,
		offset: start,
		limit: size,
	};
}
