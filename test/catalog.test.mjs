// test/catalog.test.mjs — pure-logic tests for lib/catalog.js (fetch mocked)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  browseCatalog, catalogItemToEntry, fetchAwesomeList,
  fetchAwesomeRemote, fetchDockerCatalog, githubReposOf, fetchRepoStats,
  functionalGroupOf, inferGroupOf, groupSourceOf,
} from '../lib/catalog.js';

// The companion list of *hosted* endpoints: `- [Title](home) \`url\`` with an
// indented continuation line carrying the auth flag and description.
const REMOTE_MD = [
  '## Servers',
  '',
  '### 🗄️ <a name="databases"></a>Databases',
  '',
  '- [Neon](https://neon.com) `https://mcp.neon.com/mcp`',
  '  [![Neon MCP connector](https://glama.ai/mcp/connectors/neon/badges/score.svg)](https://glama.ai/mcp/connectors/neon)',
  '  🔓 - Serverless Postgres for your agents, with branching',
  '- [SecureDB](https://securedb.dev) `https://securedb.dev/mcp`',
  '  🔐 - Managed database behind a token',
  '',
].join('\n');

const DOCKER_JSON = {
  count: 2,
  next: null,
  results: [
    { name: 'mcp/fetch', namespace: 'mcp', description: 'Fetches a URL and extracts contents as markdown', pull_count: 1908722, star_count: 58, is_official: true },
    { name: 'mcp/community-registry', namespace: 'mcp', description: 'Community registry bridge', pull_count: 12, is_official: false, affiliation: 'COMMUNITY' },
  ],
};

// The real README shape: `### <emoji> <category>` sections whose entries are
// `- [owner/repo](url) [![badge](svg)](glama) <flags> - <description>`.
const AWESOME_MD = [
  '# Awesome MCP Servers',
  '',
  '* [What is MCP?](#what-is-mcp)',
  '',
  '## Server Implementations',
  '',
  '### 🗄️ <a name="databases"></a>Databases',
  '',
  '- [acme/pg-mcp](https://github.com/acme/pg-mcp) [![acme/pg-mcp MCP server](https://glama.ai/mcp/servers/acme/pg-mcp/badges/score.svg)](https://glama.ai/mcp/servers/acme/pg-mcp) 🐍 🏠 - Query PostgreSQL databases locally',
  '- [acme/pg-mcp](https://github.com/acme/pg-mcp) 🐍 - Duplicate row that must be deduped',
  '',
  '### 📂 Browser Automation',
  '',
  '- [other/browser-mcp](https://github.com/other/browser-mcp) 📇 ☁️ 🍎 - Drive a browser in the cloud',
  '',
  '| Server | Description |',
  '| --- | --- |',
  '| [Sample Server](https://github.com/x/sample) | A legacy table-shaped entry |',
].join('\n');

// The live sources all answer through the same fetchImpl: official registry and
// Smithery are JSON, the two awesome-lists are markdown, Docker is JSON.
const okFetch = async (url) => {
  const href = String(url);
  if (href.includes('awesome-remote-mcp-servers')) {
    return { ok: true, text: async () => REMOTE_MD, json: async () => ({}) };
  }
  if (href.includes('awesome-mcp-servers')) {
    return { ok: true, text: async () => AWESOME_MD, json: async () => ({}) };
  }
  if (href.includes('hub.docker.com')) {
    return { ok: true, text: async () => '', json: async () => DOCKER_JSON };
  }
  if (href.includes('smithery')) {
    return {
      ok: true,
      json: async () => ({
        servers: [{
          qualifiedName: 'acme/pg', displayName: 'PG Smithery', description: 'postgres over smithery',
          useCount: 12000, verified: true, remote: true, iconUrl: 'https://api.smithery.ai/servers/acme/pg/icon',
          homepage: 'https://github.com/acme/pg-mcp',
        }],
      }),
    };
  }
  return {
    ok: true,
    text: async () => '',
    json: async () => ({
      servers: [
        { server: { name: 'filesystem', title: 'Filesystem', description: 'fs access', packages: [{ registry_type: 'npm', identifier: '@modelcontextprotocol/server-filesystem' }] } },
        { server: { name: 'search', title: 'Search', description: 'web search', remotes: [{ type: 'streamable-http', url: 'https://h/mcp' }] } },
      ],
      metadata: {},
    }),
  };
};

