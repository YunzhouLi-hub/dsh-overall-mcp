// test/index.test.mjs — the plugin's own contract, driven through a fake host.
//
// `apply(ctx)` is the whole plugin: it reads the registry, mounts servers, and
// registers the MCP tools plus the `/api/overall-mcp/*` routes the settings page
// uses. It had no unit coverage at all, which is how a tool description that
// contradicted its own code (overall_mcp_remove) and a row action that could
// take the wrong twin of a duplicated name survived review.
//
// The host is faked, not the code under test: `ctx.plugin` (the mcp-client
// mount) always throws, so every case exercises the *containment* path, and
// every case gets its own `DSH_HOME` so the real `~/.dsh/overall-mcp` is never
// read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// The two DSH peer packages are supplied by the harness at runtime and are not
// installed here; without this mapping `import('../index.js')` cannot resolve.
register('./hooks.mjs', import.meta.url);

/** Registry used by most cases: two rows share a name, plus a hand-added one. */
const FIXTURE = {
  version: 1,
  favorites: ['smithery:brave'],
  servers: [
    { name: 'rea-cursor', source: 'cursor', enabled: false, transport: 'stdio', command: 'npx', args: ['-y', 'rea-mcp@6.5.0'] },
    { name: 'rea-cursor', source: 'cursor', enabled: false, transport: 'stdio', command: 'npx', args: ['-y', 'rea-mcp@6.1.0'] },
    { name: 'fs', source: 'manual', enabled: false, transport: 'stdio', command: 'my-own-fs', args: ['--root', '.'] },
  ],
};

