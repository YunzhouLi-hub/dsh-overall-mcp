import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createSkillMarket, SKILL_MARKET_SOURCES, SKILL_MARKET_LABELS } from '../lib/skill-market.js';

/** The smallest ZIP that the reader will accept: one stored `SKILL.md`. */
function skillZip(entries) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, text] of entries) {
		const nameBytes = Buffer.from(name, 'utf8');
		const body = Buffer.from(text, 'utf8');
		const payload = zlib.deflateRawSync(body);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(8, 8);
		local.writeUInt32LE(payload.length, 18);
		local.writeUInt32LE(body.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		locals.push(local, nameBytes, payload);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(8, 10);
		central.writeUInt32LE(payload.length, 20);
		central.writeUInt32LE(body.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);
		offset += local.length + nameBytes.length + payload.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A fetch that answers by URL and records what was asked for.
 *
 * Every provider below is keyed by the URL the module is documented to call, so
 * a change in the module's endpoint shows up here as an unhandled request
 * rather than as a test that quietly keeps passing.
 */
function fakeFetch(routes) {
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

const clawhubRow = {
	ownerHandle: 'pskoett',
	slug: 'self-improving-agent',
	displayName: 'self-improving agent',
	summary: 'Learns from its own mistakes.',
	topics: ['self-improvement'],
	tags: { latest: '4.0.5' },
	stats: { downloads: 489160, stars: 4005 },
	updatedAt: 1792672926676,
	latestVersion: { version: '4.0.5' },
};

test('the sources are named once and no view sneaks into the list', () => {
	assert.deepEqual(SKILL_MARKET_SOURCES, ['clawhub', 'official', 'skillhub', 'github']);
	assert.deepEqual(Object.keys(SKILL_MARKET_LABELS).sort(), ['clawhub', 'github', 'official', 'skillhub']);
});

test('github search follows current authentication and never reuses an anonymous result after login', async () => {
  let authenticated = false;
  const fetchImpl = fakeFetch([
    ['/search/repositories', () => json({ items: [], total_count: 0 })],
    ['/search/code', () => json({ items: [{ path: 'skills/demo/SKILL.md', repository: { full_name: 'audit/repo' } }], total_count: 1 })],
  ]);
  const market = createSkillMarket({ fetchImpl, isGithubAuthenticated: () => authenticated });
  await market.list({ source: 'github', query: 'demo' });
  authenticated = true;
  const out = await market.list({ source: 'github', query: 'demo' });
  assert.equal(out.items[0]?.name, 'demo');
  assert.match(fetchImpl.calls.at(-1).url, /\/search\/code/);
});

test('Superpowers supplies its verified directories alongside GitHub search results and errors', async () => {
	const repo = 'obra/superpowers';
	const directory = 'skills/using-superpowers';
	let authenticated = false;
	const fetchImpl = fakeFetch([
		['/search/repositories', () => json({ items: [{ full_name: repo, name: 'superpowers' }], total_count: 1 })],
		['/search/code', () => json({ items: [{ path: `${directory}/SKILL.md`, repository: { full_name: repo } }], total_count: 1 })],
	]);
	const market = createSkillMarket({ fetchImpl, isGithubAuthenticated: () => authenticated });
	for (const query of ['superpower', 'superpowers', repo]) {
		const { items } = await market.list({ source: 'github', query });
		assert.equal(items.length, 15);
		assert.ok(items.every(item => item.collection === repo && item.install.dir.startsWith('skills/')));
	}
	const pasted = await market.list({ source: 'github', query: `https://github.com/${repo}/`, refresh: true });
	assert.equal(pasted.items.length, 15);
	assert.equal(new URL(fetchImpl.calls.at(-1).url).searchParams.get('q'), `topic:agent-skills ${repo}`);
	authenticated = true;
	const { items } = await market.list({ source: 'github', query: 'using-superpowers' });
	assert.deepEqual(items.map(row => row.id), [`github:${repo}:${directory}`]);
	const [item] = items;
	assert.match(item.install.ref, /^[0-9a-f]{40}$/);
	assert.equal(item.pageUrl, `https://github.com/${repo}/tree/${item.install.ref}/${directory}`);
	assert.equal((await market.metrics({ items })).requested, 0, 'repository stars are not a skill counter');

	const unavailable = createSkillMarket({ fetchImpl: fakeFetch([['/search/repositories', () => json({}, 503)]]) });
	const offline = await unavailable.list({ source: 'github', query: repo });
	assert.equal(offline.items.length, 15);
	assert.match(offline.sources[0].error, /503/);
	assert.ok(offline.sources[0].featured >= offline.items.length);
});

test('eight additional official collections resolve to pinned skill directories', async () => {
  const chromeRepo = 'ChromeDevTools/chrome-devtools-mcp';
  const chromeDir = 'skills/chrome-devtools';
  let authenticated = false;
  const fetchImpl = fakeFetch([
    ['/search/repositories', () => json({ items: [{ full_name: chromeRepo.toLowerCase(), name: 'chrome-devtools-mcp' }], total_count: 1 })],
    ['/search/code', () => json({ items: [{ path: `${chromeDir}/SKILL.md`, repository: { full_name: chromeRepo.toLowerCase() } }], total_count: 1 })],
  ]);
  const market = createSkillMarket({ fetchImpl, isGithubAuthenticated: () => authenticated });
  const collections = [
    ['makenotion/skills', 'skills', 2],
    ['n8n-io/skills', 'skills', 15],
    ['expo/skills', 'plugins/expo/skills', 23],
    [chromeRepo, 'skills', 8],
    ['supabase/agent-skills', 'skills', 2],
    ['stripe/ai', 'skills', 11],
    ['google-gemini/gemini-skills', 'skills', 4],
    ['huggingface/skills', 'skills', 25],
  ];
  for (const [repo, root, count] of collections) {
    const { items } = await market.list({ source: 'github', query: repo });
    assert.equal(items.length, count, repo);
    for (const item of items) {
      const { dir, ref } = item.install;
      assert.equal(item.install.repo, repo);
      assert.equal(dir, `${root}/${item.name}`);
      assert.equal(item.id, `github:${repo}:${dir}`);
      assert.match(ref, /^[0-9a-f]{40}$/);
      assert.equal(item.pageUrl, `https://github.com/${repo}/tree/${ref}/${dir}`);
    }
  }
  authenticated = true;
  const { items } = await market.list({ source: 'github', query: chromeRepo });
  assert.equal(items.length, 8);
  assert.deepEqual(items.filter(item => item.install.dir === chromeDir).map(item => item.id), [`github:${chromeRepo}:${chromeDir}`]);
});

test('clawhub rows carry the canonical page and a download recipe with the owner', async () => {
	const fetchImpl = fakeFetch([['/api/v1/skills?', () => json({ items: [clawhubRow], nextCursor: null })]]);
	const market = createSkillMarket({ fetchImpl });
	const out = await market.list({ source: 'clawhub', limit: 5 });
	assert.equal(out.sources[0].error, null);
	assert.equal(out.sources[0].count, 1);
	const [item] = out.items;
	assert.equal(item.id, 'clawhub:pskoett/self-improving-agent');
	assert.equal(item.name, 'self-improving-agent');
	assert.equal(item.version, '4.0.5');
	assert.equal(item.downloads, 489160);
	assert.equal(item.pageUrl, 'https://clawhub.ai/pskoett/skills/self-improving-agent');
	assert.deepEqual(item.install, {
		kind: 'clawhub-zip',
		owner: 'pskoett',
		slug: 'self-improving-agent',
		version: '4.0.5',
	});
	// A directory that reuses ClawHub's data must ask for the listing, not for a
	// crawl of every skill.
	assert.match(fetchImpl.calls[0].url, /sort=downloads/);
	assert.match(fetchImpl.calls[0].url, /nonSuspiciousOnly=true/);
});

test('a query goes to search, and the answer keeps ClawHub id shape', async () => {
	const fetchImpl = fakeFetch([
		['/api/v1/search?', () => json({ results: [{ ...clawhubRow, score: 0.9, version: '4.0.5' }] })],
	]);
	const market = createSkillMarket({ fetchImpl });
	const out = await market.list({ source: 'clawhub', query: 'self improve', limit: 5 });
	assert.equal(out.items[0].id, 'clawhub:pskoett/self-improving-agent');
	assert.match(fetchImpl.calls[0].url, /q=self(\+|%20)improve/);
});

test('clawhub install unpacks the zip and records declared artwork', async () => {
	const zip = skillZip([
		['SKILL.md', '---\nname: demo\n---\n'],
		['scripts/run.sh', 'echo hi\n'],
	]);
	const fetchImpl = fakeFetch([
		['/api/v1/skills?', () => json({ items: [{ ...clawhubRow, iconUrl: 'https://cdn.example.com/demo.png' }], nextCursor: null })],
		[
			'/api/v1/download?',
			() => new Response(zip, { status: 200, headers: { 'content-type': 'application/zip' } }),
		],
	]);
	const market = createSkillMarket({ fetchImpl });
	const [item] = (await market.list({ source: 'clawhub', limit: 1 })).items;
	const target = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'skm-')), 'demo');
	const out = await market.install({ item, targetDir: target });
	assert.equal(item.icon, 'https://cdn.example.com/demo.png');
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(target, '.overall-mcp-icon.json'), 'utf8')), { marketId: item.id, pageUrl: item.pageUrl, icon: item.icon, marketVersion: '4.0.5' });
	assert.deepEqual(out.files.sort(), ['SKILL.md', 'scripts/run.sh']);
	assert.match(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), /name: demo/);
	assert.equal((await fs.readFile(path.join(target, 'scripts', 'run.sh'), 'utf8')), 'echo hi\n');
	const downloadCall = fetchImpl.calls.find((call) => call.url.includes('/api/v1/download?'));
	assert.match(downloadCall.url, /ownerHandle=pskoett/);
	assert.match(downloadCall.url, /version=4\.0\.5/);
});