test('browseCatalog merges and matches a query', async () => {
  const { items, errors } = await browseCatalog({ query: 'search', fetchImpl: okFetch });
  assert.equal(errors.length, 0);
  assert.ok(items.length >= 1);
  assert.ok(items.every((i) => /search/i.test(i.title + i.description + (i.author ?? ''))));
});

test('browseCatalog degrades on source failure', async () => {
  const failing = async () => { throw new Error('boom'); };
  const { items, errors } = await browseCatalog({ fetchImpl: failing });
  assert.equal(items.length, 0);
  // One error per configured source — a dead catalog never hides the others.
  assert.equal(errors.length, 5);
  assert.equal(errors[0].message, 'boom');
});

test('catalogItemToEntry builds stdio entry from npm package', () => {
  const item = {
    title: 'Filesystem',
    source: 'official-registry',
    install: { transport: 'stdio', command: 'npx', args: ['-y', '@mcp/fs'] },
  };
  const e = catalogItemToEntry(item);
  assert.equal(e.transport, 'stdio');
  assert.equal(e.command, 'npx');
  assert.equal(e.source, 'catalog:official-registry');
});

test('catalogItemToEntry returns null for unknown transport', () => {
  assert.equal(catalogItemToEntry({ title: 'x', install: { transport: 'unknown', repo: 'u' } }), null);
  assert.equal(catalogItemToEntry({ title: 'x' }), null);
});

test('browseCatalog lists without a query, merging every default source', async () => {
  const { items, errors, counts, total } = await browseCatalog({ fetchImpl: okFetch });
  assert.equal(errors.length, 0);
  assert.equal(counts['official-registry'], 2);
  assert.equal(counts.smithery, 1);
  assert.equal(counts['docker-catalog'], 2);
  assert.equal(counts['awesome-remote'], 2);
  assert.equal(counts['awesome-list'], 3);
  // acme/pg-mcp is one server seen by smithery + awesome-list -> merged once
  assert.equal(items.filter((i) => i.repository === 'https://github.com/acme/pg-mcp').length, 1);
  assert.equal(total, items.length);
});

test('official registry items unwrap the nested `server` record', async () => {
  const { items } = await browseCatalog({ fetchImpl: okFetch, source: 'official-registry' });
  const fs = items.find((i) => i.title === 'Filesystem');
  assert.ok(fs);
  assert.equal(fs.transport, 'stdio');
  assert.equal(fs.install.command, 'npx');
  const search = items.find((i) => i.title === 'Search');
  assert.equal(search.transport, 'streamable-http');
  assert.equal(search.install.url, 'https://h/mcp');
});

test('browseCatalog filters by query and respects limit', async () => {
  const all = await browseCatalog({ fetchImpl: okFetch, limit: 1 });
  assert.equal(all.items.length, 1);
  const search = await browseCatalog({ fetchImpl: okFetch, query: 'web' });
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].title, 'Search');
});

test('browseCatalog can restrict to one source and degrades on failure', async () => {
  const failing = async () => { throw new Error('offline'); };
  const { items, errors } = await browseCatalog({ fetchImpl: failing, source: 'smithery' });
  assert.equal(items.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].source, 'smithery');
});

// --- awesome-list parsing ---------------------------------------------------

test('awesome-list ignores badge links and keeps the real repository', async () => {
  const { items } = await fetchAwesomeList({ text: AWESOME_MD });
  const pg = items.find((i) => i.title === 'pg-mcp');
  assert.ok(pg, 'the repository name is the card title');
  assert.equal(pg.repository, 'https://github.com/acme/pg-mcp');
  assert.equal(pg.author, 'acme');
  assert.equal(pg.icon, 'https://github.com/acme.png?size=80');
  assert.ok(!/glama\.ai\/mcp\/servers\/acme\/pg-mcp\/badges/.test(pg.description), 'no badge URL leaks into the description');
  assert.equal(pg.description, 'Query PostgreSQL databases locally');
});

test('awesome-list carries category and legend tags', async () => {
  const { items } = await fetchAwesomeList({ text: AWESOME_MD });
  const pg = items.find((i) => i.title === 'pg-mcp');
  assert.deepEqual(pg.tags, ['Databases', 'Python', '本地']);
  const browser = items.find((i) => i.title === 'browser-mcp');
  assert.deepEqual(browser.tags, ['Browser Automation', 'TypeScript', '云服务', 'macOS']);
});

