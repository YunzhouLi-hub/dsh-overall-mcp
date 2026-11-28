// The skill market: several catalogues behind one list.
//
// Every provider below was checked against the live service before it was
// written down (see CHANGELOG 0.19.0 for the recorded responses):
//
//   clawhub  https://clawhub.ai/api/v1/{skills,search,download}  JSON + ZIP
//   official https://api.github.com/repos/anthropics/skills       19 skills
//   skillhub https://api.skillhub.cn (list + keyword search + zip download)
//   github   https://api.github.com/search/{repositories,code}
//
// Rules this file keeps:
//   * one dead provider must not blank the page — each returns its own error;
//   * nothing is invented: a field we did not receive stays undefined, and an
//     entry we cannot install says so instead of pretending;
//   * ClawHub asks third-party directories to cache, honour 429/Retry-After and
//     link back to the canonical listing, so every item carries `pageUrl`.

import nodeFs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readZipFiles } from './zip.js';
import { declaredEmoji, declaredIcon, githubOwnerIcon, publisherIcons } from './item-icons.js';
import { findSkillManifest, parseFrontmatter, skillSourcePage, SKILL_FILE, SKILL_ICON_METADATA } from './skills.js';
import { compareVersions, publishedVersion } from './updates.js';
import featuredCollections from './featured-skills.json' with { type: 'json' };

export const SKILL_LIVE_REPO_SOURCES = ['official'];
export const SKILL_MARKET_SOURCES = ['clawhub', ...SKILL_LIVE_REPO_SOURCES, 'skillhub', 'github'];

export const SKILL_MARKET_LABELS = {
	clawhub: 'ClawHub',
	official: 'anthropics',
	skillhub: 'SkillHub',
	github: 'GitHub',
};

// ClawHub publishes a 3000/min read budget and 1200/min for downloads. We ask
// for far less than that and keep a minute of cache, which is also what their
// reuse guidance asks for.
const CLAWHUB_BASE = 'https://clawhub.ai';
const CLAWHUB_TTL_MS = 60 * 1000;
const OFFICIAL_REPO = 'anthropics/skills';
const OFFICIAL_TTL_MS = 10 * 60 * 1000;
const SKILLHUB_BASE = 'https://api.skillhub.cn';
const SKILLHUB_TTL_MS = 10 * 60 * 1000;
const GITHUB_TTL_MS = 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_INSTALL_BYTES = 64 * 1024 * 1024;
const installing = new Set();

async function readDownload(response, maxBytes = MAX_INSTALL_BYTES) {
	const length = Number(response.headers?.get?.('content-length'));
	if (Number.isFinite(length) && length > maxBytes) {
		await response.body?.cancel();
		throw new Error(`download exceeds ${maxBytes} bytes`);
	}
	if (!response.body) return Buffer.alloc(0);
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new Error(`download exceeds ${maxBytes} bytes`);
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, size);
}

function nowMs() {
	return Date.now();
}

function filterByQuery(items, query, collection) {
	const term = typeof query === 'string' ? query.trim().toLowerCase() : '';
	if (!term) return items;
	return items.filter((item) =>
		(collection && item.collection === collection) ||
		`${item.id} ${item.install?.slug ?? ''} ${item.install?.repo ?? ''} ${item.owner ?? ''} ${item.name} ${item.title} ${item.summary} ${item.category ?? ''}`.toLowerCase().includes(term),
	);
}