test('installed Skill checks use exact publishers and compare only the selected GitHub directory', async () => {
  const ref = '1'.repeat(40);
  const tree = mutable => ({ tree: ['a', 'b'].flatMap(name => [
    { type: 'tree', path: `skills/${name}`, sha: (name === 'b' && mutable ? '3' : '2').repeat(40) },
    { type: 'blob', path: `skills/${name}/skill.md` },
  ]) });
  const fetchImpl = fakeFetch([
    [`/git/trees/${ref}?`, () => json(tree(false))],
    ['/git/trees/HEAD?', () => json(tree(true))],
    ['clawhub.ai/api/v1/skills/demo', () => json({ skill: { slug: 'demo' }, owner: { handle: 'wrong' }, latestVersion: { version: '2.0.0' } })],
    ['api.skillhub.cn/api/skills?', () => json({ data: { skills: [
      { slug: 'report', version: '3.0.0', homepage: 'https://api.skillhub.cn/wrong/report' },
      { slug: 'report', version: '1.2.0', homepage: 'https://api.skillhub.cn/right/report' },
    ] } })],
  ]);
  const market = createSkillMarket({ fetchImpl });
  const result = await market.checkInstalledUpdates([
    { name: 'a', id: 'a', marketId: 'github:org/repo:skills/a', marketCommit: ref, pageUrl: 'https://github.com/org/repo/tree/main/skills/a' },
    { name: 'b', id: 'b', marketId: 'github:org/repo:skills/b', pageUrl: `https://github.com/org/repo/tree/${ref}/skills/b` },
    { id: 'demo', name: 'demo', marketId: 'clawhub:right/demo', marketVersion: '1.0.0' },
    { id: 'report', name: 'report', marketId: 'skillhub:report', pageUrl: 'https://skillhub.cn/skills/right/report', marketVersion: '1.0.0' },
    { id: 'local', name: 'local', version: '1.0.0' },
    { id: 'unversioned', name: 'unversioned', marketId: 'clawhub:right/unversioned', version: '1.0.0' },
  ]);
  assert.equal(result.checked, 4);
  assert.equal(result.updatable, 2);
  assert.equal(result.current, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.entries.map(row => row.status), ['current', 'changed', 'failed', 'newer']);
  assert.match(result.entries[2].error, /发布者不匹配/);
  assert.equal(result.entries[3].latest, '1.2.0');
  assert.deepEqual(Object.values(result.skipped), [1, 1]);
  assert.equal(fetchImpl.calls.filter(x => x.url.includes('/git/trees/')).length, 2);
});