test('awesome-list dedupes repeated repositories and still parses table rows', async () => {
  const { items } = await fetchAwesomeList({ text: AWESOME_MD });
  assert.equal(items.filter((i) => i.title === 'pg-mcp').length, 1);
  const sample = items.find((i) => i.title === 'sample');
  assert.ok(sample, 'legacy table-shaped rows are still understood');
  assert.equal(sample.description, 'A legacy table-shaped entry');
});

test('browseCatalog ranks installable entries above discovery-only ones', async () => {
  const { items } = await browseCatalog({ fetchImpl: okFetch, source: 'smithery' });
  assert.ok(items.every((i) => i.install));
  const awesomeOnly = await browseCatalog({ fetchImpl: okFetch, source: 'awesome-list' });
  assert.ok(awesomeOnly.items.every((i) => i.install === null));
});

test('the combined listing interleaves sources so no catalog is buried', async () => {
  const { items } = await browseCatalog({ fetchImpl: okFetch });
  // The community index is by far the biggest source here; without interleaving
  // its rows would never reach the top of the page.
  const firstFive = items.slice(0, 5).map((i) => i.source);
  assert.equal([...new Set(firstFive)].length, 5, `expected one card per source, got ${firstFive.join(', ')}`);
});

test('official registry titles fall back to the readable name segment', async () => {
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('awesome-mcp-servers')) return { ok: true, text: async () => '', json: async () => ({}) };
    if (href.includes('smithery')) return { ok: true, json: async () => ({ servers: [] }) };
    return {
      ok: true,
      json: async () => ({
        servers: [{ server: { name: 'ac.snag/snag', description: 'evidence capture', remotes: [{ url: 'https://mcp.snag.ac/mcp' }] } }],
        metadata: {},
      }),
    };
  };
  const { items } = await browseCatalog({ fetchImpl, source: 'official-registry' });
  assert.equal(items[0].title, 'snag');
  assert.equal(items[0].author, 'ac.snag');
});

test('the registry keeps one record per server, preferring the registry own isLatest flag', async () => {
  // The official registry stores one record per published VERSION, so a full
  // walk returns thousands of rows for a few thousand servers. Dedupe must keep
  // exactly one per name, and the one the registry itself marks latest.
  const fetchImpl = async () => ({
    ok: true,
    text: async () => '',
    json: async () => ({
      servers: [
        { _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: false, updatedAt: '2026-01-01T00:00:00Z' } }, server: { name: 'acme/one', title: 'One', version: '1.0.0', description: 'old' } },
        { _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: true, updatedAt: '2026-02-01T00:00:00Z' } }, server: { name: 'acme/one', title: 'One', version: '1.1.0', description: 'current' } },
        { _meta: { 'io.modelcontextprotocol.registry/official': { isLatest: false, updatedAt: '2026-01-15T00:00:00Z' } }, server: { name: 'acme/two', title: 'Two', version: '2.3.0', description: 'only record' } },
      ],
      metadata: {},
    }),
  });
  const { items } = await browseCatalog({ fetchImpl, source: 'official-registry' });
  assert.equal(items.length, 2, 'one row per server name');
  assert.equal(new Set(items.map((i) => i.raw.name)).size, 2);
  const one = items.find((i) => i.raw.name === 'acme/one');
  assert.equal(one.version, '1.1.0', 'the isLatest record wins over the older one');
  assert.equal(one.description, 'current');
  assert.equal(one.isLatest, true);
});

test('registry dedupe falls back to updatedAt when isLatest is absent', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => '',
    json: async () => ({
      servers: [
        { _meta: { 'io.modelcontextprotocol.registry/official': { updatedAt: '2026-01-01T00:00:00Z' } }, server: { name: 'a/x', title: 'X', version: '1.0.0', description: 'older' } },
        { _meta: { 'io.modelcontextprotocol.registry/official': { updatedAt: '2026-03-01T00:00:00Z' } }, server: { name: 'a/x', title: 'X', version: '1.2.0', description: 'newer' } },
      ],
      metadata: {},
    }),
  });
  const { items } = await browseCatalog({ fetchImpl, source: 'official-registry' });
  assert.equal(items.length, 1);
  assert.equal(items[0].version, '1.2.0');
  assert.equal(items[0].description, 'newer');
});

