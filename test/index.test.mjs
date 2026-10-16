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
// The search-budget state lives in the catalog module, not in the host, so the
// case below can watch it and clean up after itself.
import { forgetGithubSearchQuota, githubSearchQuota } from '../lib/catalog.js';

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

/**
 * Drive the plugin through a fake host.
 *
 * @param registry - registry document, JSON text, or undefined for a first run.
 * @param run - receives the fake host's handles.
 * @param options - `{ llm }`: when given, the fake host provides an `llm`
 *   service (`stream`) and an `agentDefaultModel` route (`selection`, defaulting
 *   to `fake-provider/fake-model`; pass `null` for a host with no route). Without
 *   it the plugin must behave exactly as it did before the diagnosis existed.
 */
/**
 * A catalogue item whose mount always fails in this file: the fake host's
 * `ctx.plugin` throws `no mcp mount in this test`. Shared by the failure, the
 * explanation, and the "no model configured" cases so they cannot drift apart.
 */
const GHOST_ITEM = {
  id: 'catalog:ghost', source: 'official', title: 'ghost-mcp',
  install: { transport: 'stdio', command: 'npx', args: ['-y', 'ghost-mcp'] },
};

async function withHost(registry, run, { llm, files, mount } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'overall-mcp-contract-'));
  const dir = path.join(home, 'overall-mcp');
  await fs.mkdir(dir, { recursive: true });
  // Every mount the plugin attempts, in order. A case that cares how a fan-out
  // behaves (one mount per name) watches this instead of the clock.
  const mounts = [];
  if (registry !== undefined) {
    const text = typeof registry === 'string' ? registry : JSON.stringify(registry, null, 2);
    await fs.writeFile(path.join(dir, 'registry.json'), text, 'utf8');
  }
  // Documents the plugin reads at startup but never writes in these cases (the
  // GitHub census), so a case can put the host in a state it would otherwise
  // need a real walk to reach.
  for (const [name, text] of Object.entries(files ?? {})) {
    await fs.writeFile(path.join(dir, name), text, 'utf8');
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
      // `mount` lets one case watch the attempts (see the group-switch case).
      plugin: (_mcpClient, config) => {
        // ctx.plugin(mcpClient, config): the config carries the reserved
        // `serverName`, which is the identity a duplicate-name race collides on.
        mounts.push(config?.serverName ?? null);
        if (mount) return mount(config);
        throw new Error('no mcp mount in this test');
      },
      tools: {
        register(definition) { tools.set(definition.name, definition); return () => {}; },
        schemas: () => [],
      },
      inject(keys, callback) {
        if (keys.includes('connection')) {
          callback({ connection: { fetch: { register(config) { routes.set(config.path, config); } } } });
        } else if (keys.includes('llm') && llm) {
          callback({ llm: { stream: llm.stream } });
        } else {
          callback({});
        }
        return () => {};
      },
      // The plugin asks this for the default model route; a host without one
      // answers undefined, which is the "explain it yourself" path.
      get(name) {
        if (name !== 'agentDefaultModel' || !llm) return undefined;
        const selection = 'selection' in llm ? llm.selection : { provider: 'fake-provider', model: 'fake-model' };
        return { currentSelection: () => selection };
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

    await run({ dir, routes, tools, call, readRegistry, readInstalls, registryText, mounts });
  } finally {
    // The plugin's activity log is written behind the response, so a case can
    // finish while an append is still in flight. Stop accepting events, let the
    // queue drain, then remove the directory with retries: Windows refuses to
    // remove a directory that a write is still targeting.
    const { setEventSink } = await import('../lib/events.js');
    setEventSink(null);
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  }
}