test('install refuses an existing skill without changing any of its files', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'skm-conflict-'));
  const target = path.join(parent, 'demo');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'SKILL.md'), 'personal skill');
  const market = createSkillMarket({ fetchImpl: async () => new Response(skillZip([['SKILL.md', 'replacement']])) });
  try {
    await assert.rejects(market.install({ item: { installable: true, install: { kind: 'clawhub-zip', slug: 'demo' } }, targetDir: target }), (err) => err.status === 409);
    assert.equal(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), 'personal skill');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a failed install publishes no partial skill and releases its reservation', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'skm-atomic-'));
  const target = path.join(parent, 'demo');
  let fail = true;
  const market = createSkillMarket({
    fs: { ...fs, async writeFile(file, ...args) { if (fail && String(file).endsWith('second.txt')) throw new Error('audit disk failure'); return fs.writeFile(file, ...args); } },
    fetchImpl: async () => new Response(skillZip([['SKILL.md', 'demo'], ['second.txt', 'payload']])),
  });
  const item = { installable: true, install: { kind: 'clawhub-zip', slug: 'demo' } };
  try {
    await assert.rejects(market.install({ item, targetDir: target }), /audit disk failure/);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    fail = false;
    await market.install({ item, targetDir: target });
    assert.equal(await fs.readFile(path.join(target, 'second.txt'), 'utf8'), 'payload');
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('concurrent installations cannot publish two different skills into the same directory', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'skm-concurrent-'));
  const targetDir = path.join(parent, 'demo');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => { await gate; return new Response(skillZip([['SKILL.md', 'winner']])); };
  const item = { installable: true, install: { kind: 'clawhub-zip', slug: 'demo' } };
  const first = createSkillMarket({ fetchImpl }).install({ item, targetDir });
  try {
    await assert.rejects(createSkillMarket({ fetchImpl }).install({ item, targetDir }), (err) => err.status === 409);
    release();
    await first;
    assert.equal(await fs.readFile(path.join(targetDir, 'SKILL.md'), 'utf8'), 'winner');
  } finally {
    release();
    await first;
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('oversized downloads and archives with refused files publish nothing', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'skm-refused-'));
  const item = { installable: true, install: { kind: 'clawhub-zip', slug: 'demo' } };
  try {
    const oversized = createSkillMarket({ fetchImpl: async () => new Response('small body', { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }) });
    await assert.rejects(oversized.install({ item, targetDir: path.join(parent, 'oversized') }), /download exceeds/);
    const unsafe = createSkillMarket({ fetchImpl: async () => new Response(skillZip([['SKILL.md', 'demo'], ['../escape.txt', 'unsafe']])) });
    await assert.rejects(unsafe.install({ item, targetDir: path.join(parent, 'unsafe') }), /refused entries/);
    assert.deepEqual(await fs.readdir(parent), []);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('a github-backed clawhub skill says where it really lives instead of writing a JSON file', async () => {
	const fetchImpl = fakeFetch([
		['/api/v1/skills?', () => json({ items: [clawhubRow], nextCursor: null })],
		[
			'/api/v1/download?',
			() =>
				json({ sourceRef: 'public-github', repo: 'someone/thing', commit: 'abc', path: 'skills/x', contentHash: 'h' }),
		],
	]);
	const market = createSkillMarket({ fetchImpl });
	const [item] = (await market.list({ source: 'clawhub', limit: 1 })).items;
	await assert.rejects(
		() => market.install({ item, targetDir: path.join(os.tmpdir(), 'never-created-xyz') }),
		/GitHub/,
	);
});

test('official reads the directory listing and the description out of each SKILL.md', async () => {
	const fetchImpl = fakeFetch([
		[
			'/repos/anthropics/skills/contents/skills',
			json([
				{ name: 'pdf', type: 'dir' },
				{ name: 'xlsx', type: 'dir' },
				{ name: 'README.md', type: 'file' },
			]),
		],
		[
			'/skills/pdf/SKILL.md',
			new Response('---\nname: pdf\ndescription: >\n  Read, split and fill PDFs.\n  Also OCR.\n---\n', { status: 200 }),
		],
		['/skills/xlsx/SKILL.md', () => new Response('---\nname: xlsx\n---\n', { status: 200 })],
	]);
	const market = createSkillMarket({ fetchImpl });
	const out = await market.list({ source: 'official', limit: 10 });
	assert.equal(out.sources[0].total, 19 < 2 ? 19 : out.sources[0].total);
	assert.deepEqual(
		out.items.map((item) => item.id),
		['official:pdf', 'official:xlsx'],
	);
	const pdf = out.items[0];
	assert.equal(pdf.summary, 'Read, split and fill PDFs. Also OCR.');
	assert.deepEqual(pdf.install, { kind: 'github-dir', repo: 'anthropics/skills', dir: 'skills/pdf', ref: 'main' });
	// Only directories count: a stray file in `skills/` is not a skill.
	assert.equal(out.items.length, 2);
});

test('a cached official listing still honours the query', async () => {
	// The market tab browses first and searches second: the ten-minute cache was
	// filled with the whole catalogue by that browse, and the cached answer was
	// returned verbatim — so a search showed all nineteen anthropics skills and
	// buried the rows that matched (a one-row result looked like "nothing
	// happened").
	const fetchImpl = fakeFetch([
		[
			'/repos/anthropics/skills/contents/skills',
			json([{ name: 'pdf', type: 'dir' }, { name: 'docx', type: 'dir' }]),
		],
		['/skills/pdf/SKILL.md', new Response('---\nname: pdf\n---\n', { status: 200 })],
		['/skills/docx/SKILL.md', new Response('---\nname: docx\n---\n', { status: 200 })],
	]);
	const market = createSkillMarket({ fetchImpl });
	const browsed = await market.list({ source: 'official', limit: 10 });
	assert.deepEqual(browsed.items.map((item) => item.id), ['official:pdf', 'official:docx']);
	const searched = await market.list({ source: 'official', query: 'pdf', limit: 10 });
	assert.deepEqual(searched.items.map((item) => item.id), ['official:pdf'],
		'the cache answered the search with the whole catalogue');
	assert.equal(searched.sources[0].total, 2, 'total is the whole set, not the matches');
	const none = await market.list({ source: 'official', query: 'agent-search' });
	assert.deepEqual(none.items, [], 'a query that matches nothing returned rows anyway');
});

test('official install copies one directory out of the repository tree', async () => {
	const commit = 'b'.repeat(40);
	const fetchImpl = fakeFetch([
		['/contents/skills', () => json([{ name: 'pdf', type: 'dir' }])],
		['/commits/main', () => json({ sha: commit })],
		[`/anthropics/skills/${commit}/skills/pdf/skill.md`, () => new Response('# pdf\n', { status: 200 })],
		['/skills/pdf/SKILL.md', () => new Response('---\nname: pdf\n---\n', { status: 200 })],
		[
			`/git/trees/${commit}?recursive=1`,
			json({
				truncated: false,
				tree: [
					{ path: 'skills/pdf/skill.md', type: 'blob' },
					{ path: 'skills/pdf/references/spec.md', type: 'blob' },
					{ path: 'skills/xlsx/SKILL.md', type: 'blob' },
				],
			}),
		],
		[`/anthropics/skills/${commit}/skills/pdf/references/spec.md`, () => new Response('# spec\n', { status: 200 })],
	]);
	const market = createSkillMarket({ fetchImpl });
	const [item] = (await market.list({ source: 'official', limit: 5 })).items;
	const target = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'skm-')), 'pdf');
	const out = await market.install({ item, targetDir: target });
	assert.deepEqual(out.files.sort(), ['SKILL.md', 'references/spec.md']);
	assert.ok((await fs.readdir(target)).includes('SKILL.md'));
	assert.equal(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), '# pdf\n');
	assert.equal((JSON.parse(await fs.readFile(path.join(target, '.overall-mcp-icon.json'), 'utf8'))).marketCommit, commit);
	assert.equal(await fs.readFile(path.join(target, 'references', 'spec.md'), 'utf8'), '# spec\n');
});