function clip(text, limit) {
	if (typeof text !== 'string') return '';
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

const featuredRepos = new Map(featuredCollections.map(({ repo }) => [repo.toLowerCase(), repo]));
const featuredSearchAliases = new Map([['superpower', 'obra/superpowers']]);

export function skillMarketSearch(query) {
	const text = typeof query === 'string' ? query.trim() : '';
	const githubPath = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)(?=[/?#]|$)/i.exec(text)?.[1];
	const repo = parseRepoRef(githubPath ?? text);
	const normalized = repo?.repo ? `${repo.owner}/${repo.repo}` : text;
	const term = normalized.toLowerCase();
	const exact = featuredRepos.get(term) ?? featuredRepos.get(featuredSearchAliases.get(term));
	if (exact || term.includes('/') || term.length < 3) return { query: normalized, collection: exact };
	const names = [...featuredRepos].filter(([key]) => key.split('/')[1] === term);
	return { query: normalized, collection: names.length === 1 ? names[0][1] : undefined };
}

const featuredSkills = new Map(featuredCollections.flatMap(({ repo, root, ref, skills }) =>
	skills.map(({ name, title, description }) => {
		const dir = `${root}/${name}`;
		const id = `github:${repo}:${dir}`;
		const repository = `https://github.com/${repo}`;
		return [id, {
			id, source: 'github', name, title, summary: clip(description, 240),
			collection: repo, repository,
			icon: githubOwnerIcon(repo.split('/')[0]),
			pageUrl: `${repository}/tree/${ref}/${dir}`,
			installable: true,
			install: { kind: 'github-dir', repo, dir, ref },
		}];
	})));

export const FEATURED_GITHUB_SKILL_COUNT = featuredSkills.size;
export const featuredGithubSkill = id => featuredSkills.get(id);

export function withFeaturedGithubSkills(rows, query = '') {
	const discovered = rows.filter(row => {
		if (row.source !== 'github') return true;
		const repository = row.install?.repo;
		if (typeof repository !== 'string') return true;
		const repo = featuredRepos.get(repository.toLowerCase());
		if (!repo) return true;
		const dir = row.install.dir;
		// The repository row assumes a root SKILL.md, and code search can
		// return the same child as the verified collection.
		return dir !== '' && !featuredSkills.has(`github:${repo}:${dir}`);
	});
	const search = skillMarketSearch(query);
	return discovered.concat(filterByQuery([...featuredSkills.values()], search.query, search.collection));
}

async function fetchWithTimeout(url, { headers = {}, timeout = REQUEST_TIMEOUT_MS, fetchImpl = fetch } = {}) {
	const response = await fetchImpl(url, {
		headers: { 'user-agent': 'dsh-overall-mcp skill market', ...headers },
		signal: AbortSignal.timeout(timeout),
	});
	return response;
}

async function readJson(response, label) {
	const text = await response.text();
	if (!response.ok) {
		// ClawHub sends plain text errors; GitHub sends JSON. Either way the
		// first line is the only part worth putting in front of a person.
        const error = new Error(`${label} returned ${response.status}: ${clip(text, 200) || 'no body'}`);
        error.status = response.status;
        const remaining = response.headers?.get?.('x-ratelimit-remaining');
        error.rateLimited = response.status === 429 || (remaining != null && remaining !== '' && Number(remaining) === 0)
          || /API rate limit exceeded|secondary rate limit/i.test(text);
        const reset = Number(response.headers?.get?.('x-ratelimit-reset')) * 1000;
        const wait = Number(response.headers?.get?.('retry-after')) * 1000;
        if (reset > Date.now()) error.retryAt = reset;
        else if (wait > 0) error.retryAt = Date.now() + wait;
        throw error;
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${label} returned ${response.status} but not JSON: ${clip(text, 120)}`);
	}
}

/* ------------------------------------------------------------------ clawhub */

function clawhubItem(raw) {
	const owner = typeof raw.ownerHandle === 'string' ? raw.ownerHandle : '';
	const slug = typeof raw.slug === 'string' ? raw.slug : '';
	if (!slug) return null;
	const version = raw.latestVersion && typeof raw.latestVersion.version === 'string' ? raw.latestVersion.version : raw.version;
	const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
	return {
		id: `clawhub:${owner ? `${owner}/` : ''}${slug}`,
		source: 'clawhub',
		name: slug,
		icon: declaredIcon(raw),
		emoji: declaredEmoji(raw),
		title: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : slug,
		summary: clip(raw.summary ?? raw.description ?? '', 240),
		version: typeof version === 'string' ? version : undefined,
		updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined,
		downloads: Number.isFinite(stats.downloads) ? stats.downloads : undefined,
		stars: Number.isFinite(stats.stars) ? stats.stars : undefined,
		topics: Array.isArray(raw.topics) ? raw.topics.filter((t) => typeof t === 'string').slice(0, 6) : [],
		pageUrl: owner ? `https://clawhub.ai/${owner}/skills/${slug}` : undefined,
		installable: true,
		install: { kind: 'clawhub-zip', owner: owner || undefined, slug, version: typeof version === 'string' ? version : undefined },
		installNote: '安装时从 ClawHub 取官方分发的 ZIP',
	};
}

async function clawHubSkill({ slug, owner }, fetchImpl) {
	if (typeof slug !== 'string' || !slug || slug.length > 200) throw new Error('技能来源缺少有效标识');
	const url = `${CLAWHUB_BASE}/api/v1/skills/${encodeURIComponent(slug)}${owner ? `?ownerHandle=${encodeURIComponent(owner)}` : ''}`;
	const body = await readJson(await fetchWithTimeout(url, { fetchImpl, timeout: 8000 }), 'ClawHub skill');
	if (body?.skill?.slug !== slug) throw new Error('来源返回的技能标识不匹配');
	if (owner && (typeof body?.owner?.handle !== 'string' || body.owner.handle.toLowerCase() !== owner.toLowerCase())) {
		throw new Error('来源返回的技能发布者不匹配');
	}
	return body;
}

async function loadClawhub({ refresh = false, query, limit, state }) {
	const cached = state.clawhub;
	if (!refresh && cached && nowMs() - cached.at < CLAWHUB_TTL_MS && !cached.query && !query) return cached;
	let url;
	if (query) {
		url = `${CLAWHUB_BASE}/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`;
	} else {
		url = `${CLAWHUB_BASE}/api/v1/skills?limit=${limit}&sort=downloads&nonSuspiciousOnly=true`;
	}
	const body = await readJson(await fetchWithTimeout(url, { fetchImpl: state.fetch }), 'ClawHub');
	const raw = Array.isArray(body.items) ? body.items : Array.isArray(body.results) ? body.results : [];
	const items = raw.map(clawhubItem).filter(Boolean);
	const next = { at: nowMs(), query: query || '', items, total: Number.isFinite(body.total) ? body.total : undefined, nextCursor: body.nextCursor ?? null };
	if (!query) state.clawhub = next;
	return next;
}

async function clawhubFiles(item, state) {
	const target = item.install || {};
	const params = new URLSearchParams({ slug: target.slug });
	if (target.owner) params.set('ownerHandle', target.owner);
	if (target.version) params.set('version', target.version);
	const response = await fetchWithTimeout(`${CLAWHUB_BASE}/api/v1/download?${params}`, {
		timeout: 60000,
		fetchImpl: state.fetch,
	});
	const type = response.headers.get('content-type') || '';
	if (type.includes('application/json')) {
		// GitHub-backed ClawHub skills hand off instead of proxying bytes.
		const body = await readJson(response, 'ClawHub download');
		throw new Error(
			`这个技能托管在 GitHub，ClawHub 只给转交信息：${clip(body.repo || body.sourceRef || 'unknown', 80)}`,
		);
	}
	if (!response.ok) {
		throw new Error(`ClawHub download returned ${response.status}: ${clip(await response.text(), 200)}`);
	}
	const buffer = await readDownload(response);
	const { files, skipped, error } = readZipFiles(buffer);
	if (error) throw new Error(`archive unreadable: ${error}`);
	if (skipped.some((entry) => entry.reason !== 'filtered')) throw new Error(`archive contains refused entries: ${skipped.map((entry) => `${entry.name}: ${entry.reason}`).join('; ')}`);
	if (!files.some((file) => file.path === 'SKILL.md')) {
		throw new Error('archive has no SKILL.md at its root');
	}
	return { files, skipped };
}

/* ----------------------------------------------------------------- official */

async function githubJson(url, label, state) {
	const headers = { accept: 'application/vnd.github+json' };
	if (state.token) headers.authorization = `Bearer ${state.token}`;
	const response = await fetchWithTimeout(url, { headers, fetchImpl: state.fetch });
	return readJson(response, label);
}

async function loadOfficial({ refresh = false, state, query }) {
	// The cache holds the *whole* set, never an answer: returning it verbatim
	// ignored the query for ten minutes, so a search on the market tab listed all
	// nineteen anthropics skills and buried the rows that actually matched.
	const cached = state.official;
	if (!refresh && cached && nowMs() - cached.at < OFFICIAL_TTL_MS) {
		const cachedItems = Array.isArray(cached.items) ? cached.items : [];
		return {
			at: cached.at,
			items: query ? filterByQuery(cachedItems, query) : cachedItems,
			total: cachedItems.length,
			nextCursor: null,
		};
	}
	const listing = await githubJson(
		`https://api.github.com/repos/${OFFICIAL_REPO}/contents/skills`,
		'Official skills listing',
		state,
	);
	const dirs = listing.filter((entry) => entry.type === 'dir').map((entry) => entry.name);
	const items = [];
	for (const name of dirs) {
		let meta = {};
		try {
			const raw = await fetchWithTimeout(
				`https://raw.githubusercontent.com/${OFFICIAL_REPO}/main/skills/${name}/SKILL.md`,
				{ fetchImpl: state.fetch },
			);
			if (raw.ok) meta = parseFrontmatter(await raw.text());
		} catch {
			// A missing SKILL.md only costs this row its description.
		}
		items.push({
			id: `official:${name}`,
			source: 'official',
			name,
			icon: declaredIcon(meta) ?? declaredIcon(meta.metadata),
			emoji: declaredEmoji(meta),
			title: typeof meta.name === 'string' && meta.name ? meta.name : name,
			summary: clip(meta.description ?? '', 240),
			pageUrl: `https://github.com/${OFFICIAL_REPO}/tree/main/skills/${name}`,
			installable: true,
			install: { kind: 'github-dir', repo: OFFICIAL_REPO, dir: `skills/${name}`, ref: 'main' },
			installNote: '安装时从 anthropics/skills 取这个目录的文件',
		});
	}
	state.official = { at: nowMs(), items };
	// Same rule for the fresh path: the cache is the set, the answer is filtered.
	return {
		at: state.official.at,
		items: query ? filterByQuery(items, query) : items,
		total: items.length,
		nextCursor: null,
	};
}

/* ----------------------------------------------------------------- skillhub */

/**
 * One SkillHub row, as the API sends it.
 *
 * SkillHub keeps the Chinese description next to the English one; the panel is
 * Chinese, so prefer it and fall back only when it is empty.
 */
function skillhubItem(raw) {
	const slug = typeof raw?.slug === 'string' ? raw.slug : '';
	const name = typeof raw?.name === 'string' && raw.name ? raw.name : slug;
	const description = String(raw?.description_zh || raw?.description || '').trim();
	const updated = Number(raw?.updated_at);
	return {
		id: `skillhub:${slug}`,
		source: 'skillhub',
		name,
		icon: declaredIcon(raw),
		emoji: declaredEmoji(raw),
		title: name,
		summary: clip(description, 240),
		version: typeof raw?.version === 'string' ? raw.version : undefined,
		owner: typeof raw?.ownerName === 'string' ? raw.ownerName : undefined,
		downloads: raw?.downloads != null && raw.downloads !== '' && Number.isFinite(Number(raw.downloads)) ? Number(raw.downloads) : undefined,
		stars: raw?.stars != null && raw.stars !== '' && Number.isFinite(Number(raw.stars)) ? Number(raw.stars) : undefined,
		category: typeof raw?.category === 'string' ? raw.category : undefined,
		verified: raw?.verified === true,
		updatedAt: Number.isFinite(updated) && updated > 0 ? updated : undefined,
		pageUrl: skillSourcePage({ source: 'skillhub', pageUrl: raw?.homepage }),
		installable: Boolean(slug),
		install: slug ? { kind: 'skillhub-zip', slug, version: typeof raw?.version === 'string' ? raw.version : undefined } : undefined,
	};
}

/**
 * List or search SkillHub.
 *
 * One endpoint does both: `keyword` turns the listing into a search. It pages
 * by number (`page`/`pageSize`, at most 100 per page) and reports a real
 * `total`, unlike ClawHub's cursor.
 */
async function loadSkillhub({ refresh = false, state, query, limit }) {
	const cached = state.skillhub;
	if (!refresh && !String(query ?? '').trim() && cached && cached.limit >= limit && nowMs() - cached.at < SKILLHUB_TTL_MS) {
		return { at: cached.at, items: cached.items.slice(0, limit), total: cached.total, nextCursor: null };
	}
	const params = new URLSearchParams({
		page: '1',
		pageSize: String(Math.min(Math.max(limit, 1), 100)),
		sortBy: 'downloads',
		order: 'desc',
	});
	const needle = String(query ?? '').trim();
	if (needle) params.set('keyword', needle);
	const response = await fetchWithTimeout(`${SKILLHUB_BASE}/api/skills?${params}`, { fetchImpl: state.fetch });
	const body = await readJson(response, 'SkillHub');
	const rows = Array.isArray(body?.data?.skills) ? body.data.skills : [];
	const items = rows.map(skillhubItem).filter((item) => item.name);
	const total = Number(body?.data?.total);
	// Only the unfiltered listing is cached: a cached search answer would go
	// stale per keyword, and the keyword is what the user typed.
	if (!needle) state.skillhub = { at: nowMs(), items, total: Number.isFinite(total) ? total : items.length, limit };
	return { at: nowMs(), items: filterByQuery(items, needle), total: Number.isFinite(total) ? total : items.length, nextCursor: null };
}

/**
 * Drop the single wrapping folder some archives come with.
 *
 * `<slug>/SKILL.md` and `SKILL.md` both mean the same thing to us; installing
 * the first one verbatim would bury the skill one level too deep.
 */
function stripSingleRoot(files) {
	if (!files.length) return files;
	if (files.some((file) => file.path === 'SKILL.md')) return files;
	const tops = new Set(files.map((file) => file.path.split('/')[0]));
	if (tops.size !== 1) return files;
	const [top] = [...tops];
	if (!files.some((file) => file.path === `${top}/SKILL.md`)) return files;
	return files.map((file) => ({ ...file, path: file.path.slice(top.length + 1) }));
}

async function skillhubFiles(item, state) {
	const install = item.install ?? {};
	const slug = install.slug || item.name;
	const response = await fetchWithTimeout(`${SKILLHUB_BASE}/api/v1/download?slug=${encodeURIComponent(slug)}`, {
		timeout: 60000,
		fetchImpl: state.fetch,
	});
	if (!response.ok) {
		const text = clip(await response.text().catch(() => ''), 200);
		throw new Error(`SkillHub download returned ${response.status}: ${text}`);
	}
	const bytes = await readDownload(response);
	// A missing slug still answers 200 with a zip-shaped body on this host, so
	// the archive has to prove itself: a skill is a directory with SKILL.md.
	const unpacked = readZipFiles(bytes);
	if (unpacked.error) throw new Error(`SkillHub 包解不开：${unpacked.error}`);
	if (unpacked.skipped.some((entry) => entry.reason !== 'filtered')) throw new Error('SkillHub 包含不安全或不可读取的文件');
	const root = stripSingleRoot(unpacked.files);
	if (!root.some((file) => file.path === 'SKILL.md')) {
		throw new Error('SkillHub 下载回来的包里没有 SKILL.md，这个 slug 可能不存在');
	}
	return { files: root, skipped: unpacked.skipped };
}

/* ------------------------------------------------------------------- github */

function parseRepoRef(value) {
	if (typeof value !== 'string') return null;
	const match = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(value.trim());
	if (!match) return null;
	return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
}

async function loadGithub({ refresh = false, state, query, limit }) {
	const term = query && query.trim() ? query.trim() : 'agent-skills';
	const authenticated = state.isGithubAuthenticated();
	const key = `github:${authenticated ? 'code' : 'repositories'}:${term}:${limit}`;
	const cached = state.github.get(key);
	if (!refresh && cached && nowMs() - cached.at < GITHUB_TTL_MS) {
		return { at: cached.at, items: cached.items, total: cached.items.length, nextCursor: null };
	}

	// A code search finds individual skills but needs a token; without one we
	// fall back to repositories and then look inside for SKILL.md.
	if (authenticated) {
		const url = `https://api.github.com/search/code?q=${encodeURIComponent(`filename:SKILL.md ${term}`)}&per_page=${limit}`;
		const body = await githubJson(url, 'GitHub code search', state);
		const items = (body.items || []).map((hit) => {
			const repo = hit.repository || {};
			const filePath = typeof hit.path === 'string' ? hit.path : '';
			const dir = filePath.replace(/\/?SKILL\.md$/i, '');
			return {
				id: `github:${repo.full_name}:${dir || '.'}`,
				source: 'github',
				name: dir ? path.posix.basename(dir) : repo.name,
				title: dir ? path.posix.basename(dir) : repo.name,
				summary: clip(path.posix.dirname(dir) === '.' ? repo.name : `${dir} · ${repo.full_name}`, 120),
				repo: repo.full_name,
				icon: githubOwnerIcon(repo.owner?.login ?? repo.full_name?.split('/')[0]),
				pageUrl: hit.html_url,
				installable: true,
				install: { kind: 'github-dir', repo: repo.full_name, dir, ref: repo.default_branch },
				installNote: '安装时从这个仓库取该目录的文件',
			};
		});
		state.github.set(key, { at: nowMs(), items });
		return { at: nowMs(), items, total: Number.isFinite(body.total_count) ? body.total_count : items.length, nextCursor: null };
	}

	const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(`topic:agent-skills ${term === 'agent-skills' ? '' : term}`.trim())}&sort=stars&per_page=${Math.min(limit, 20)}`;
	const body = await githubJson(url, 'GitHub repository search', state);
	const items = (body.items || []).map((repo) => ({
		id: `github:${repo.full_name}`,
		source: 'github',
		name: repo.name,
		title: repo.full_name,
		icon: githubOwnerIcon(repo.owner?.login ?? repo.full_name?.split('/')[0]),
		summary: clip(repo.description || '', 200),
		stars: Number.isFinite(repo.stargazers_count) ? repo.stargazers_count : undefined,
		updatedAt: repo.pushed_at ? Date.parse(repo.pushed_at) : undefined,
		pageUrl: repo.html_url,
		installable: true,
		install: { kind: 'github-dir', repo: repo.full_name, dir: '', ref: repo.default_branch },
		installNote: '没有 GitHub token 时只能按仓库找；安装会取仓库根目录的 SKILL.md',
	}));
	state.github.set(key, { at: nowMs(), items });
	return { at: nowMs(), items, total: Number.isFinite(body.total_count) ? body.total_count : items.length, nextCursor: null };
}

/* ---------------------------------------------------------------- github i/o */

function installedSkillTarget(skill) {
	const id = skill.marketId;
	if (!id) return { reason: '未记录市场来源' };
	if (id.startsWith('github:') || id.startsWith('official:')) {
		const github = /^github:([\w.-]+\/[\w.-]+)(?::(.*))?$/.exec(id);
		const official = /^official:([\w-]+)$/.exec(id);
		const repo = github?.[1] ?? (official ? OFFICIAL_REPO : null);
		const dir = official ? `skills/${official[1]}` : github?.[2] === '.' ? '' : github?.[2] ?? '';
		if (!repo || repo.split('/').some(part => part === '.' || part === '..')
			|| (dir && dir.split('/').some(part => !part || part === '.' || part === '..'))) {
			return { reason: '未记录有效的 GitHub 技能目录' };
		}
		if (skill.marketVersionIssue) return { source: 'github', receiptError: skill.marketVersionIssue };
		if (/^[a-f\d]{40}$/i.test(skill.marketCommit ?? '')) return { source: 'github', repo, dir, ref: skill.marketCommit };
		const page = URL.parse(skill.pageUrl ?? '');
		const pin = /^\/([\w.-]+\/[\w.-]+)\/(tree|blob)\/([a-f\d]{40})(?:\/(.*))?$/i.exec(page?.pathname ?? '');
		const expected = pin?.[2] === 'blob' ? [dir, 'SKILL.md'].filter(Boolean).join('/') : dir;
		if (page?.origin !== 'https://github.com' || !pin || pin[1].toLowerCase() !== repo.toLowerCase() || (pin[4] ?? '') !== expected) {
			return { reason: '未记录可验证的 GitHub 安装提交' };
		}
		return { source: 'github', repo, dir, ref: pin[3] };
	}
	const claw = /^clawhub:([\w.-]+)\/([\w.-]+)$/.exec(id);
	const hub = /^skillhub:([\w.-]+)$/.exec(id);
	const page = URL.parse(skill.pageUrl ?? '');
	if (!claw && !(hub && page?.origin === 'https://skillhub.cn' && /^\/skills\/[^/]+\/[^/]+$/.test(page.pathname))) {
		return { reason: '缺少可核对的发布者，或来源暂不支持版本检查' };
	}
	const current = publishedVersion(skill.marketVersion);
	const receiptError = skill.marketVersionIssue ?? (!current && skill.marketVersion != null ? '凭据中的市场版本格式无效' : null);
	if (!current && !receiptError) return { reason: '未记录可比较的已安装市场版本' };
	const source = claw
		? { source: 'clawhub', owner: claw[1], slug: claw[2], current }
		: { source: 'skillhub', slug: hub[1], pageUrl: page.href, current };
	return { ...source, receiptError };
}

function githubSkillTreeRevision(body, dir) {
	if (body?.truncated || !Array.isArray(body?.tree)) throw new Error('GitHub 未返回完整文件树');
	const prefix = dir ? dir + '/' : '';
	const blobs = body.tree.filter(entry => entry.type === 'blob').map(entry => entry.path);
	if (!findSkillManifest(blobs, prefix)) {
		throw new Error(`GitHub 目录 ${dir || '根目录'} 未找到 SKILL.md`);
	}
	if (!dir) {
		const files = body.tree.map(({ path, mode, sha }) => {
			if (typeof path !== 'string' || typeof mode !== 'string' || !/^[a-f\d]{40}$/i.test(sha ?? '')) {
				throw new Error('GitHub 文件树包含无法比较的条目');
			}
			return [path, mode, sha];
		}).sort((a, b) => a[0].localeCompare(b[0], 'en'));
		return createHash('sha256').update(JSON.stringify(files)).digest('hex');
	}
	const revision = body.tree.find(entry => entry.type === 'tree' && entry.path === dir)?.sha;
	if (!/^[a-f\d]{40}$/i.test(revision ?? '')) throw new Error('GitHub 未返回可比较的目录版本');
	return revision;
}

async function githubDirFiles(item, state) {
	const target = item.install || {};
	const ref = target.ref || (await githubJson(`https://api.github.com/repos/${target.repo}`, 'GitHub repository', state)).default_branch;
	if (typeof ref !== 'string' || !ref) throw new Error('GitHub did not provide a default branch');
	const commit = /^[a-f\d]{40}$/i.test(ref) ? ref : (await githubJson(
		`https://api.github.com/repos/${target.repo}/commits/${encodeURIComponent(ref)}`, 'GitHub skill install commit', state,
	)).sha;
	if (typeof commit !== 'string' || !/^[a-f\d]{40}$/i.test(commit)) throw new Error('GitHub 未返回有效的 Skill 安装提交');
	const tree = await githubJson(
		`https://api.github.com/repos/${target.repo}/git/trees/${commit}?recursive=1`,
		'GitHub tree',
		state,
	);
	if (tree.truncated) throw new Error('这个仓库太大，GitHub 截断了文件列表，无法按目录安装');
	if (!Array.isArray(tree.tree)) throw new Error('GitHub 未返回完整文件树');
	const blobs = tree.tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path);
	const prefix = target.dir ? target.dir.replace(/\/+$/, '') + '/' : '';
	if (!findSkillManifest(blobs, prefix)) throw new Error(`这个仓库在 ${target.dir || '根目录'} 里没有 SKILL.md`);
	const wanted = blobs.filter((p) => p.startsWith(prefix));
	if (wanted.length > 5000) throw new Error('skill contains more than 5000 files');
	const files = [];
	let totalBytes = 0;
	for (const filePath of wanted) {
		const raw = await fetchWithTimeout(
			`https://raw.githubusercontent.com/${target.repo}/${commit}/${filePath.split('/').map(encodeURIComponent).join('/')}`,
			{ fetchImpl: state.fetch },
		);
		if (!raw.ok) throw new Error(`raw.githubusercontent returned ${raw.status} for ${filePath}`);
		const bytes = await readDownload(raw, MAX_INSTALL_BYTES - totalBytes);
		totalBytes += bytes.length;
		files.push({ path: filePath.slice(prefix.length), bytes });
	}
	if (files.length === 0) throw new Error('目录里没有文件');
	return { files, skipped: [], commit };
}