test('the plugin registers the documented route and tool surface', async () => {
  await withHost(FIXTURE, async ({ routes, tools }) => {
    // The same list client/client.js documents at the top of the file: the page
    // and the host must not drift apart silently.
    for (const route of [
      '/api/overall-mcp/status', '/api/overall-mcp/events', '/api/overall-mcp/auth',
      '/api/overall-mcp/servers', '/api/overall-mcp/scan', '/api/overall-mcp/catalog',
      '/api/overall-mcp/repo-stats', '/api/overall-mcp/repo-media', '/api/overall-mcp/install',
      '/api/overall-mcp/favorite', '/api/overall-mcp/favorites', '/api/overall-mcp/set-enabled',
      '/api/overall-mcp/set-source-enabled', '/api/overall-mcp/updates', '/api/overall-mcp/self',
      '/api/overall-mcp/self-update', '/api/overall-mcp/update', '/api/overall-mcp/remove',
      '/api/overall-mcp/forget-orphans', '/api/overall-mcp/tools',
      '/api/overall-mcp/sources', '/api/overall-mcp/sources/remove',
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
 * The favourite routes are a write/read pair, and the panel's star only ever
 * sends the state it wants (`on`). Both shapes are pinned here because they are
 * easy to get subtly wrong in opposite directions: `on` must be idempotent (a
 * double click must not un-star), while a bare `key` must still toggle (that is
 * what the old star does, and what a script passing no `on` expects). The read
 * side has to agree with what was written *and* survive a restart, since the
 * set lives in registry.json.
 */
test('a favourite round-trips through the registry, and `on` is idempotent', async () => {
  await withHost(FIXTURE, async ({ call, readRegistry }) => {
    const KEY = 'smithery:brave';
    const written = await call('/api/overall-mcp/favorite', { body: { key: KEY, on: true } });
    assert.equal(written.status, 200);
    assert.equal(written.body.favorite, true);
    assert.deepEqual(written.body.favorites, [KEY]);

    // Same call again: still starred, still one entry. A toggle-shaped route
    // would have un-starred it here, which is why the panel sends `on`.
    const again = await call('/api/overall-mcp/favorite', { body: { key: KEY, on: true } });
    assert.equal(again.body.favorite, true);
    assert.deepEqual(again.body.favorites, [KEY]);

    const listed = await call('/api/overall-mcp/favorites', { method: 'GET' });
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, { favorites: [KEY], count: 1 });
    // The write reached the document, not just the in-memory set: that is the
    // difference between "starred until DSH restarts" and starred.
    assert.deepEqual((await readRegistry()).favorites, [KEY]);

    // `on: false` must remove even though the key is absent from the *caller's*
    // view of the world — it is a write of the desired state, not a toggle.
    const off = await call('/api/overall-mcp/favorite', { body: { key: KEY, on: false } });
    assert.equal(off.body.favorite, false);
    assert.deepEqual(off.body.favorites, []);

    // No `on`: the legacy toggle, both directions.
    const toggledOn = await call('/api/overall-mcp/favorite', { body: { key: KEY } });
    assert.equal(toggledOn.body.favorite, true);
    const toggledOff = await call('/api/overall-mcp/favorite', { body: { key: KEY } });
    assert.equal(toggledOff.body.favorite, false);

    // A non-boolean `on` is the caller's mistake: 400, and nothing changed.
    const bad = await call('/api/overall-mcp/favorite', { body: { key: KEY, on: 'yes' } });
    assert.equal(bad.status, 400);
    const stillEmpty = await call('/api/overall-mcp/favorites', { method: 'GET' });
    assert.equal(stillEmpty.body.count, 0);

    // A missing key is the same class of mistake, not an internal fault.
    assert.equal((await call('/api/overall-mcp/favorite', { body: {} })).status, 400);
  });
});


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
  await withHost(FIXTURE, async ({ call, readRegistry, readInstalls }) => {
    const result = await call('/api/overall-mcp/install', { body: { item: GHOST_ITEM } });
    assert.equal(result.status, 200);
    assert.equal(result.body.server, 'ghost-mcp');
    // One word, one meaning: a name is `server`, and `installed` stays the
    // market's boolean, exactly as a catalog row carries it.
    assert.equal(result.body.installed, true);
    assert.equal(result.body.connect.ok, false, 'the mount is the failure under test');
    // The row stays: the user can fix and retry it.
    assert.ok((await readRegistry()).servers.some((s) => s.name === 'ghost-mcp'));
    // …but 「本市场 N 次」 must not claim an install that never ran, and the reply
    // has to say so instead of answering like a success.
    assert.equal(result.body.counted, false);
    assert.match(result.body.note, /没有计入本市场安装数/);
    assert.equal(result.body.localInstalls, 0);
    assert.deepEqual(Object.keys((await readInstalls()).entries), []);
    // No model configured: the reply is exactly what it was before the
    // diagnosis existed, apart from the one field that says why nothing was
    // attempted — silence would read as "no explanation exists".
    assert.equal('diagnosis' in result.body, false);
    assert.equal('diagnosisError' in result.body, false);
    assert.equal(result.body.diagnosisSkipped, 'no-llm');
  });
});

/** The chunk sequence a model stream yields for a plain text answer. */
function textStream(text) {
  return [
    { type: 'block-start', index: 0, block: { type: 'text' } },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0 },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

test('a failed mount is explained by the configured model, silently', async () => {
  const seen = [];
  const answer = '这个包名在 npm 上不存在。\n先运行 npm view ghost-mcp version 确认名称。';
  const stream = (options) => {
    seen.push(options);
    return (async function* chunks() { for (const chunk of textStream(answer)) yield chunk; })();
  };
  await withHost(FIXTURE, async ({ call }) => {
    const result = await call('/api/overall-mcp/install', { body: { item: GHOST_ITEM } });
    assert.equal(result.body.connect.ok, false);
    assert.deepEqual(result.body.diagnosis, { text: answer, route: 'fake-provider/fake-model' });
    assert.equal('diagnosisError' in result.body, false);

    // One call, to the user's own default route, with the facts it needs and no
    // session of any kind involved.
    assert.equal(seen.length, 1);
    const [options] = seen;
    assert.equal(options.provider, 'fake-provider');
    assert.equal(options.model, 'fake-model');
    assert.equal(options.temperature, 0);
    assert.ok(options.signal, 'the call is bounded by a signal');
    const prompt = options.messages[0].content[0].text;
    assert.ok(prompt.includes('- 名称：ghost-mcp'));
    assert.ok(prompt.includes('- 命令：npx'));
    assert.ok(prompt.includes('- 参数 2：ghost-mcp'));
    assert.ok(prompt.includes('no mcp mount in this test'), 'the raw error is quoted');
    assert.ok(options.system.includes('禁止'), 'the instruction travels with the request');
  }, { llm: { stream } });
});

test('a model that cannot answer leaves the raw error as the whole story', async () => {
  const seen = [];
  const stream = (options) => {
    seen.push(options);
    return (async function* chunks() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'rate_limited', message: 'HTTP 429' } } };
    })();
  };
  await withHost(FIXTURE, async ({ call }) => {
    const result = await call('/api/overall-mcp/install', { body: { item: GHOST_ITEM } });
    assert.equal(result.status, 200, 'a failed explanation is not a failed install');
    assert.equal(result.body.connect.ok, false);
    assert.equal('diagnosis' in result.body, false);
    assert.match(result.body.diagnosisError, /诊断模型以 error 结束/);
    assert.match(result.body.diagnosisError, /HTTP 429/);
    assert.equal(seen.length, 1);
  }, { llm: { stream } });
});