test('manifest casing collisions are refused before installing marketplace files', async () => {
  const zip = skillZip([['SKILL.md', 'first'], ['skill.md', 'second']]);
  const market = createSkillMarket({ fetchImpl: async () => new Response(zip) });
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'skm-case-'));
  const target = path.join(parent, 'demo');
  try {
    const item = { installable: true, install: { kind: 'clawhub-zip', slug: 'demo' } };
    await assert.rejects(market.install({ item, targetDir: target }), /多个仅大小写不同/);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('github installation respects the published default branch and resolves legacy recipes', async () => {
  const commit = 'c'.repeat(40);
  const fetchImpl = fakeFetch([
    ['/search/repositories', () => json({ items: [{ full_name: 'audit/master-only', name: 'master-only', default_branch: 'master' }], total_count: 1 })],
    ['/repos/audit/master-only/commits/master', () => json({ sha: commit })],
    [`/repos/audit/master-only/git/trees/${commit}?`, () => json({ tree: [{ type: 'blob', path: 'SKILL.md' }] })],
    [`raw.githubusercontent.com/audit/master-only/${commit}/SKILL.md`, () => new Response('master skill')],
    ['/repos/audit/master-only', () => json({ default_branch: 'master' })],
  ]);
  const market = createSkillMarket({ fetchImpl });
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'skm-branch-'));
  try {
    const listed = (await market.list({ source: 'github' })).items[0];
    assert.equal(listed.install.ref, 'master');
    await market.install({ item: listed, targetDir: path.join(parent, 'listed') });
    const legacy = { ...listed, install: { kind: 'github-dir', repo: 'audit/master-only', dir: '' } };
    await market.install({ item: legacy, targetDir: path.join(parent, 'legacy') });
    assert.equal(await fs.readFile(path.join(parent, 'legacy', 'SKILL.md'), 'utf8'), 'master skill');
    assert.equal(fetchImpl.calls.filter(call => call.url.includes('/commits/master')).length, 2);
    assert.ok(fetchImpl.calls.every(call => !call.url.includes('/trees/master')));
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('skillhub lists real rows from its own API and can install them', async () => {
	const row = {
		slug: 'dev-god',
		name: '编程大神.Skill',
		version: '1.2.4',
		downloads: 10281075,
		ownerName: 'u_42bbb65f',
		homepage: 'https://api.skillhub.cn/ake/dev-god',
		category: 'dev-programming',
		description: 'Full-stack helper.',
		description_zh: '面向复杂真实项目的高阶全栈编程助手。',
		updated_at: 1767000000000,
	};
	const fetchImpl = fakeFetch([
		['api.skillhub.cn/api/skills?', () => json({ code: 0, data: { skills: [row], total: 208921 } })],
		['api.skillhub.cn/api/v1/download?slug=dev-god', () => new Response(skillZip([['SKILL.md', '# dev god\n']]), { status: 200 })],
	]);
	const market = createSkillMarket({ fetchImpl });
	const out = await market.list({ source: 'skillhub', limit: 10 });
	assert.equal(out.sources[0].count, 1);
	assert.equal(out.items[0].id, 'skillhub:dev-god');
	assert.equal(out.items[0].title, '编程大神.Skill');
	// The Chinese description wins when the API offers both.
	assert.equal(out.items[0].summary, '面向复杂真实项目的高阶全栈编程助手。');
	assert.equal(out.items[0].pageUrl, 'https://skillhub.cn/skills/ake/dev-god');
	assert.equal(out.items[0].install.kind, 'skillhub-zip');
	// A listing request asks for the most downloaded first and does not search.
	const call = fetchImpl.calls[0].url;
	assert.match(call, /sortBy=downloads/);
	assert.match(call, /order=desc/);
	assert.doesNotMatch(call, /keyword=/);

	const target = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'sh-install-')), 'skill');
	const written = await market.install({ item: out.items[0], targetDir: target });
	assert.deepEqual(written.files, ['SKILL.md']);
	assert.equal(written.dir, target);
	assert.equal(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), '# dev god\n');
});

