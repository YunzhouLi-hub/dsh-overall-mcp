// The skill market: four catalogues behind one list.
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
import { readZipFiles } from './zip.js';

export const SKILL_MARKET_SOURCES = ['clawhub', 'official', 'skillhub', 'github'];

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

function filterByQuery(items, query) {
	const term = typeof query === 'string' ? query.trim().toLowerCase() : '';
	if (!term) return items;
	return items.filter((item) =>
		`${item.name} ${item.title} ${item.summary} ${item.category ?? ''}`.toLowerCase().includes(term),
	);
}

function clip(text, limit) {
	if (typeof text !== 'string') return '';
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
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
		throw new Error(`${label} returned ${response.status}: ${clip(text, 200) || 'no body'}`);
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

async function loadClawhub({ query, limit, state }) {
	const cached = state.clawhub;
	if (cached && nowMs() - cached.at < CLAWHUB_TTL_MS && !cached.query && !query) return cached;
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

function frontmatter(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!match) return {};
	const out = {};
	let key = null;
	for (const rawLine of match[1].split(/\r?\n/)) {
		const line = rawLine.replace(/\s+$/, '');
		const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (pair) {
			key = pair[1];
			const value = pair[2];
			if (value === '>' || value === '|' || value === '') out[key] = '';
			else out[key] = value.replace(/^["']/, '').replace(/["']$/, '');
			continue;
		}
		if (key && /^\s+/.test(line)) out[key] = `${out[key]} ${line.trim()}`.trim();
	}
	return out;
}

async function loadOfficial({ state, query }) {
	// The cache holds the *whole* set, never an answer: returning it verbatim
	// ignored the query for ten minutes, so a search on the market tab listed all
	// nineteen anthropics skills and buried the rows that actually matched.
	const cached = state.official;
	if (cached && nowMs() - cached.at < OFFICIAL_TTL_MS) {
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
			if (raw.ok) meta = frontmatter(await raw.text());
		} catch {
			// A missing SKILL.md only costs this row its description.
		}
		items.push({
			id: `official:${name}`,
			source: 'official',
			name,
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
	const homepage = typeof raw?.homepage === 'string' && /^https?:\/\//.test(raw.homepage) ? raw.homepage : undefined;
	const updated = Number(raw?.updated_at);
	return {
		id: `skillhub:${slug}`,
		source: 'skillhub',
		name,
		title: name,
		summary: clip(description, 240),
		version: typeof raw?.version === 'string' ? raw.version : undefined,
		owner: typeof raw?.ownerName === 'string' ? raw.ownerName : undefined,
		downloads: Number.isFinite(Number(raw?.downloads)) ? Number(raw.downloads) : undefined,
		stars: Number.isFinite(Number(raw?.stars)) ? Number(raw.stars) : undefined,
		category: typeof raw?.category === 'string' ? raw.category : undefined,
		verified: raw?.verified === true,
		updatedAt: Number.isFinite(updated) && updated > 0 ? updated : undefined,
		// The site puts the human page at this address; there is no
		// slug-only URL shape that we verified, so an absent one stays absent
		// rather than being assembled out of a guess.
		pageUrl: homepage,
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
async function loadSkillhub({ state, query, limit }) {
	const cached = state.skillhub;
	if (cached && nowMs() - cached.at < SKILLHUB_TTL_MS) {
		return { at: cached.at, items: filterByQuery(cached.items, query), total: cached.items.length, nextCursor: null };
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
	if (!needle) state.skillhub = { at: nowMs(), items };
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

async function loadGithub({ state, query, limit }) {
	const term = query && query.trim() ? query.trim() : 'agent-skills';
	const authenticated = state.isGithubAuthenticated();
	const key = `github:${authenticated ? 'code' : 'repositories'}:${term}:${limit}`;
	const cached = state.github.get(key);
	if (cached && nowMs() - cached.at < GITHUB_TTL_MS) {
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

function pickGithubDir(files, dir) {
	if (!dir) {
		const root = files.find((file) => /^SKILL\.md$/i.test(file.path));
		if (root) return '';
		return null;
	}
	const prefix = `${dir.replace(/\/+$/, '')}/`;
	if (!files.some((file) => file.path.toLowerCase() === `${prefix}skill.md`.toLowerCase())) return null;
	return prefix;
}

async function githubDirFiles(item, state) {
	const target = item.install || {};
	const ref = target.ref || (await githubJson(`https://api.github.com/repos/${target.repo}`, 'GitHub repository', state)).default_branch;
	if (typeof ref !== 'string' || !ref) throw new Error('GitHub did not provide a default branch');
	const tree = await githubJson(
		`https://api.github.com/repos/${target.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
		'GitHub tree',
		state,
	);
	if (tree.truncated) throw new Error('这个仓库太大，GitHub 截断了文件列表，无法按目录安装');
	const blobs = (tree.tree || []).filter((entry) => entry.type === 'blob').map((entry) => entry.path);
	const prefix = pickGithubDir(blobs.map((p) => ({ path: p })), target.dir);
	if (prefix === null) throw new Error(`这个仓库在 ${target.dir || '根目录'} 里没有 SKILL.md`);
	const wanted = blobs.filter((p) => p.startsWith(prefix));
	if (wanted.length > 5000) throw new Error('skill contains more than 5000 files');
	const files = [];
	let totalBytes = 0;
	for (const filePath of wanted) {
		const raw = await fetchWithTimeout(
			`https://raw.githubusercontent.com/${target.repo}/${encodeURIComponent(ref)}/${filePath.split('/').map(encodeURIComponent).join('/')}`,
			{ fetchImpl: state.fetch },
		);
		if (!raw.ok) throw new Error(`raw.githubusercontent returned ${raw.status} for ${filePath}`);
		const bytes = await readDownload(raw, MAX_INSTALL_BYTES - totalBytes);
		totalBytes += bytes.length;
		files.push({ path: filePath.slice(prefix.length), bytes });
	}
	if (files.length === 0) throw new Error('目录里没有文件');
	return { files, skipped: [] };
}

/* -------------------------------------------------------------------- public */

export function createSkillMarket({ token, isGithubAuthenticated = () => Boolean(token), fs: fsImpl = nodeFs, fetchImpl } = {}) {
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

	async function list({ source = 'all', query = '', limit = 20 } = {}) {
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
				if (id === 'clawhub') result = await loadClawhub({ query, limit: size, state });
				else if (id === 'official') result = await loadOfficial({ state, query });
				else if (id === 'skillhub') result = await loadSkillhub({ state, query, limit });
				else result = await loadGithub({ state, query, limit: size });
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
		return { sources, items };
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
			const { files, skipped } = kind === 'clawhub-zip'
				? await clawhubFiles(item, state)
				: kind === 'skillhub-zip'
					? await skillhubFiles(item, state)
					: await githubDirFiles(item, state);
			if (!files.some((file) => file.path.toLowerCase() === 'skill.md')) {
				throw new Error('下载结果里没有 SKILL.md，不敢往 skill 目录里放');
			}
			await fs.mkdir(path.dirname(targetDir), { recursive: true });
			stage = await fs.mkdtemp(path.join(path.dirname(targetDir), `.${path.basename(targetDir)}.install-`));
			const written = [];
			for (const file of files) {
				const destination = path.join(stage, ...file.path.split('/'));
				const relative = path.relative(stage, destination);
				if (!relative || file.path.includes('\\') || file.path.includes(':') || relative.startsWith('..') || path.isAbsolute(relative)) {
					throw new Error(` refusing to write outside the target: ${file.path}`);
				}
				await fs.mkdir(path.dirname(destination), { recursive: true });
				await fs.writeFile(destination, file.bytes, { flag: 'wx' });
				written.push(file.path);
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

	return { list, install, sources: SKILL_MARKET_SOURCES };
}

export const _internal = { skillhubItem, clawhubItem, pickGithubDir, frontmatter, parseRepoRef };