test('registry dedupe breaks an updatedAt tie on version', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => '',
    json: async () => ({
      servers: [
        { _meta: { 'io.modelcontextprotocol.registry/official': { updatedAt: '2026-01-01T00:00:00Z' } }, server: { name: 'a/y', title: 'Y', version: '1.0.0', description: 'low' } },
        { _meta: { 'io.modelcontextprotocol.registry/official': { updatedAt: '2026-01-01T00:00:00Z' } }, server: { name: 'a/y', title: 'Y', version: '2.10.0', description: 'high' } },
      ],
      metadata: {},
    }),
  });
  const { items } = await browseCatalog({ fetchImpl, source: 'official-registry' });
  assert.equal(items.length, 1);
  assert.equal(items[0].version, '2.10.0', 'numeric compare, so 2.10 beats 1.0 and 2.9');
});

test('smithery items expose installs, icon and verification for the card', async () => {
  const { items } = await browseCatalog({ fetchImpl: okFetch, source: 'smithery' });
  const pg = items[0];
  assert.equal(pg.installs, 12000);
  assert.equal(pg.verified, true);
  assert.equal(pg.icon, 'https://api.smithery.ai/servers/acme/pg/icon');
  assert.equal(pg.install.command, 'npx');
});

// --- lifecycle (deprecation) ------------------------------------------------

test('a registry status of deprecated is carried through as a deprecation', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => '',
    json: async () => ({
      servers: [{
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'deprecated', statusMessage: 'Superseded by acme/two.', statusChangedAt: '2026-05-07T16:29:51Z', isLatest: true } },
        server: { name: 'acme/one', title: 'One', version: '1.0.0', description: 'old', remotes: [{ url: 'https://one/mcp' }] },
      }],
      metadata: {},
    }),
  });
  const { items } = await browseCatalog({ fetchImpl, source: 'official-registry' });
  assert.equal(items[0].deprecated, true);
  assert.equal(items[0].status, 'deprecated');
  assert.equal(items[0].statusMessage, 'Superseded by acme/two.');
  // Still installable — a deprecation is a warning, not a removal.
  assert.ok(items[0].install);
});

test('an active registry status is not marked deprecated', async () => {
  const fetchImpl = async () => ({
    ok: true,
    text: async () => '',
    json: async () => ({
      servers: [{
        _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } },
        server: { name: 'acme/one', title: 'One', version: '1.0.0', description: 'live', remotes: [{ url: 'https://one/mcp' }] },
      }],
      metadata: {},
    }),
  });
  const { items } = await browseCatalog({ fetchImpl, source: 'official-registry' });
  assert.equal(items[0].status, 'active');
  assert.equal(items[0].deprecated, undefined);
});

test('sources that publish no lifecycle field leave status absent, not active', async () => {
  // awesome-list and awesome-remote carry no lifecycle data. Claiming "active"
  // for them would be an invention, and the UI must be able to tell the
  // difference between "checked and fine" and "nobody looked".
  const { items } = await fetchAwesomeList({ text: AWESOME_MD });
  assert.equal(items[0].status, undefined);
  assert.equal(items[0].deprecated, undefined);
  const { items: remote } = await fetchAwesomeRemote({ text: REMOTE_MD });
  assert.equal(remote[0].status, undefined);
  assert.equal(remote[0].deprecated, undefined);
});

test('an inactive Smithery entry is a deprecation; an unlisted one is not', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      servers: [
        { qualifiedName: 'a/off', displayName: 'Off', description: 'gone', inactive: true },
        { qualifiedName: 'a/hidden', displayName: 'Hidden', description: 'hidden but working', unlisted: true },
      ],
    }),
  });
  const { items } = await browseCatalog({ fetchImpl, source: 'smithery' });
  const off = items.find((i) => i.title === 'Off');
  const hidden = items.find((i) => i.title === 'Hidden');
  assert.equal(off.deprecated, true);
  assert.equal(off.status, 'inactive');
  assert.equal(hidden.deprecated, undefined);
  assert.equal(hidden.status, 'unlisted');
});