test('a skillhub query turns the listing into a search', async () => {
	const fetchImpl = fakeFetch([
		[
			'api.skillhub.cn/api/skills?',
			() => json({ code: 0, data: { skills: [{ slug: 'pdf-tools', name: 'PDF 工具', version: '2.0.0' }], total: 4854 } }),
		],
	]);
	const market = createSkillMarket({ fetchImpl });
	const out = await market.list({ source: 'skillhub', query: 'pdf', limit: 5 });
	assert.deepEqual(out.items.map((item) => item.id), ['skillhub:pdf-tools']);
	assert.match(fetchImpl.calls[0].url, /keyword=pdf/);
});

test('a skillhub archive without SKILL.md is refused instead of written', async () => {
	const fetchImpl = fakeFetch([
		['api.skillhub.cn/api/v1/download?slug=ghost', () => new Response(skillZip([['README.md', '# nothing\n']]), { status: 200 })],
	]);
	const market = createSkillMarket({ fetchImpl });
	const item = {
		id: 'skillhub:ghost',
		source: 'skillhub',
		name: 'ghost',
		installable: true,
		install: { kind: 'skillhub-zip', slug: 'ghost' },
	};
	const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'skm-missing-'));
	try {
		await assert.rejects(() => market.install({ item, targetDir: path.join(parent, 'skill') }), /SKILL\.md/);
	} finally {
		await fs.rm(parent, { recursive: true, force: true });
	}
});