/* -------------------------------------------------------------------- public */

export function createSkillMarket({ token, metricsAuthKey = () => token ?? '', isGithubAuthenticated = () => Boolean(token), fs: fsImpl = nodeFs, fetchImpl } = {}) {
	const state = {
		clawhub: null,
		official: null,
		skillhub: null,
		github: new Map(),
		token: token || null,
		isGithubAuthenticated,
		fetch: fetchImpl || fetch,
	};
	const fs = fsImpl;

	async function checkInstalledUpdates(skills, { signal } = {}) {
		const lookupLimit = AbortSignal.timeout(25000);
		const deadline = signal ? AbortSignal.any([signal, lookupLimit]) : lookupLimit;
		const lookupState = { ...state, fetch: (url, init) => state.fetch(url, {
			...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
		}) };
		const lookups = new Map();
		function once(key, request) {
			if (!lookups.has(key)) lookups.set(key, request());
			return lookups.get(key);
		}
		const entries = [];
		const skipped = {};
		const tasks = [];
		for (const skill of skills) {
			const target = installedSkillTarget(skill);
			if (target.reason) skipped[target.reason] = (skipped[target.reason] ?? 0) + 1;
			else tasks.push({ skill, target });
		}
		let index = 0;
		await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
			while (index < tasks.length) {
				const slot = index++;
				const { skill, target } = tasks[slot];
				const row = { name: skill.name, id: skill.id, root: skill.root, pageUrl: skill.pageUrl, source: target.source };
				try {
					if (target.receiptError) throw new Error(target.receiptError);
					if (deadline.aborted) throw new Error('本次 Skill 检查超时');
					if (target.source === 'github') {
						const tree = ref => once(`tree:${target.repo.toLowerCase()}:${ref}`, () => githubJson(
							`https://api.github.com/repos/${target.repo}/git/trees/${ref}?recursive=1`, 'GitHub skill tree', lookupState));
						const [installed, latest] = await Promise.all([tree(target.ref), tree('HEAD')]);
						const currentRevision = githubSkillTreeRevision(installed, target.dir);
						const latestRevision = githubSkillTreeRevision(latest, target.dir);
						entries[slot] = { ...row, current: target.ref.slice(0, 7), status: currentRevision === latestRevision ? 'current' : 'changed' };
						continue;
					}
					let version;
					if (target.source === 'clawhub') {
						const body = await once(`clawhub:${target.owner.toLowerCase()}/${target.slug}`, () => clawHubSkill(target, lookupState.fetch));
						version = body.latestVersion?.version;
					} else {
						const listing = await once(`skillhub:${target.slug}`, () => loadSkillhub({
							refresh: true, state: lookupState, query: target.slug, limit: 100,
						}));
						const matches = listing.items.filter(item => item.install?.slug === target.slug && item.pageUrl === target.pageUrl);
						if (matches.length !== 1) throw new Error('SkillHub 未返回唯一且发布者匹配的技能');
						version = matches[0].version;
					}
					const latest = publishedVersion(version);
					if (!latest) throw new Error('上游未返回可比较的版本号');
					const status = compareVersions(latest, target.current) > 0 ? 'newer' : 'current';
					entries[slot] = { ...row, current: target.current, latest, status };
				} catch (error) {
					entries[slot] = { ...row, status: 'failed', error: deadline.aborted ? '本次 Skill 检查超时' : clip(error?.cause?.message ?? error?.message, 240) || '无法读取上游版本' };
				}
			}
		}));
		return {
			checked: tasks.length, skipped, entries,
			current: entries.filter(row => row.status === 'current').length,
			updatable: entries.filter(row => row.status === 'newer' || row.status === 'changed').length,
			failed: entries.filter(row => row.status === 'failed').length,
		};
	}

    const metricCache = new Map();
    const metricRevision = new Map();
    const metricCooldown = new Map();
    let metricAuth = metricsAuthKey();
    const METRIC_TTL_MS = 5 * 60_000;

    const metricIdentity = item => JSON.stringify([item.source, item.owner ?? '', item.install?.owner ?? '', item.install?.repo ?? '', item.install?.slug ?? item.name]);
    function applyMetrics(items) {
        return items.map(item => {
            const saved = metricCache.get(item.id);
            return saved?.identity === metricIdentity(item) ? { ...item, ...saved.values, metrics: { at: saved.at, stale: Boolean(saved.error) || Date.now() - Date.parse(saved.at) >= METRIC_TTL_MS, ...(saved.error ? { error: saved.error } : {}) } } : item;
        });
    }

    // IDs and recipes are resolved by the host. Only popularity measurements
    // are updated; an index's reviewed installation recipe never changes here.
    async function metrics({ items = [], refresh = false } = {}) {
        if (metricsAuthKey() !== metricAuth) { metricAuth = metricsAuthKey(); metricCooldown.delete('github'); }
        const batchAuth = metricAuth;
        const deadline = AbortSignal.timeout(15_000);
        const fetchImpl = (url, init = {}) => state.fetch(url, { ...init,
            signal: init.signal ? AbortSignal.any([deadline, init.signal]) : deadline });
        const results = {};
        const tasks = items.slice(0, 200).filter(item => !item.collection && ['clawhub', 'skillhub', 'github'].includes(item.source));
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
            while (cursor < tasks.length) {
                const item = tasks[cursor++];
                const cached = metricCache.get(item.id);
                const identity = metricIdentity(item);
                const saved = cached?.identity === identity ? cached : null;
                if (!refresh && saved && !saved.error && Date.now() - Date.parse(saved.at) < METRIC_TTL_MS) {
                    results[item.id] = { ...saved.values, metrics: { at: saved.at, stale: false } }; continue;
                }
                const revision = (metricRevision.get(item.id) ?? 0) + 1;
                metricRevision.set(item.id, revision);
                try {
                    if (deadline.aborted) throw new Error('本次统计更新超时，剩余条目未更新');
                    if ((metricCooldown.get(item.source) ?? 0) > Date.now()) throw new Error('来源请求次数受限，本次保留上次统计');
                    let raw;
                    if (item.source === 'clawhub') {
                        const slug = item.install?.slug || item.name;
                        const body = await clawHubSkill({ slug, owner: item.install?.owner }, fetchImpl);
                        raw = body.skill.stats;
                    } else if (item.source === 'skillhub') {
                        const listing = await loadSkillhub({ refresh: true, state: { ...state, fetch: fetchImpl }, query: item.install?.slug || item.name, limit: 100 });
                        const matches = listing.items.filter(row => row.id === item.id && (!item.owner || row.owner === item.owner));
                        if (matches.length > 1) throw new Error('来源存在同名技能，无法可靠确认统计归属');
                        const match = matches[0];
                        if (!match) throw new Error('来源未返回该技能的最新统计');
                        raw = match;
                    } else {
                        const repo = parseRepoRef(item.install?.repo);
                        if (!repo) throw new Error('技能缺少有效的 GitHub 仓库标识');
                        const body = await githubJson(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, 'GitHub statistics', { ...state, fetch: fetchImpl });
                        raw = { stars: body.stargazers_count };
                    }
                    const values = {};
                    for (const key of ['downloads', 'stars']) if (typeof raw?.[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0) values[key] = raw[key];
                    if (!Object.keys(values).length) throw new Error('来源未提供可用的下载量或 Star 统计');
                    const missing = ['downloads', 'stars'].filter(key => typeof (saved?.values[key] ?? item[key]) === 'number' && !(key in values));
                    const partialError = missing.length ? `来源未返回${missing.map(key => key === 'downloads' ? '下载量' : 'Star').join('、')}，保留上次数字` : null;
                    if (metricRevision.get(item.id) === revision) {
                        metricCache.delete(item.id);
                        metricCache.set(item.id, { values: { ...saved?.values, ...values }, identity, at: new Date().toISOString(), ...(partialError ? { error: partialError } : {}) });
                        while (metricCache.size > 2000) { const oldest = metricCache.keys().next().value; metricCache.delete(oldest); metricRevision.delete(oldest); }
                    }
                    const latest = metricCache.get(item.id);
                    const current = latest?.identity === identity ? latest : saved;
                    results[item.id] = { ...current?.values, metrics: { at: current?.at, stale: Boolean(current?.error), ...(current?.error ? { error: current.error } : {}) } };
                } catch (error) {
                    if (error.rateLimited && metricRevision.get(item.id) === revision && (item.source !== 'github' || metricsAuthKey() === batchAuth)) metricCooldown.set(item.source, error.retryAt ?? Date.now() + 60_000);
                    const latest = metricCache.get(item.id);
                    const current = latest?.identity === identity ? latest : saved;
                    if (metricRevision.get(item.id) === revision) {
                        metricCache.set(item.id, { values: current?.values ?? {}, identity, at: current?.at ?? item.lastSeen ?? null, error: String(error.message ?? error) });
                        while (metricCache.size > 2000) { const oldest = metricCache.keys().next().value; metricCache.delete(oldest); metricRevision.delete(oldest); }
                    }
                    results[item.id] = { ...current?.values, metrics: { at: current?.at ?? item.lastSeen ?? null, stale: true, error: String(error.message ?? error) } };
                }
            }
        }));
        return { items: results, requested: tasks.length, updated: Object.values(results).filter(row => !row.metrics.stale).length,
            errors: Object.entries(results).filter(([, row]) => row.metrics.error).map(([id, row]) => ({ id, message: row.metrics.error })) };
    }

	async function list({ source = 'all', query = '', limit = 20, refresh = false } = {}) {
		query = skillMarketSearch(query).query;
		const wanted = source && source !== 'all' ? [source] : SKILL_MARKET_SOURCES;
		const size = Math.min(Math.max(Number(limit) || 20, 1), 60);
		const sources = [];
		const items = [];
		for (const id of wanted) {
			if (!SKILL_MARKET_SOURCES.includes(id)) {
				sources.push({ id, label: id, count: 0, error: 'unknown source' });
				continue;
			}
			try {
				let result;
				if (id === 'clawhub') result = await loadClawhub({ refresh, query, limit: size, state });
				else if (id === 'official') result = await loadOfficial({ refresh, state, query });
				else if (id === 'skillhub') result = await loadSkillhub({ refresh, state, query, limit });
				else result = await loadGithub({ refresh, state, query, limit: size });
				const rows = (result.items || []).slice(0, size);
				items.push(...rows);
				sources.push({
					id,
					label: SKILL_MARKET_LABELS[id],
					count: rows.length,
					total: result.total,
					cachedAt: result.at,
					error: null,
				});
			} catch (error) {
				sources.push({ id, label: SKILL_MARKET_LABELS[id], count: 0, error: clip(error.message, 240) });
			}
		}
		if (!wanted.includes('github')) return { sources, items };
		const combined = withFeaturedGithubSkills(items, query);
		const github = sources.find(row => row.id === 'github');
		github.count = combined.filter(row => row.source === 'github').length;
		github.featured = FEATURED_GITHUB_SKILL_COUNT;
		return { sources, items: combined };
	}

	async function install({ item, targetDir }) {
		if (!item || !item.installable) throw new Error('这个条目不能直接安装');
		const kind = item.install && item.install.kind;
		if (kind !== 'clawhub-zip' && kind !== 'skillhub-zip' && kind !== 'github-dir') {
			throw new Error(`unknown install kind ${kind}`);
		}
		if (!targetDir || typeof targetDir !== 'string') throw new Error('no target directory');
		const reservation = process.platform === 'win32' ? path.resolve(targetDir).toLowerCase() : path.resolve(targetDir);
		if (installing.has(reservation)) throw Object.assign(new Error('skill installation is already in progress'), { status: 409 });
		installing.add(reservation);
		let stage = null;
		const refuseExisting = async () => {
			try {
				await fs.lstat(targetDir);
			} catch (err) {
				if (err.code === 'ENOENT') return;
				throw err;
			}
			throw Object.assign(new Error(`skill directory already exists: ${targetDir}`), { status: 409 });
		};
		try {
			await refuseExisting();
			const { files, skipped, commit } = kind === 'clawhub-zip'
				? await clawhubFiles(item, state)
				: kind === 'skillhub-zip'
					? await skillhubFiles(item, state)
					: await githubDirFiles(item, state);
			const manifest = findSkillManifest(files.map(file => file.path));
			if (!manifest) {
				throw new Error('下载结果里没有 SKILL.md，不敢往 skill 目录里放');
			}
			await fs.mkdir(path.dirname(targetDir), { recursive: true });
			stage = await fs.mkdtemp(path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.install-`));
			const written = [];
			for (const file of files) {
				if (file.path.toLowerCase() === SKILL_ICON_METADATA) continue;
				const filename = file.path === manifest ? SKILL_FILE : file.path;
				const destination = path.join(stage, ...filename.split('/'));
				const relative = path.relative(stage, destination);
				if (!relative || file.path.includes('\\') || file.path.includes(':') || relative.startsWith('..') || path.isAbsolute(relative)) {
					throw new Error(` refusing to write outside the target: ${file.path}`);
				}
				await fs.mkdir(path.dirname(destination), { recursive: true });
				await fs.writeFile(destination, file.bytes, { flag: 'wx' });
				written.push(filename);
			}
			const icon = declaredIcon(item);
			const emoji = declaredEmoji(item);
			const iconCandidates = publisherIcons(item.homepage, item.pageUrl, item.repository);
			const pageUrl = skillSourcePage({ ...item, marketId: item.id });
			if (item.id || pageUrl || icon || emoji || iconCandidates.length) {
				// Keep the catalog identity and page even when no artwork exists.
				await fs.writeFile(path.join(stage, SKILL_ICON_METADATA), JSON.stringify({
					marketId: item.id, pageUrl, icon, emoji, ...(iconCandidates.length ? { iconCandidates } : {}),
					...(kind === 'clawhub-zip' && item.install.version ? { marketVersion: item.install.version } : {}),
					...(commit ? { marketCommit: commit } : {}),
				}), { flag: 'wx' });
			}
			await refuseExisting();
			await fs.rename(stage, targetDir);
			stage = null;
			return { dir: targetDir, files: written, skipped: skipped.filter((entry) => entry.reason !== 'filtered').slice(0, 10) };
		} finally {
			try {
				if (stage) await fs.rm(stage, { recursive: true, force: true });
			} finally {
				installing.delete(reservation);
			}
		}
	}

	return { list, install, metrics, applyMetrics, checkInstalledUpdates, sources: SKILL_MARKET_SOURCES };
}

export const _internal = { skillhubItem, clawhubItem, frontmatter: parseFrontmatter, parseRepoRef };