test('a host with a model but no default route is never asked to explain', async () => {
  let calls = 0;
  const stream = () => {
    calls += 1;
    return (async function* chunks() { for (const chunk of textStream('不该被调用')) yield chunk; })();
  };
  await withHost(FIXTURE, async ({ call }) => {
    const result = await call('/api/overall-mcp/install', { body: { item: GHOST_ITEM } });
    assert.equal(result.body.connect.ok, false);
    assert.equal('diagnosis' in result.body, false);
    assert.equal('diagnosisError' in result.body, false);
    assert.equal(result.body.diagnosisSkipped, 'no-route');
    assert.equal(calls, 0, 'no route means no request');
  }, { llm: { selection: null, stream } });
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

test('a user-added catalogue source is stored, listed and refused when it is unusable', async () => {
  const GH = 'https://raw.githubusercontent.com/acme/mcp-registry/main/registry.json';
  await withHost(FIXTURE, async ({ dir, call }) => {
    const readSources = async () => JSON.parse(await fs.readFile(path.join(dir, 'sources.json'), 'utf8'));

    const empty = await call('/api/overall-mcp/sources', { method: 'GET' });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.sources, []);
    assert.equal(empty.body.max, 8);
    assert.equal(empty.body.error, null, 'no file yet is not damage');

    const added = await call('/api/overall-mcp/sources', { body: { url: GH } });
    assert.equal(added.status, 200);
    assert.equal(added.body.source.label, 'acme/mcp-registry');
    assert.deepEqual(added.body.sources.map((s) => s.url), [GH]);
    // Persisted in the same shape a restart reads back.
    const stored = await readSources();
    assert.equal(stored.version, 1);
    assert.deepEqual(stored.sources.map((s) => s.id), [added.body.source.id]);
    // The payload the panel needs carries no field the page did not ask for.
    assert.deepEqual(Object.keys(added.body.source).sort(), ['id', 'label', 'url']);

    // Where that list accepts submissions, derived from the address alone so the
    // panel can offer a prefilled issue without knowing GitHub's URL shapes.
    const target = added.body.sources[0].submission;
    assert.equal(target.repo, 'acme/mcp-registry');
    assert.ok(target.url.startsWith('https://github.com/acme/mcp-registry/issues/new?'));
    assert.match(new URL(target.url).searchParams.get('body'), /### 名称/);

    // A duplicate is a conflict (409) and a plain-http address is the caller's
    // mistake (400) — neither is a plugin fault, and both are visible.
    const twice = await call('/api/overall-mcp/sources', { body: { url: GH } });
    assert.equal(twice.status, 409);
    assert.match(twice.body.error, /已经添加过/);
    const plain = await call('/api/overall-mcp/sources', { body: { url: 'http://raw.githubusercontent.com/acme/x/main/r.json' } });
    assert.equal(plain.status, 400);
    assert.match(plain.body.error, /https/);
    assert.deepEqual((await readSources()).sources.length, 1, 'a refused address is not written');
  });
});

test('a catalogue that is not a GitHub repository advertises no submission link', async () => {
  await withHost(FIXTURE, async ({ call }) => {
    const added = await call('/api/overall-mcp/sources', { body: { url: 'https://example.com/catalog/registry.json' } });
    assert.equal(added.status, 200);
    assert.equal(added.body.sources[0].submission, null, 'no submission target, so the panel renders no link');
  });
});

test('removing a source names what went, and an unknown id is a 404', async () => {
  const GH = 'https://raw.githubusercontent.com/acme/mcp-registry/main/registry.json';
  await withHost(FIXTURE, async ({ dir, call }) => {
    const added = await call('/api/overall-mcp/sources', { body: { url: GH } });
    const id = added.body.source.id;

    const missing = await call('/api/overall-mcp/sources/remove', { body: { id: 'custom:never-added' } });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /unknown source/);

    const removed = await call('/api/overall-mcp/sources/remove', { body: { id } });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed.id, id);
    assert.deepEqual(removed.body.sources, []);
    // Removing twice is the 404 above, and the file reflects the empty list.
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'sources.json'), 'utf8')).sources, []);
  });
});