test('a deprecated entry ranks below an otherwise identical live one', async () => {
  const mk = (name, meta, desc) => ({
    _meta: { 'io.modelcontextprotocol.registry/official': meta },
    server: { name, title: name, version: '1.0.0', description: desc, remotes: [{ url: `https://${name}/mcp` }] },
  });
  const fetchImpl = async () => ({
    ok: true,
    text: async () => '',
    json: async () => ({
      servers: [
        mk('z/live', { status: 'active', isLatest: true }, 'live one'),
        mk('a/dead', { status: 'deprecated', isLatest: true }, 'deprecated one'),
      ],
      metadata: {},
    }),
  });
  const { items } = await browseCatalog({ fetchImpl, source: 'official-registry' });
  assert.equal(items[0].raw.name, 'z/live', 'the live entry is offered first');
  assert.equal(items[1].raw.name, 'a/dead');
});

// --- metric semantics -------------------------------------------------------

test('each popularity number carries its own unit and window', async () => {
  const { items: sm } = await browseCatalog({ fetchImpl: okFetch, source: 'smithery' });
  assert.equal(sm[0].installsLabel, '次启动', 'Smithery counts launches on its platform');
  const docker = await fetchDockerCatalog({ fetchImpl: async () => ({ ok: true, json: async () => DOCKER_JSON, text: async () => '' }) });
  assert.equal(docker.items[0].installsLabel, '次拉取');
  assert.equal(docker.items[0].installsWindow, '累计', 'Docker reports lifetime pulls, not a rolling window');
});

test('the official registry publishes no popularity field at all', async () => {
  const { items } = await browseCatalog({ fetchImpl: okFetch, source: 'official-registry' });
  for (const item of items) {
    assert.equal(item.installs, undefined, 'never fabricate a number the source does not publish');
    assert.equal(item.installsLabel, undefined);
  }
});

test('merging keeps the unit attached to its number', async () => {
  // A GitHub-backed Smithery row (useCount, launches) merged with the same
  // repo's awesome-list row must not inherit the wrong label.
  const { items } = await browseCatalog({ fetchImpl: okFetch });
  const pg = items.find((i) => i.repository === 'https://github.com/acme/pg-mcp');
  assert.ok(pg.install);
  assert.equal(pg.installs, 12000);
  assert.equal(pg.installsLabel, '次启动');
});

// --- awesome-remote parsing -------------------------------------------------

test('awesome-remote rows are directly installable hosted endpoints', async () => {
  const { items } = await fetchAwesomeRemote({ text: REMOTE_MD });
  assert.equal(items.length, 2);
  const neon = items.find((i) => i.title === 'Neon');
  assert.equal(neon.transport, 'streamable-http');
  assert.deepEqual(neon.install, { transport: 'streamable-http', url: 'https://mcp.neon.com/mcp' });
  assert.equal(neon.description, 'Serverless Postgres for your agents, with branching');
  assert.deepEqual(neon.tags, ['Databases', '免登录']);
  assert.equal(neon.author, 'mcp.neon.com');
  assert.equal(neon.homepage, 'https://neon.com');
});

test('awesome-remote flags credential-gated endpoints and skips the badge link', async () => {
  const { items } = await fetchAwesomeRemote({ text: REMOTE_MD });
  const secure = items.find((i) => i.title === 'SecureDB');
  assert.deepEqual(secure.tags, ['Databases', '需登录']);
  assert.equal(secure.install.url, 'https://securedb.dev/mcp');
  assert.ok(!/glama\.ai\/mcp\/connectors/.test(JSON.stringify(items)), 'badge URLs never leak');
});

// --- category field ---------------------------------------------------------

test('awesome rows carry their heading as a first-class category', async () => {
  const { items } = await fetchAwesomeList({ text: AWESOME_MD });
  const pg = items.find((i) => i.title === 'pg-mcp');
  assert.equal(pg.category, 'Databases');
  assert.equal(pg.tags[0], 'Databases', 'the heading stays the first display tag too');
  const remote = await fetchAwesomeRemote({ text: REMOTE_MD });
  assert.equal(remote.items[0].category, 'Databases');
});

test('the registries publish no category, and none is invented for them', async () => {
  const { items } = await browseCatalog({ fetchImpl: okFetch, source: 'official-registry' });
  for (const item of items) assert.equal(item.category, undefined);
  const smithery = await browseCatalog({ fetchImpl: okFetch, source: 'smithery' });
  for (const item of smithery.items) assert.equal(item.category, undefined);
});