test('one dead source keeps its error while the others still list', async () => {
	const fetchImpl = fakeFetch([
		['clawhub.ai/api/v1/skills', () => new Response('upstream on fire', { status: 500 })],
		['/repos/anthropics/skills/contents/skills', () => json([{ name: 'pdf', type: 'dir' }])],
		['/skills/pdf/SKILL.md', () => new Response('---\nname: pdf\n---\n', { status: 200 })],
		['api.skillhub.cn/api/skills?', () => json({ code: 0, data: { skills: [], total: 0 } })],
		['/search/repositories?', () => json({ total_count: 0, items: [] })],
	]);
	const market = createSkillMarket({ fetchImpl });
	const out = await market.list({ limit: 5 });
	const byId = Object.fromEntries(out.sources.map((row) => [row.id, row]));
	assert.match(byId.clawhub.error, /500/);
	assert.equal(byId.official.error, null);
	assert.equal(byId.official.count, 1);
	assert.equal(out.items[0].id, 'official:pdf');
});

test('github search uses the token for code search and stays anonymous without one', async () => {
	const repos = fakeFetch([
		[
			'/search/repositories?',
			json({ total_count: 1, items: [{ full_name: 'a/b', name: 'b', description: 'x', html_url: 'https://github.com/a/b' }] }),
		],
	]);
	const market = createSkillMarket({ fetchImpl: repos });
	const out = await market.list({ source: 'github', limit: 5 });
	assert.equal(out.items[0].id, 'github:a/b');
	assert.match(repos.calls[0].url, /topic%3Aagent-skills|topic:agent-skills/);
	assert.equal(repos.calls[0].headers.authorization, undefined);

	const code = fakeFetch([
		[
			'/search/code?',
			json({ total_count: 1, items: [{ name: 'SKILL.md', path: 'packages/pdf/SKILL.md', repository: { full_name: 'a/b', html_url: 'https://github.com/a/b' } }] }),
		],
	]);
	const withToken = createSkillMarket({ fetchImpl: code, token: 'ghp_test' });
	const found = await withToken.list({ source: 'github', query: 'pdf', limit: 5 });
	assert.equal(found.items[0].install.dir, 'packages/pdf');
	assert.equal(code.calls[0].headers.authorization, 'Bearer ghp_test');
});