// ---------------------------------------------------------------------------
// The GitHub census (lib/github-index.js) as the host uses it. GitHub's search
// cannot page past 1000 rows per query, so "the MCP servers on GitHub" is a
// document the host holds and refreshes in the background — these cases pin the
// two promises that makes: a panel read does not wait for a walk, and a census
// we already hold costs no request at all.
// ---------------------------------------------------------------------------

/** One row as the walk stores it: a market item, trimmed, with the two stamps. */
function censusRow(fullName, { stars = 100, description = 'An MCP server.', title = null, lastSeen } = {}) {
  const [owner, name] = fullName.split('/');
  return {
    id: `github:${fullName}`,
    title: title ?? name,
    description,
    source: 'github-mcp',
    author: owner,
    transport: 'unknown',
    install: null,
    repository: `https://github.com/${fullName}`,
    tags: ['mcp'],
    status: 'active',
    stars,
    lastSeen: lastSeen ?? new Date().toISOString(),
  };
}

function censusDocument(rows, { at }) {
  return JSON.stringify({
    version: 1, at, minStars: 100, queries: ['mcp in:name archived:false'],
    requests: 4, complete: true, partial: null, rows,
  }, null, 2);
}

/** Replace global fetch for one case, and put it back whatever happens. */
async function withFetchStub(stub, run) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

test('a fresh census answers the panel from disk, with no request at all', async () => {
  const rows = [
    censusRow('acme/calendar-mcp', { stars: 90, description: 'A calendar MCP server.' }),
    censusRow('acme/other-mcp', { stars: 500 }),
    censusRow('acme/third-mcp', { stars: 10, title: 'third-mcp' }),
  ];
  const files = { 'github-index.json': censusDocument(rows, { at: new Date().toISOString() }) };
  let requests = 0;
  await withFetchStub(async () => { requests += 1; throw new Error('no network in this test'); }, async () => {
    await withHost(FIXTURE, async ({ call }) => {
      const all = await call('/api/overall-mcp/catalog', { body: { source: 'github-mcp', limit: 100 } });
      assert.equal(all.status, 200);
      assert.equal(all.body.errors.length, 0);
      assert.equal(all.body.items.length, 3);
      // Ranked by stars, exactly as the walk stored them.
      assert.deepEqual(all.body.items.map((i) => i.title), ['other-mcp', 'calendar-mcp', 'third-mcp']);
      assert.equal(all.body.counts['github-mcp'], 3);
      const source = all.body.sources['github-mcp'];
      assert.equal(source.index.rows, 3);
      assert.equal(source.index.stale, false);
      assert.equal(source.index.complete, true);
      assert.match(source.note, /^本地索引 3 行/);
      // The listing is dated by the census, not by the moment it was read.
      assert.equal(source.at, JSON.parse(files['github-index.json']).at);

      // A query filters the *census*, not the newest 200 rows of a live search.
      const one = await call('/api/overall-mcp/catalog', { body: { source: 'github-mcp', query: 'calendar', limit: 100 } });
      assert.deepEqual(one.body.items.map((i) => i.id), ['github:acme/calendar-mcp']);

      // …and the agent-facing tool reads the same census.
      assert.equal(requests, 0, 'not one request: a held census is a disk read');
    }, { files });
  });
});

test('a stale census is served immediately, and the walk behind it starts without blocking', async () => {
  const at = new Date(Date.now() - 40 * 3600_000).toISOString();
  const rows = [censusRow('acme/calendar-mcp', { stars: 90 }), censusRow('acme/other-mcp', { stars: 500 })];
  const files = { 'github-index.json': censusDocument(rows, { at }) };
  const urls = [];
  await withFetchStub(async (url) => {
    urls.push(String(url));
    throw new Error('offline: no network in this test');
  }, async () => {
    await withHost(FIXTURE, async ({ dir, call }) => {
      const stale = await call('/api/overall-mcp/catalog', { body: { source: 'github-mcp', limit: 100 } });
      // The panel got the old census with the truth written next to it, rather
      // than a spinner (or an empty source) while a walk runs for minutes.
      assert.equal(stale.body.items.length, 2);
      assert.equal(stale.body.sources['github-mcp'].index.stale, true);
      assert.match(stale.body.sources['github-mcp'].note, /待更新/);

      // The walk is not awaited by the response; it is already in flight, and it
      // writes what it learned — here, that the first request failed. A failed
      // walk keeps the last census and says so; it does not empty the source.
      await waitFor(async () => {
        const text = await fs.readFile(path.join(dir, 'github-index.json'), 'utf8').catch(() => '');
        return /请求失败/.test(text) ? text : null;
      });
      assert.ok(urls.some((u) => u.includes('/search/repositories')), 'the crawl asked GitHub');
      const after = JSON.parse(await fs.readFile(path.join(dir, 'github-index.json'), 'utf8'));
      assert.equal(after.rows.length, 2, 'the rows we already had survive a failed walk');
      assert.match(after.partial, /请求失败/);
      assert.equal(after.complete, false);
    }, { files });
  });
});