test('a merge that promotes a registry record keeps the community category', async () => {
  // acme/pg-mcp exists in both Smithery (installable, wins the merge) and the
  // community index (carries the category). The winner must still be findable
  // under the category filter.
  const { items } = await browseCatalog({ fetchImpl: okFetch });
  const pg = items.find((i) => i.repository === 'https://github.com/acme/pg-mcp');
  assert.equal(pg.source, 'smithery', 'sanity: the installable record won');
  assert.equal(pg.category, 'Databases', 'the losing record category survived the merge');
});

test('the category filter counts come from the listing itself', async () => {
  const { items } = await browseCatalog({ fetchImpl: okFetch });
  const counts = new Map();
  let uncategorized = 0;
  for (const item of items) {
    if (item.category) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    else uncategorized += 1;
  }
  // The fixtures: Databases holds pg-mcp (awesome-list, merged with its
  // Smithery twin) plus Neon and SecureDB from the remote list; Browser
  // Automation holds browser-mcp and the legacy table row (which sits under
  // the same heading); everything else uncategorized.
  assert.equal(counts.get('Databases'), 3);
  assert.equal(counts.get('Browser Automation'), 2);
  assert.ok(uncategorized > 0, 'registry/smithery entries land in the uncategorized bucket');
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0) + uncategorized, items.length);
});

// --- functional grouping ----------------------------------------------------

test('synonym headings consolidate into one functional group', async () => {
  // Finance & Fintech (awesome-list) and Finance (awesome-remote) are the same
  // function under two upstream spellings; the chip row must offer them as one.
  const local = [
    '## Server Implementations',
    '',
    '### 💰 <a name="finance"></a>Finance & Fintech',
    '',
    '- [acme/ledger-mcp](https://github.com/acme/ledger-mcp) 📇 - Double-entry bookkeeping',
    '',
  ].join('\n');
  const remote = [
    '## Servers',
    '',
    '### 💰 <a name="finance"></a>Finance',
    '',
    '- [Ledger Cloud](https://ledger.example) `https://mcp.ledger.example`',
    '  🔓 - Hosted bookkeeping',
    '',
  ].join('\n');
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('awesome-remote-mcp-servers')) return { ok: true, text: async () => remote, json: async () => ({}) };
    if (href.includes('awesome-mcp-servers')) return { ok: true, text: async () => local, json: async () => ({}) };
    if (href.includes('hub.docker.com')) return { ok: true, text: async () => '', json: async () => ({ results: [], count: 0, next: null }) };
    if (href.includes('smithery')) return { ok: true, json: async () => ({ servers: [] }) };
    return { ok: true, text: async () => '', json: async () => ({ servers: [], metadata: {} }) };
  };
  const { items } = await browseCatalog({ fetchImpl });
  const finance = items.filter((i) => i.group === '金融支付');
  assert.equal(finance.length, 2, 'both spellings land in the one group');
  assert.deepEqual(new Set(finance.map((i) => i.category)), new Set(['Finance & Fintech', 'Finance']),
    'the raw heading survives on each item for display');
});

test('every item with a heading lands in exactly one group; registry entries are inferred or bare', async () => {
  const { items } = await browseCatalog({ fetchImpl: okFetch });
  for (const item of items) {
    if (item.category) {
      assert.ok(typeof item.group === 'string' && item.group.length > 0, `${item.title}: heading ${item.category} produced no group`);
      assert.equal(item.groupSource, 'upstream', `${item.title}: a heading is not an inference`);
    } else {
      // The registries publish no category: the group is either read out of the
      // entry's own words (and marked as our reading) or absent entirely —
      // never a silent guess presented as the source's own heading.
      if (item.group === undefined) assert.equal(item.groupSource, undefined, `${item.title}: a bare entry cannot have a group source`);
      else assert.equal(item.groupSource, 'inferred', `${item.title}: registry groups must be labelled inferred`);
    }
  }
});