test('a source that is not one of the four is answered, not fetched', async () => {
	const fetchImpl = fakeFetch([]);
	const market = createSkillMarket({ fetchImpl });
	const out = await market.list({ source: 'nope' });
	assert.equal(out.sources[0].error, 'unknown source');
	assert.deepEqual(out.items, []);
	assert.equal(fetchImpl.calls.length, 0);
});


test('SkillHub search bypasses browse cache and retains the upstream total', async () => {
  const seen = [];
  const market = createSkillMarket({ fetchImpl: async url => {
    seen.push(String(url)); const q = new URL(url).searchParams.get('keyword');
    return json({ data: { total: q ? 1 : 1000, skills: [{ slug: q || 'popular', name: q || 'popular', downloads: q ? 7 : 100 }] } });
  } });
  assert.equal((await market.list({ source: 'skillhub' })).sources[0].total, 1000);
  assert.equal((await market.list({ source: 'skillhub' })).sources[0].total, 1000);
  const result = await market.list({ source: 'skillhub', query: 'outside-cache' });
  assert.equal(result.items[0].id, 'skillhub:outside-cache');
  assert.equal(seen.length, 2);
  assert.match(seen.at(-1), /keyword=outside-cache/);
});

test('visible Skill statistics refresh, preserve failures, match publishers and accept zero measurements', async () => {
  let downloads = 10; let fail = false; let calls = 0;
  const item = { id: 'clawhub:publisher/demo', name: 'demo', source: 'clawhub', downloads: 1, install: { slug: 'demo', owner: 'publisher' } };
  const market = createSkillMarket({ fetchImpl: async url => {
    calls++; assert.match(String(url), /ownerHandle=publisher/);
    if (fail) return json({ message: 'temporary failure' }, 503);
    return json({ owner: { handle: 'publisher' }, skill: { slug: 'demo', stats: { downloads, stars: 0 } } });
  } });
  let result = await market.metrics({ items: [item] });
  assert.equal(result.items[item.id].downloads, 10);
  downloads = 20;
  assert.equal((await market.metrics({ items: [item] })).items[item.id].downloads, 10);
  assert.equal(calls, 1);
  result = await market.metrics({ items: [item], refresh: true });
  assert.equal(result.items[item.id].downloads, 20);
  assert.equal(result.items[item.id].stars, 0);
  fail = true;
  result = await market.metrics({ items: [item], refresh: true });
  assert.equal(result.items[item.id].downloads, 20);
  assert.equal(result.items[item.id].metrics.stale, true);
  assert.match(result.errors[0].message, /503/);
  fail = false; downloads = 30;
  assert.equal((await market.metrics({ items: [item] })).items[item.id].downloads, 30);
  const hub = createSkillMarket({ fetchImpl: async () => json({ data: { total: 2, skills: [
    { slug: 'demo', name: 'demo', ownerName: 'wrong', downloads: 999 },
    { slug: 'demo', name: 'demo', ownerName: 'right', downloads: 42 },
  ] } }) });
  assert.equal((await hub.metrics({ items: [{ id: 'skillhub:demo', source: 'skillhub', owner: 'right', name: 'demo' }] })).items['skillhub:demo'].downloads, 42);
  const ambiguous = await hub.metrics({ items: [{ id: 'skillhub:demo', source: 'skillhub', name: 'demo' }], refresh: true });
  assert.match(ambiguous.errors[0].message, /同名技能/);
  assert.equal(ambiguous.items['skillhub:demo'].downloads, undefined, 'a different publisher identity must not inherit cached counters');
});