// ---------------------------------------------------------------------------
// Install evidence (lib/repo-install.js) as the host uses it: a discovery row
// whose repository publishes a package gets a real command, attributed to the
// file it was read from — and the panel never waits for the walk that finds it.
// ---------------------------------------------------------------------------

/** One evidence row as the walk stores it. */
function evidenceRow(id, { kind = 'package.json', registry = 'npm', name = 'acme-calendar-mcp', install, at, reason = null } = {}) {
  return {
    id,
    at: at ?? new Date().toISOString(),
    kind,
    registry,
    name,
    install: install ?? (kind === 'none' ? null : { transport: 'stdio', command: 'npx', args: ['-y', name] }),
    reason,
  };
}

function evidenceDocument(rows, { at } = {}) {
  return JSON.stringify({ version: 1, at: at ?? new Date().toISOString(), requests: 7, partial: null, rows }, null, 2);
}

test('a repository that publishes a package turns its row into an installable one, with the source named', async () => {
  const rows = [censusRow('acme/calendar-mcp', { stars: 900 }), censusRow('acme/mystery-mcp', { stars: 800 })];
  const files = {
    'github-index.json': censusDocument(rows, { at: new Date().toISOString() }),
    'install-evidence.json': evidenceDocument([
      evidenceRow('github:acme/calendar-mcp'),
      evidenceRow('github:acme/mystery-mcp', { kind: 'none', reason: '仓库里没有可识别的清单文件' }),
    ]),
  };
  await withFetchStub(async () => { throw new Error('no network in this test'); }, async () => {
    await withHost(FIXTURE, async ({ call }) => {
      const all = await call('/api/overall-mcp/catalog', { body: { source: 'github-mcp', limit: 100 } });
      const [calendar, mystery] = all.body.items;
      assert.equal(calendar.id, 'github:acme/calendar-mcp');
      assert.deepEqual(calendar.install, { transport: 'stdio', command: 'npx', args: ['-y', 'acme-calendar-mcp'] });
      assert.equal(calendar.installable, true, 'a recovered command is an install button');
      assert.equal(calendar.transport, 'stdio');
      assert.equal(calendar.installSource.kind, 'package.json');
      assert.equal(calendar.installSource.registry, 'npm');
      assert.equal(calendar.installSource.name, 'acme-calendar-mcp');
      assert.match(calendar.installSource.text, /命令来自仓库 package\.json；npm 上已确认这个包存在/);
      // A repository that answered with nothing stays a discovery row.
      assert.equal(mystery.install, null);
      assert.equal(mystery.installable, false);
      assert.equal(mystery.installSource, undefined);
    }, { files });
  });
});

test('opening the market starts the evidence walk, and what it recovers is on disk before the next read', async () => {
  const rows = [censusRow('acme/calendar-mcp', { stars: 900 }), censusRow('acme/mystery-mcp', { stars: 800 })];
  const files = { 'github-index.json': censusDocument(rows, { at: new Date().toISOString() }) };
  const asked = [];
  const stub = async (url, init = {}) => {
    const target = String(url);
    asked.push(target);
    if (target.includes('raw.githubusercontent.com/acme/calendar-mcp/HEAD/package.json')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'acme-calendar-mcp', bin: { 'acme-calendar-mcp': 'cli.js' } }) };
    }
    if (target.startsWith('https://registry.npmjs.org/')) return { ok: true, status: 200, text: async () => '{}' };
    if (target.includes('raw.githubusercontent.com')) return { ok: false, status: 404, text: async () => 'Not Found' };
    throw new Error(`unexpected request in this test: ${target} (${init.method ?? 'GET'})`);
  };
  await withFetchStub(stub, async () => {
    await withHost(FIXTURE, async ({ dir, call }) => {
      const before = await call('/api/overall-mcp/install-evidence', { method: 'GET' });
      assert.equal(before.body.rows, 0);
      assert.equal(before.body.walking, false);

      const started = await call('/api/overall-mcp/install-evidence', { method: 'POST' });
      assert.equal(started.status, 200);
      assert.equal(started.body.walking, true, 'the walk is in flight, not awaited');

      const written = await waitFor(async () => {
        const text = await fs.readFile(path.join(dir, 'install-evidence.json'), 'utf8').catch(() => '');
        return /acme-calendar-mcp/.test(text) ? text : null;
      });
      const doc = JSON.parse(written);
      const calendar = doc.rows.find((row) => row.id === 'github:acme/calendar-mcp');
      assert.equal(calendar.kind, 'package.json');
      assert.deepEqual(calendar.install, { transport: 'stdio', command: 'npx', args: ['-y', 'acme-calendar-mcp'] });
      assert.equal(doc.rows.find((row) => row.id === 'github:acme/mystery-mcp').kind, 'none');
      assert.ok(asked.some((u) => u.includes('registry.npmjs.org')), 'the package was confirmed before the command was written down');

      const after = await call('/api/overall-mcp/install-evidence', { method: 'GET' });
      assert.equal(after.body.rows, 2);
      assert.equal(after.body.withCommand, 1);
      // …and the recovered command reaches the listing.
      const all = await call('/api/overall-mcp/catalog', { body: { source: 'github-mcp', limit: 100 } });
      assert.equal(all.body.items[0].install.args[1], 'acme-calendar-mcp');
    }, { files });
  });
});