test('an unmapped heading degrades into 其他 instead of vanishing', async () => {
  // A heading the table does not name must still be filterable — upstream adds
  // new sections without asking us.
  const custom = AWESOME_MD.replace('### 🗄️ <a name="databases"></a>Databases', '### 🗄️ <a name="databases"></a>Brand New Heading');
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.includes('awesome-remote-mcp-servers')) return { ok: true, text: async () => REMOTE_MD, json: async () => ({}) };
    if (href.includes('awesome-mcp-servers')) return { ok: true, text: async () => custom, json: async () => ({}) };
    if (href.includes('hub.docker.com')) return { ok: true, text: async () => '', json: async () => DOCKER_JSON };
    if (href.includes('smithery')) return { ok: true, json: async () => ({ servers: [] }) };
    return { ok: true, text: async () => '', json: async () => ({ servers: [], metadata: {} }) };
  };
  const { items } = await browseCatalog({ fetchImpl });
  const pg = items.find((i) => i.title === 'pg-mcp');
  assert.equal(pg.category, 'Brand New Heading');
  assert.equal(pg.group, '其他', 'unknown headings fall through to 其他, never to undefined');
});

// --- mirror fallback --------------------------------------------------------

test('the awesome READMEs fall through to a CDN mirror when GitHub is blocked', async () => {
  // This network class is real: github.com and raw.githubusercontent.com both
  // TCP-time-out while the registries answer. The fetcher must walk the mirror
  // chain and succeed on whichever node is reachable.
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(new URL(String(url)).hostname);
    if (String(url).includes('githubusercontent.com')) throw new Error('fetch failed');
    if (String(url).startsWith('https://cdn.jsdelivr.net')) throw new Error('fetch failed');
    if (String(url).startsWith('https://fastly.jsdelivr.net')) throw new Error('fetch failed');
    return { ok: true, text: async () => REMOTE_MD, json: async () => ({}) };
  };
  const { items } = await fetchAwesomeRemote({ limit: 5, fetchImpl });
  assert.equal(items.length, 2);
  assert.deepEqual(tried, [
    'raw.githubusercontent.com',
    'cdn.jsdelivr.net',
    'fastly.jsdelivr.net',
    'testingcf.jsdelivr.net',
  ], 'mirrors are tried in trust order');
});

test('an awesome source that fails on every mirror names all of them', async () => {
  const fetchImpl = async () => { throw new Error('fetch failed'); };
  await assert.rejects(
    () => fetchAwesomeList({ limit: 5, fetchImpl }),
    /all mirrors failed/,
  );
});


// --- Docker MCP catalog -----------------------------------------------------

test('docker catalog rows become docker-run installs with pull counts', async () => {
  const { items } = await fetchDockerCatalog({ fetchImpl: async () => ({ ok: true, json: async () => DOCKER_JSON, text: async () => '' }) });
  assert.equal(items.length, 2);
  const fetchServer = items.find((i) => i.title === 'fetch');
  assert.equal(fetchServer.source, 'docker-catalog');
  assert.equal(fetchServer.installs, 1908722);
  assert.deepEqual(fetchServer.install, { transport: 'stdio', command: 'docker', args: ['run', '-i', '--rm', 'mcp/fetch'] });
  assert.equal(fetchServer.verified, true, 'official images are flagged verified');
  assert.equal(fetchServer.repository, 'https://hub.docker.com/r/mcp/fetch');
});

test('docker catalog stops when the upstream reports no next page', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ ...DOCKER_JSON, next: null }), text: async () => '' }; };
  const { items } = await fetchDockerCatalog({ fetchImpl, pages: 3 });
  assert.equal(calls, 1, 'no wasted follow-up pages');
  assert.equal(items.length, 2);
});

// --- GitHub enrichment ------------------------------------------------------

test('githubReposOf dedupes and bounds the enrichment set', () => {
  const repos = githubReposOf([
    { repository: 'https://github.com/a/one' },
    { repository: 'https://github.com/a/one.git' },
    { repository: 'https://github.com/b/two' },
    { repository: 'https://example.com/not-github' },
  ]);
  assert.deepEqual(repos.map((r) => r.key), ['a/one', 'b/two']);
  assert.equal(githubReposOf([{ repository: 'https://github.com/a/one' }, { repository: 'https://github.com/b/two' }], 1).length, 1);
});