async function withHost(registry, run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'overall-mcp-contract-'));
  const dir = path.join(home, 'overall-mcp');
  await fs.mkdir(dir, { recursive: true });
  if (registry !== undefined) {
    const text = typeof registry === 'string' ? registry : JSON.stringify(registry, null, 2);
    await fs.writeFile(path.join(dir, 'registry.json'), text, 'utf8');
  }
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const { apply } = await import('../index.js');
    const routes = new Map();
    const tools = new Map();
    const ctx = {
      logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
      effect: () => () => {},
      // No mount in a unit test; a failed mount is a case the plugin must
      // contain (and, for an install, must not count as a successful one).
      plugin: () => { throw new Error('no mcp mount in this test'); },
      tools: {
        register(definition) { tools.set(definition.name, definition); return () => {}; },
        schemas: () => [],
      },
      inject(keys, callback) {
        if (keys.includes('connection')) {
          callback({ connection: { fetch: { register(config) { routes.set(config.path, config); } } } });
        } else {
          callback({});
        }
        return () => {};
      },
    };
    await apply(ctx);

    const call = async (route, { method = 'POST', body } = {}) => {
      const config = routes.get(route);
      assert.ok(config, `route ${route} is registered`);
      const response = await config.fetch(new Request(`http://127.0.0.1${route}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      }));
      return { status: response.status, body: await response.json() };
    };
    const registryText = () => fs.readFile(path.join(dir, 'registry.json'), 'utf8');
    const readRegistry = async () => JSON.parse(await registryText());
    const readInstalls = async () => {
      try { return JSON.parse(await fs.readFile(path.join(dir, 'installs.json'), 'utf8')); }
      catch { return { version: 1, entries: {} }; }
    };

    await run({ dir, routes, tools, call, readRegistry, readInstalls, registryText });
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await fs.rm(home, { recursive: true, force: true });
  }
}

test('the plugin registers the documented route and tool surface', async () => {
  await withHost(FIXTURE, async ({ routes, tools }) => {
    // The same list client/client.js documents at the top of the file: the page
    // and the host must not drift apart silently.
    for (const route of [
      '/api/overall-mcp/servers', '/api/overall-mcp/scan', '/api/overall-mcp/catalog',
      '/api/overall-mcp/repo-stats', '/api/overall-mcp/repo-media', '/api/overall-mcp/install',
      '/api/overall-mcp/favorite', '/api/overall-mcp/favorites', '/api/overall-mcp/set-enabled',
      '/api/overall-mcp/set-source-enabled', '/api/overall-mcp/updates', '/api/overall-mcp/self',
      '/api/overall-mcp/self-update', '/api/overall-mcp/update', '/api/overall-mcp/remove',
      '/api/overall-mcp/forget-orphans', '/api/overall-mcp/tools',
    ]) {
      assert.ok(routes.has(route), `${route} is registered`);
    }
    for (const tool of [
      'overall_mcp_scan', 'overall_mcp_list', 'overall_mcp_search', 'overall_mcp_install',
      'overall_mcp_set_enabled', 'overall_mcp_set_source_enabled', 'overall_mcp_catalog',
      'overall_mcp_check_updates', 'overall_mcp_update', 'overall_mcp_remove',
      'overall_mcp_forget_orphans',
    ]) {
      assert.ok(tools.has(tool), `${tool} is registered`);
    }
  });
});

/**
 * The market route reads the open catalogs over the global fetch. This stub
 * answers only Docker's repository listing, with a validator, and records what
 * each request carried — enough to prove the panel's read is conditional.
 */
function dockerFetchStub() {
  const calls = [];
  const DOCKER = {
    count: 2,
    next: null,
    results: [
      { name: 'mcp/fetch', namespace: 'mcp', description: 'Fetches a URL', pull_count: 10, is_official: true },
      { name: 'mcp/git', namespace: 'mcp', description: 'Git operations', pull_count: 5, is_official: true },
    ],
  };
  const stub = async (url, init = {}) => {
    const href = String(url);
    const ifNoneMatch = init?.headers?.['if-none-match'];
    calls.push({ url: href, ifNoneMatch });
    if (!href.includes('hub.docker.com')) throw new Error(`unexpected request to ${href}`);
    const headers = { get: (name) => (name === 'etag' ? '"docker-v1"' : undefined) };
    if (ifNoneMatch === '"docker-v1"') return { ok: false, status: 304, headers, json: async () => ({}) };
    return { ok: true, status: 200, headers, json: async () => DOCKER };
  };
  stub.calls = calls;
  return stub;
}

test('the market route reuses a listing inside the TTL and validates a forced refresh', async () => {
  const realFetch = globalThis.fetch;
  const stub = dockerFetchStub();
  globalThis.fetch = stub;
  try {
    await withHost(FIXTURE, async ({ call }) => {
      const first = await call('/api/overall-mcp/catalog', { body: { source: 'docker-catalog' } });
      assert.equal(first.status, 200);
      assert.equal(first.body.items.length, 2);
      assert.equal(first.body.sources['docker-catalog'].cached, false);
      assert.equal(first.body.sources['docker-catalog'].notModified, 0);
      assert.equal(first.body.cached, false, 'a cold read is not a cached one');
      assert.equal(stub.calls.length, 1);

      // Opening the tab again inside the TTL must not touch the network at all.
      const again = await call('/api/overall-mcp/catalog', { body: { source: 'docker-catalog' } });
      assert.equal(stub.calls.length, 1, 'no request inside the source TTL');
      assert.equal(again.body.cached, true);
      assert.equal(again.body.items.length, 2);

      // 刷新 skips the TTL — and still costs a validator, not a body.
      const forced = await call('/api/overall-mcp/catalog', { body: { source: 'docker-catalog', refresh: true } });
      assert.equal(stub.calls.length, 2);
      assert.equal(stub.calls[1].ifNoneMatch, '"docker-v1"', 'the forced read is conditional');
      assert.equal(forced.body.sources['docker-catalog'].notModified, 1);
      assert.equal(forced.body.notModified, 1);
      assert.equal(forced.body.items.length, 2);
      assert.equal(forced.body.cached, false, 'a forced read is a fresh read');
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the market route reports an unknown source as an error, not as an empty market', async () => {
  await withHost(FIXTURE, async ({ call }) => {
    const result = await call('/api/overall-mcp/catalog', { body: { source: 'nope' } });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.items, []);
    assert.deepEqual(result.body.errors, [{ source: 'nope', message: 'unknown catalog source: nope' }]);
    assert.deepEqual(result.body.sources.nope, { error: 'unknown catalog source: nope' });
    assert.equal(result.body.total, 0);
  });
});

test('a row action on a duplicated name is refused, and slot picks the row', async () => {
  await withHost(FIXTURE, async ({ call, readRegistry }) => {
    // Two rows named `rea-cursor`. Acting on "the name" used to remove the FIRST
    // one whatever the caller meant, and deleting real bookkeeping silently.
    const refused = await call('/api/overall-mcp/remove', { body: { name: 'rea-cursor' } });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /^ambiguous server name: rea-cursor/);
    assert.equal((await readRegistry()).servers.length, 3, 'nothing was removed');

    // `slot` is the row position in the list the page rendered.
    const removed = await call('/api/overall-mcp/remove', { body: { name: 'rea-cursor', slot: 1 } });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, 'rea-cursor');
    const after = (await readRegistry()).servers;
    assert.equal(after.length, 2);
    assert.deepEqual(after[0].args, ['-y', 'rea-mcp@6.5.0'], 'the 6.5.0 row survived');
    assert.equal(after[1].name, 'fs');

    // `from` is the fallback for a client that rendered before slots existed.
    const byVersion = await call('/api/overall-mcp/remove', { body: { name: 'rea-cursor', from: '6.5.0' } });
    assert.equal(byVersion.status, 200);
    assert.deepEqual((await readRegistry()).servers.map((s) => s.name), ['fs']);
  });
});

test('a market install refuses to replace a hand-added row unless overwrite is asked for', async () => {
  const item = {
    id: 'catalog:fs', source: 'official', title: 'fs',
    install: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fs'] },
  };
  await withHost(FIXTURE, async ({ call, readRegistry }) => {
    // `mergeIntoRegistry` has always protected a `manual` entry from a scan; a
    // catalogue install was the one path that replaced it (command, args, env
    // and notes included) while reporting a plain 成功.
    const refused = await call('/api/overall-mcp/install', { body: { item } });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /^manual entry fs\b/);
    const row = (await readRegistry()).servers.find((s) => s.name === 'fs');
    assert.equal(row.command, 'my-own-fs', 'the hand-added command is untouched');
    assert.equal(row.source, 'manual');

    const replaced = await call('/api/overall-mcp/install', { body: { item, overwrite: true } });
    assert.equal(replaced.status, 200);
    const after = (await readRegistry()).servers.find((s) => s.name === 'fs');
    assert.equal(after.command, 'npx');
    assert.deepEqual(after.args, ['-y', '@modelcontextprotocol/server-fs']);
  });
});

test('an install whose mount fails is kept but not counted', async () => {
  const item = {
    id: 'catalog:ghost', source: 'official', title: 'ghost-mcp',
    install: { transport: 'stdio', command: 'npx', args: ['-y', 'ghost-mcp'] },
  };
  await withHost(FIXTURE, async ({ call, readRegistry, readInstalls }) => {
    const result = await call('/api/overall-mcp/install', { body: { item } });
    assert.equal(result.status, 200);
    assert.equal(result.body.installed, 'ghost-mcp');
    assert.equal(result.body.connect.ok, false, 'the mount is the failure under test');
    // The row stays: the user can fix and retry it.
    assert.ok((await readRegistry()).servers.some((s) => s.name === 'ghost-mcp'));
    // …but 「本市场 N 次」 must not claim an install that never ran, and the reply
    // has to say so instead of answering like a success.
    assert.equal(result.body.counted, false);
    assert.match(result.body.note, /没有计入本市场安装数/);
    assert.equal(result.body.localInstalls, 0);
    assert.deepEqual(Object.keys((await readInstalls()).entries), []);
  });
});

test('a damaged registry file is quarantined and reported, never silently replaced', async () => {
  const damaged = '{"version": 1, "servers": [ {"name": "rea-cursor"';
  await withHost(damaged, async ({ dir, call, registryText }) => {
    // A file that does not parse is not a first run. Treating it as one (the old
    // `readJson` fallback) and then saving replaced the user's only copy with an
    // empty document — indistinguishable from "you never added a server".
    const payload = await call('/api/overall-mcp/servers', { method: 'GET' });
    assert.equal(payload.status, 200);
    assert.deepEqual(payload.body.servers, []);
    assert.match(payload.body.registryError, /无法解析/);
    assert.match(payload.body.registryError, /registry\.json\.corrupt-/);

    const backups = (await fs.readdir(dir)).filter((f) => f.includes('.corrupt-'));
    assert.equal(backups.length, 1, 'exactly one quarantine copy');
    assert.equal(await fs.readFile(path.join(dir, backups[0]), 'utf8'), damaged);
    assert.equal(await registryText(), damaged, 'the original is still in place');
  });
});

test('the MCP tools expose the row selectors and the install overwrite flag', async () => {
  await withHost(FIXTURE, async ({ tools }) => {
    // Agent-facing capability, not just prose: without `slot`/`from` an agent
    // could not address one row of a duplicated name at all.
    const update = tools.get('overall_mcp_update');
    assert.deepEqual(Object.keys(update.parameters).sort(), ['from', 'name', 'slot']);
    const remove = tools.get('overall_mcp_remove');
    assert.deepEqual(Object.keys(remove.parameters).sort(), ['from', 'name', 'slot']);
    assert.deepEqual(Object.keys(tools.get('overall_mcp_set_enabled').parameters).sort(), ['enabled', 'from', 'name', 'slot']);
    assert.deepEqual(Object.keys(tools.get('overall_mcp_install').parameters).sort(), ['item', 'overwrite']);

    // The scan text used to promise the opposite of what the merge does
    // ("Existing entries are never overwritten" — an imported row *is* updated
    // in place when its command changed).
    const scan = tools.get('overall_mcp_scan').description;
    assert.ok(!/existing entries are never overwritten/i.test(scan));
    assert.match(scan, /added by hand is never overwritten/);
  });
});