test('a spent search budget reads as a wait, and nothing spends from it again', async () => {
  let requests = 0;
  const refused = async (url) => {
    requests += 1;
    assert.match(String(url), /api\.github\.com\/search\/repositories/, 'only the search API is asked');
    return {
      ok: false,
      status: 403,
      headers: {
        get: (name) => (name === 'x-ratelimit-remaining' ? '0'
          : name === 'x-ratelimit-reset' ? String(Math.floor(Date.now() / 1000) + 45) : undefined),
      },
      json: async () => ({ message: 'API rate limit exceeded for 203.0.113.7.' }),
    };
  };
  await withFetchStub(refused, async () => {
    // No census on disk and no install evidence: this host has never walked, so
    // the GitHub source has nothing to read and would ask the search API. The
    // walk starts first and its very first request is refused.
    await withHost(FIXTURE, async ({ call }) => {
      const first = await call('/api/overall-mcp/catalog', { body: { source: 'github-mcp', limit: 100 } });
      assert.equal(first.status, 200);
      assert.equal(first.body.errors.length, 0, 'an emptied window is not a broken source');
      assert.equal(first.body.counts['github-mcp'], 0);
      assert.match(String(first.body.sources['github-mcp'].note ?? ''), /正在建立本机普查索引/);
      assert.equal(requests, 1, 'the live fallback stayed out of the walk\u2019s way');

      // Let the refusal land, then read again *with refresh*, which is the
      // strongest request the panel can make — and it must still not ask.
      await waitFor(() => (githubSearchQuota().waitMs > 0 ? true : null));
      // While the census walk is still registered the source line describes the
      // walk, not the spent budget — and that is the honest answer at that
      // moment ("something is happening"), so this case watches for the
      // handover rather than sleeping a fixed 30ms and hoping. What it asserts
      // is what the *settled* host says: the budget is empty, and the panel's
      // strongest request still spends nothing.
      const second = await waitFor(async () => {
        const res = await call('/api/overall-mcp/catalog', {
          body: { source: 'github-mcp', limit: 100, refresh: true },
        });
        return /配额已用完/.test(String(res.body.sources['github-mcp'].note ?? '')) ? res : null;
      });
      assert.equal(requests, 1, 'no request is spent from a window known to be empty');
      assert.match(String(second.body.sources['github-mcp'].note ?? ''), /配额已用完/);
      assert.equal(second.body.errors.length, 0);
    });
  });
  forgetGithubSearchQuota();
});