test('fetchRepoStats reports stars per repo and degrades per repo', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('api.github.com/repos/a/one')) {
      return { ok: true, json: async () => ({ stargazers_count: 4321, owner: { login: 'a', avatar_url: 'av' }, description: 'One', topics: ['mcp'], homepage: 'https://one.dev' }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const stats = await fetchRepoStats([{ key: 'a/one', owner: 'a', repo: 'one' }, { key: 'b/two', owner: 'b', repo: 'two' }], { fetchImpl });
  assert.equal(stats['a/one'].stars, 4321);
  assert.equal(stats['a/one'].avatar, 'av');
  assert.deepEqual(stats['a/one'].topics, ['mcp']);
  assert.equal(stats['b/two'], undefined, 'a failing repo is simply absent, never fabricated');
});

test('fetchRepoStats flags the unauthenticated rate limit', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({ message: 'API rate limit exceeded' }) });
  const stats = await fetchRepoStats([{ key: 'a/one', owner: 'a', repo: 'one' }], { fetchImpl });
  assert.equal(stats.rateLimited, true);
  assert.equal(stats['a/one'], undefined);
});

test('fetchRepoStats does not confuse an ordinary 404 with a rate limit', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, json: async () => ({}) });
  const stats = await fetchRepoStats([{ key: 'a/one', owner: 'a', repo: 'one' }], { fetchImpl });
  assert.notEqual(stats.rateLimited, true);
});

// ---------------------------------------------------------------------------
// Functional group: the two community lists carry a heading, the two registries
// carry nothing at all. Those entries get a group inferred from their own words,
// marked `inferred` so the card can say it is our reading (see the第八轮/第十轮
// notes in INTEGRATION-TODO.md). These cases are real entries from the live
// registries, because the failure mode this replaces was a *plausible* wrong
// answer: 「server」 in every description put an MCP hiring service in 云与运维.
// ---------------------------------------------------------------------------

test('an upstream heading always wins over inference', () => {
  // Even when the description would infer something else.
  const item = { category: 'Databases', title: 'Brave Search', description: 'Search the web with Brave.' };
  assert.equal(functionalGroupOf(item), '数据与存储');
  assert.equal(groupSourceOf(item), 'upstream');
  // An unmapped upstream heading is 其他, not a guess: the source did say something.
  assert.equal(functionalGroupOf({ category: 'Some New Heading', title: 'x', description: 'search' }), '其他');
});

test('registry entries are inferred from title and description', () => {
  const cases = [
    [['Brave Search', "Search the web with Brave's independent index — web, news, images, and videos."], '搜索与知识'],
    [['Gmail', 'Read, search, and send Gmail messages. Manage drafts, threads, and labels; reply, forward, archive, trash, report spam, and triage your inbox.'], '办公协作'],
    [['Google Sheets', 'Search and inspect Google Sheets, create and edit spreadsheets, scan for data issues, review edit history.'], '办公协作'],
    [['GitHub', 'Connect your AI agents to GitHub — manage repos, issues, PRs, workflows, and more.'], '开发工具'],
    [['Neon', 'Serverless Postgres. Connect any MCP client directly to the same address.'], '数据与存储'],
    [['Exa Search', 'Fast, intelligent web search and web crawling. Get fresh information about libraries, APIs, and SDKs.'], '搜索与知识'],
    [['DevMatch', 'DevMatch is a MCP server for hiring engineers based on what they have actually built. Connect from Cursor, Claude Desktop, or any MCP-compatible AI assistant.'], '商业与法律'],
    [['1ClickWebsite', 'Build and edit WordPress websites for local service businesses and run Lead Gen demo-site batches.'], '开发工具'],
  ];
  for (const [[title, description], expected] of cases) {
    assert.equal(inferGroupOf({ title, description }), expected, `${title} should infer ${expected}`);
    assert.equal(groupSourceOf({ title, description }), 'inferred');
  }
});

test('a description that matches nothing stays uncategorized instead of guessing', () => {
  const item = { title: 'GENOSYS UAE', description: 'A thing that does stuff.' };
  assert.equal(inferGroupOf(item), undefined);
  assert.equal(functionalGroupOf(item), undefined);
  assert.equal(groupSourceOf(item), undefined);
});

test('inference is deterministic and title-weighted', () => {
  // Same input twice, same answer: no dependence on object key order.
  const item = { title: 'Aard', description: 'crypto wallet and search' };
  assert.equal(inferGroupOf(item), inferGroupOf({ ...item }));
  // The title outranks the description, which is what keeps a "Search" product
  // whose blurb mentions images out of 多媒体创作.
  assert.equal(inferGroupOf({ title: 'Search Thing', description: 'images and videos' }), '搜索与知识');
  // Weighted by phrase length: the two-word phrase beats the generic one.
  assert.equal(inferGroupOf({ title: 'x', description: 'google sheets search' }), '办公协作');
});