test('a cached metrics read does not cancel in-flight refresh and partial fields preserve measurements', async () => {
  const item = { id: 'clawhub:publisher/demo', source: 'clawhub', name: 'demo', downloads: 1, install: { slug: 'demo', owner: 'publisher' } };
  let release; let hold = false; let stats = { downloads: 120, stars: 1 };
  const response = () => json({ owner: { handle: 'publisher' }, skill: { slug: 'demo', stats } });
  const market = createSkillMarket({ fetchImpl: async () => hold ? new Promise(resolve => { release = resolve; }) : response() });
  await market.metrics({ items: [item] });
  hold = true;
  const pending = market.metrics({ items: [item], refresh: true });
  assert.equal((await market.metrics({ items: [item] })).items[item.id].downloads, 120);
  stats = { downloads: 140, stars: 2 }; release(response()); await pending;
  assert.equal(market.applyMetrics([item])[0].downloads, 140);
  hold = false; stats = { stars: 3 };
  const partial = await market.metrics({ items: [item], refresh: true });
  assert.equal(partial.items[item.id].downloads, 140);
  assert.equal(partial.items[item.id].stars, 3);
  assert.match(partial.errors[0].message, /下载量/);
  assert.equal(market.applyMetrics([item])[0].metrics.stale, true);
});

test('Skill statistics reject a mismatched publisher and isolate obsolete quota responses', async () => {
  const item = { id: 'clawhub:publisher/demo', source: 'clawhub', name: 'demo', install: { slug: 'demo', owner: 'publisher' } };
  const invalid = createSkillMarket({ fetchImpl: async () => json({ owner: { handle: 'someone-else' }, skill: { slug: 'demo', stats: { downloads: 999 } } }) });
  const rejected = await invalid.metrics({ items: [item] });
  assert.match(rejected.errors[0].message, /发布者/);
  assert.equal(rejected.items[item.id].downloads, undefined);
  let auth = ''; const waiting = []; let calls = 0;
  const market = createSkillMarket({ metricsAuthKey: () => auth, fetchImpl: async () => {
    calls++; if (!auth) return new Promise(resolve => waiting.push(resolve));
    return json({ stargazers_count: 200 });
  } });
  const repo = { id: 'github:audit/repo', source: 'github', install: { repo: 'audit/repo' } };
  const old = market.metrics({ items: [repo], refresh: true });
  auth = 'authenticated';
  await market.metrics({ items: [repo], refresh: true });
  waiting[0](json({ message: 'rate limit exceeded' }, 429)); await old;
  const fresh = await market.metrics({ items: [repo], refresh: true });
  assert.equal(fresh.items[repo.id].stars, 200);
  assert.deepEqual(fresh.errors, []);
  assert.equal(calls, 3);
});