test('the plugin reports which build it is running, and what it has been doing', async () => {
  const realFetch = globalThis.fetch;
  const stub = dockerFetchStub();
  globalThis.fetch = stub;
  // A credential in the developer's own environment would make the assertions
  // below depend on the machine (and fire a probe at a stubbed fetch), so the
  // two names this plugin reads are cleared for the duration.
  const savedEnv = { DSH_GITHUB_TOKEN: process.env.DSH_GITHUB_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  delete process.env.DSH_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    await withHost(FIXTURE, async ({ dir, call }) => {
      // The page reads this before it trusts anything: which files are loaded,
      // which process serves them, and which data files exist.
      const before = await call('/api/overall-mcp/status', { method: 'GET' });
      assert.equal(before.status, 200);
      assert.equal(before.body.plugin.id, 'dsh-overall-mcp');
      assert.ok(before.body.plugin.version, 'the running package version is reported');
      assert.ok(before.body.plugin.dir.endsWith('dsh-overall-mcp'), before.body.plugin.dir);
      assert.equal(before.body.host.pid, process.pid);
      assert.ok(before.body.host.uptimeMs > 0);
      assert.equal(before.body.data.dir, dir);
      assert.equal(before.body.events.lines, 0, 'a fresh data directory has no log yet');
      assert.equal(
        before.body.plugin.source.stale,
        false,
        'the files on disk are the ones that were just loaded',
      );
      assert.ok(
        before.body.plugin.source.files.some((f) => f.name === 'index.js'),
        'the file list names the loaded entry point',
      );
      const files = new Map(before.body.data.files.map((f) => [f.name, f]));
      assert.ok(files.get('registry.json').bytes > 0, 'a data file that exists reports its size');
      assert.equal(files.get('github-index.json').bytes, null, 'an absent file says so instead of 0');
      assert.equal(before.body.auth.source, 'anonymous');
      assert.equal(before.body.auth.inUse, false);
      assert.match(String(before.body.auth.note), /匿名访问/);

      const browse = await call('/api/overall-mcp/catalog', { body: { source: 'docker-catalog', limit: 10 } });
      assert.equal(browse.status, 200);

      // The log is written after the response, so the read has to wait for it.
      const logged = await waitFor(async () => {
        const read = await call('/api/overall-mcp/events', { method: 'GET' });
        assert.equal(read.status, 200);
        assert.equal(read.body.damaged, 0);
        return read.body.events.some((e) => e.kind === 'browse') ? read.body : null;
      });
      const kinds = logged.events.map((e) => e.kind);
      assert.ok(kinds.includes('source'), `the per-source read is logged too (saw ${kinds.join(', ')})`);
      const source = logged.events.find((e) => e.kind === 'source' && e.source === 'docker-catalog');
      assert.equal(source.items, 2);
      assert.equal(source.error, undefined);
      const events = logged.events.find((e) => e.kind === 'browse');
      assert.equal(events.source, 'docker-catalog');
      assert.equal(events.items, 2);
      assert.equal(typeof events.ms, 'number');

      const after = await call('/api/overall-mcp/status', { method: 'GET' });
      assert.ok(after.body.events.lines > 0);
      assert.match(String(after.body.events.lastAt), /^\d{4}-\d{2}-\d{2}T/);
      const registry = after.body.data.files.find((f) => f.name === 'registry.json');
      assert.ok(registry.bytes > 0, 'the status lists the data files it found, with sizes');
      assert.equal(after.body.events.damaged, 0);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/**
 * The credential resource: a token goes in, a mask comes out.
 *
 * This is the one place in the plugin where a secret is accepted, so the test
 * asserts both halves of that contract — that the token reaches GitHub, and
 * that it appears nowhere else (not in the response, not in the log).
 */
test('a pasted GitHub token is used for GitHub and echoed nowhere', async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  const ok = (body, headers = {}) => ({
    ok: true,
    status: 200,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
  });
  const token = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
  let reject = false;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    sent.push({ url: target, authorization: (options.headers ?? {}).authorization ?? null });
    if (reject) {
      return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({ message: 'Bad credentials' }) };
    }
    if (target.endsWith('/rate_limit')) {
      return ok({ resources: { core: { limit: 5000, remaining: 4999, reset: 1791926400 } } });
    }
    return ok({ login: 'harness-user', company: null }, { 'x-oauth-scopes': 'read:user' });
  };
  const savedEnv = { DSH_GITHUB_TOKEN: process.env.DSH_GITHUB_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  delete process.env.DSH_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    await withHost(FIXTURE, async ({ dir, call }) => {
      // Reading the resource is free: no credential, no request, no process.
      const anonymous = await call('/api/overall-mcp/auth', { method: 'GET' });
      assert.equal(anonymous.status, 200);
      assert.equal(anonymous.body.source, 'anonymous');
      assert.deepEqual(sent, [], 'nothing is fetched to say "anonymous"');

      const empty = await call('/api/overall-mcp/auth', { method: 'POST', body: { token: '   ' } });
      assert.equal(empty.status, 400);
      assert.match(empty.body.error, /不能为空/);

      const set = await call('/api/overall-mcp/auth', { method: 'POST', body: { token: `  ${token}  ` } });
      assert.equal(set.status, 200);
      assert.equal(set.body.source, 'panel');
      assert.equal(set.body.login, 'harness-user');
      assert.equal(set.body.inUse, true);
      assert.deepEqual(set.body.scopes, ['read:user']);
      assert.deepEqual(set.body.rateLimit, { limit: 5000, remaining: 4999, resetAt: '2026-10-13T21:20:00.000Z' });
      assert.ok(set.body.masked.startsWith('ghp_01'), set.body.masked);
      assert.equal(JSON.stringify(set.body).includes(token), false, 'the host does not echo the token back');
      assert.deepEqual(
        sent.map((s) => s.url),
        ['https://api.github.com/user', 'https://api.github.com/rate_limit'],
        'validation is two requests, to api.github.com only',
      );
      assert.equal(sent[0].authorization, `Bearer ${token}`);

      // Stored, so it survives the process; the next read is served from the
      // resolution the write just made instead of probing again.
      const stored = JSON.parse(await fs.readFile(path.join(dir, 'github-auth.json'), 'utf8'));
      assert.equal(stored.token, token);
      const again = await call('/api/overall-mcp/auth', { method: 'GET' });
      assert.equal(again.body.login, 'harness-user');
      assert.equal(sent.length, 2, 'a cached resolution is not re-probed on every read');
      const status = await call('/api/overall-mcp/status', { method: 'GET' });
      assert.equal(status.body.auth.inUse, true);
      assert.equal(status.body.auth.login, 'harness-user');
      assert.equal(JSON.stringify(status.body).includes(token), false, 'nor does /status');

      // The activity log records that a credential was set — by mask, never by
      // value.
      const logged = await waitFor(async () => {
        const read = await call('/api/overall-mcp/events', { method: 'GET' });
        return read.body.events.find((e) => e.kind === 'auth') ?? null;
      });
      assert.equal(logged.action, 'set');
      assert.equal(logged.masked, set.body.masked);
      assert.equal(logged.ok, true);
      assert.equal(JSON.stringify(logged).includes(token), false, 'and the log keeps only the mask');

      // A token GitHub refuses is reported and dropped rather than left to fail
      // every subsequent request.
      reject = true;
      const refused = await call('/api/overall-mcp/auth', { method: 'POST', body: { token } });
      assert.equal(refused.status, 200);
      assert.equal(refused.body.source, 'panel');
      assert.equal(refused.body.inUse, false);
      assert.equal(refused.body.needsLogin, true);
      assert.match(String(refused.body.error), /无效或已过期/);

      reject = false;
      const cleared = await call('/api/overall-mcp/auth', { method: 'DELETE' });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.removed, true);
      assert.equal(cleared.body.source, 'anonymous');
      assert.equal(cleared.body.inUse, false);
      await assert.rejects(() => fs.readFile(path.join(dir, 'github-auth.json'), 'utf8'), /ENOENT/);

      const after = await call('/api/overall-mcp/auth', { method: 'GET' });
      assert.equal(after.body.inUse, false);
      assert.equal(sent.filter((s) => s.url.endsWith('/user')).length, 2, 'clearing triggers no probe');
    });
  } finally {
    globalThis.fetch = realFetch;
    if (savedEnv.DSH_GITHUB_TOKEN === undefined) delete process.env.DSH_GITHUB_TOKEN;
    else process.env.DSH_GITHUB_TOKEN = savedEnv.DSH_GITHUB_TOKEN;
    if (savedEnv.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedEnv.GITHUB_TOKEN;
  }
});

// A group whose rows repeat one name: the fan-out (startup, group switch) must
// mount per *name* and answer per *row*.
const DUPLICATE_GROUP = {
  version: 1,
  servers: [
    { name: 'demo-a', source: 'demo', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'demo-a@1.0.0'] },
    { name: 'demo-a', source: 'demo', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'demo-a@2.0.0'] },
    { name: 'demo-b', source: 'demo', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'demo-b'] },
    { name: 'demo-c', source: 'demo', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'demo-c'] },
  ],
};

// The mounts are bounded and concurrent now (CONNECT_CONCURRENCY), which is what
// makes this case worth having: two rows can share a name — one client config
// may define the same server twice — and a concurrent pair that both read
// `fibers` before either had set one would launch two mcp-clients under the same
// serverName. The loser's collision used to be recorded as 「另一个 mcp-client
// 已经提供」, a claim about the host that was not true.
test('startup mounts each name once, and every row still gets an answer', async () => {
  await withHost(DUPLICATE_GROUP, async ({ mounts, call }) => {
    assert.deepEqual(mounts.slice().sort(), ['demo-a', 'demo-b', 'demo-c']);
    const list = await call('/api/overall-mcp/servers', { method: 'GET' });
    assert.equal(list.status, 200);
    assert.equal(list.body.servers.length, 4);
    // The fake host refuses every mount. The failure belongs to the *name* and
    // is recorded on the row that owns the attempt — demo-a@1.0.0, the first
    // enabled row of that name. Its twin reads 启用但未挂载 rather than
    // inventing a second, identical error, and *neither* may claim to be
    // provided by another mount: that is the collision claim a concurrent pair
    // of mounts for one serverName used to produce.
    assert.deepEqual(list.body.servers.map((s) => s.status), ['error', 'idle', 'error', 'error']);
    assert.ok(!list.body.servers.some((s) => s.providedExternally === true));
  });
});

test('a group switch mounts each name once and answers every row', async () => {
  const registry = {
    version: 1,
    servers: DUPLICATE_GROUP.servers.map((s) => ({ ...s, enabled: false }))
      .concat([{ name: 'other', source: 'manual', enabled: false, transport: 'stdio', command: 'other' }]),
  };
  await withHost(registry, async ({ call, mounts }) => {
    assert.deepEqual(mounts, [], 'every row starts disabled');
    const result = await call('/api/overall-mcp/set-source-enabled', { body: { source: 'demo', enabled: true } });
    assert.equal(result.status, 200);
    assert.equal(result.body.changed, 4);
    // One mount per name (demo-a is defined twice) …
    assert.deepEqual(mounts.slice().sort(), ['demo-a', 'demo-b', 'demo-c']);
    // … and one answer per row, in registry order, with the manual row left
    // alone by a switch that names another source.
    const demo = result.body.servers.filter((s) => s.source === 'demo');
    assert.equal(demo.length, 4);
    assert.deepEqual(demo.map((s) => s.enabled), [true, true, true, true]);
    // Same rule as startup: the name's failure is recorded once, on the row
    // that owns the attempt (demo-a@1.0.0), and its twin honestly reads
    // 启用但未挂载 instead of a duplicate error.
    assert.deepEqual(demo.map((s) => s.status), ['error', 'idle', 'error', 'error']);
    assert.equal(result.body.servers.find((s) => s.name === 'other').enabled, false);
  });
});

/** Poll a condition until it is truthy, or fail with the last value. */
async function waitFor(check, { timeoutMs = 3000, everyMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`waitFor timed out; last=${JSON.stringify(last)}`);
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}
