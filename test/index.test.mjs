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
// The mount arguments are what proves a `config` value reached the `--config`
// flag instead of the `env` bag the CLI never reads.
import { composeMountArgs } from '../lib/server-config.js';

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
 * A tool result must be **lossless JSON**.
 *
 * The host compares the value a tool returned against its own
 * `JSON.parse(JSON.stringify(value))` and answers
 * `tool "X" returned invalid output: value is not lossless JSON` when the two
 * differ — the call fails even though the tool itself worked. `publicList()`
 * omits `error` / `updatedAt` / `aboutAt` when there is nothing to say, and the
 * resulting `{ error: undefined }` drops a key on the round-trip: that is why
 * `overall_mcp_list` (and `_search`, `_catalog`, `_check_updates`, all built on
 * it) could never answer, no matter the arguments. The fixture registry has no
 * connect errors and no timestamps, so it is exactly the shape that used to
 * break.
 */
test('management tools answer with lossless JSON', async () => {
  await withHost(FIXTURE, async ({ tools }) => {
    const assertLossless = (label, value) => {
      let round;
      try {
        round = JSON.parse(JSON.stringify(value));
      } catch (err) {
        assert.fail(`${label}: not JSON-serialisable (${err.message})`);
      }
      assert.deepEqual(round, value, `${label}: JSON round-trip changed the value`);
      const walk = (node, at) => {
        if (node === null || typeof node !== 'object') return;
        for (const [key, item] of Object.entries(node)) {
          assert.ok(item !== undefined, `${label}: ${at}.${key} is undefined`);
          walk(item, `${at}.${key}`);
        }
      };
      walk(value, label);
    };

    const listed = await tools.get('overall_mcp_list').execute({});
    assertLossless('overall_mcp_list', listed);
    assert.equal(listed.servers.length, FIXTURE.servers.length);
    // The row that used to carry `error: undefined`: absent now, not nulled out
    // by hand. `null` and 「没有这个键」 are different facts for a reader.
    for (const row of listed.servers) {
      assert.equal('error' in row, false, `${row.name}: no error key when there is none`);
      assert.equal(row.status, 'stopped');
    }

    // The same normalisation covers every other tool, including the ones whose
    // payload nests registry rows (an install answer carries `servers` too).
    assertLossless('overall_mcp_forget_orphans', await tools.get('overall_mcp_forget_orphans').execute({}));
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

/** Registry used by the config cases: one declared-required key per row, same name twice. */
const CONFIG_FIXTURE = {
  version: 1,
  servers: [
    {
      name: 'gh', source: 'official', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'],
      config: { origin: 'official', fields: [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', kind: 'env', label: 'GitHub 个人访问令牌', required: true, secret: true }] },
    },
    {
      name: 'gh', source: 'manual', enabled: true, transport: 'stdio', command: 'other-mcp', args: [],
      config: { origin: 'manual', fields: [{ key: 'API_KEY', kind: 'env', label: 'API Key', required: true, secret: true }] },
    },
  ],
};

test('an item that declares a required setting installs as 「待配置」, not as connection trouble', async () => {
  const seen = [];
  const item = {
    id: 'catalog:github', source: 'official', title: 'github-mcp',
    install: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
    raw: { packages: [{ environmentVariables: [
      { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'GitHub PAT', isRequired: true, isSecret: true },
    ] }] },
  };
  await withHost(FIXTURE, async ({ call, readRegistry }) => {
    const result = await call('/api/overall-mcp/install', { body: { item } });
    assert.equal(result.status, 200);
    assert.equal(result.body.needConfig, true);
    assert.deepEqual(result.body.config.missing, ['GITHUB_PERSONAL_ACCESS_TOKEN']);
    assert.match(result.body.note, /GITHUB_PERSONAL_ACCESS_TOKEN/, 'the reply names the field the form will ask for');
    // The declaration is stored with the row, so the badge survives a restart.
    const row = (await readRegistry()).servers.find((s) => s.name === 'github-mcp');
    assert.equal(row.config.origin, 'official');
    assert.equal(row.config.fields[0].required, true);
    // A declared-but-unfilled field is not a mystery to re-derive from `401`.
    assert.equal(result.body.diagnosisSkipped, 'needs-config');
    assert.equal(seen.length, 0, 'the model is not asked about a form the user can fill');
    // …and the list the page re-renders carries the flag, with the value masked.
    const servers = await call('/api/overall-mcp/servers');
    assert.equal(servers.body.needConfig, 1);
    const listed = servers.body.servers.find((s) => s.name === 'github-mcp');
    assert.equal(listed.needConfig, true);
    assert.equal(listed.config.fields[0].value, '');
  }, { llm: { stream: () => { seen.push(1); throw new Error('must not be called'); } } });
});

test('a configure writes the value, masks it on the way back, and clears by deleting', async () => {
  await withHost(CONFIG_FIXTURE, async ({ call, readRegistry, mounts }) => {
    const listed = await call('/api/overall-mcp/servers');
    assert.equal(listed.body.needConfig, 2, 'both rows are missing their required key');

    const mountsBefore = mounts.length;
    const saved = await call('/api/overall-mcp/configure', {
      body: { name: 'gh', slot: 0, env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_test_value' } },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.saved, true);
    assert.deepEqual(saved.body.changed, [{ key: 'GITHUB_PERSONAL_ACCESS_TOKEN', kind: 'env', action: 'set' }]);
    assert.equal(saved.body.needConfig, false);
    // The row is enabled, so saving remounts it — a mount that fails here does
    // not undo the write, and the reply says which of the two happened.
    assert.equal(mounts.length, mountsBefore + 1);
    assert.equal(saved.body.connect.ok, false);
    // The secret goes in, and only the mask comes back.
    assert.equal((await readRegistry()).servers[0].env.GITHUB_PERSONAL_ACCESS_TOKEN, 'ghp_test_value');
    assert.equal(saved.body.config.fields[0].value, '••••');

    // Clearing is deletion, not an empty string that reads like a value.
    const cleared = await call('/api/overall-mcp/configure', {
      body: { name: 'gh', slot: 0, env: { GITHUB_PERSONAL_ACCESS_TOKEN: '' } },
    });
    assert.equal(cleared.body.needConfig, true);
    assert.equal('GITHUB_PERSONAL_ACCESS_TOKEN' in (await readRegistry()).servers[0].env, false);

    // A save that changes nothing says so instead of claiming success.
    const noop = await call('/api/overall-mcp/configure', { body: { name: 'gh', slot: 0 } });
    assert.equal(noop.body.saved, false);
    assert.match(noop.body.note, /没有需要写入的值/);
  });
});

test('a configure on a stopped row writes the value but starts nothing', async () => {
  const stopped = {
    version: 1,
    servers: [{
      name: 'gh', source: 'official', enabled: false, transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'],
      config: { origin: 'official', fields: [{ key: 'TOKEN', kind: 'env', label: 'TOKEN', required: true, secret: true }] },
    }],
  };
  await withHost(stopped, async ({ call, readRegistry, mounts }) => {
    const saved = await call('/api/overall-mcp/configure', { body: { name: 'gh', env: { TOKEN: 'v' } } });
    assert.equal(saved.body.saved, true);
    assert.equal('connect' in saved.body, false, 'stopped stays stopped');
    assert.equal(mounts.length, 0, 'and nothing is mounted for it');
    assert.equal((await readRegistry()).servers[0].env.TOKEN, 'v');
  });
});

test('a configure on a duplicated name is refused, and slot picks the row', async () => {
  await withHost(CONFIG_FIXTURE, async ({ call, readRegistry }) => {
    const refused = await call('/api/overall-mcp/configure', { body: { name: 'gh', env: { API_KEY: 'x' } } });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /^ambiguous server name: gh/);
    assert.equal((await readRegistry()).servers[1].env, undefined, 'nothing was written to either row');

    const picked = await call('/api/overall-mcp/configure', { body: { name: 'gh', slot: 1, env: { API_KEY: 'second-row' } } });
    assert.equal(picked.status, 200);
    const after = (await readRegistry()).servers;
    assert.equal(after[0].env, undefined, 'the first row was untouched');
    assert.equal(after[1].env.API_KEY, 'second-row');
  });
});

test('configure notes rejections when all values are rejected', async () => {
  await withHost(CONFIG_FIXTURE, async ({ call }) => {
    const res = await call('/api/overall-mcp/configure', {
      body: { name: 'gh', slot: 0, headers: { Host: 'evil.com' } },
    });
    assert.equal(res.body.saved, false);
    assert.equal(res.body.rejected.length, 1);
    assert.match(res.body.note, /未写入任何配置.*Host/);
  });
});

test('overall_mcp_configure tool runs as actor: model and blocks code execution env vars', async () => {
  await withHost(CONFIG_FIXTURE, async ({ tools }) => {
    const tool = tools.get('overall_mcp_configure');
    assert(tool, 'overall_mcp_configure tool must be registered');
    const result = await tool.execute({
      name: 'gh',
      slot: 0,
      env: {
        NODE_OPTIONS: '--require /tmp/x.js',
        SAFE_VAR: 'hello',
      },
    });
    assert.equal(result.saved, true);
    assert.equal(result.changed.length, 1);
    assert.equal(result.changed[0].key, 'SAFE_VAR');
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].key, 'NODE_OPTIONS');
    assert.match(result.note, /以下配置未写入.*NODE_OPTIONS/);
  });
});

test('configure reports truncated note when value exceeds MAX_VALUE_CHARS', async () => {
  await withHost(CONFIG_FIXTURE, async ({ call }) => {
    const res = await call('/api/overall-mcp/configure', {
      body: { name: 'gh', slot: 0, env: { SAFE_VAR: 'x'.repeat(5000) } },
    });
    assert.equal(res.body.saved, true);
    assert.equal(res.body.changed[0].action, 'truncated');
    assert.match(res.body.note, /超过 4096 字符，已截断保存/);
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

test('the census view names its upstream instead of becoming a seventh source', async () => {
  const rows = [
    censusRow('acme/calendar-mcp', { stars: 90, description: 'A calendar MCP server.' }),
    censusRow('acme/other-mcp', { stars: 500 }),
  ];
  const files = { 'github-index.json': censusDocument(rows, { at: new Date().toISOString() }) };
  let requests = 0;
  await withFetchStub(async () => { requests += 1; throw new Error('no network in this test'); }, async () => {
    await withHost(FIXTURE, async ({ call }) => {
      const view = await call('/api/overall-mcp/catalog', { body: { source: 'census', limit: 100 } });
      assert.equal(view.status, 200);
      assert.equal(view.body.errors.length, 0);
      // The panel has to be able to say whose rows these are, and the line above
      // 「共 N 条」 must still add up: one upstream, one number.
      assert.equal(view.body.aliasOf, 'github-mcp');
      assert.deepEqual(Object.keys(view.body.counts), ['github-mcp']);
      assert.equal(view.body.items.length, 2);
      assert.deepEqual(view.body.items.map((i) => i.title), ['other-mcp', 'calendar-mcp']);
      assert.match(view.body.sources['github-mcp'].note, /没发请求$/);
      assert.equal(requests, 0, 'a filter is a read: not one request');
    }, { files });
  });
});

test('a census view with no census says so, and starting one is still an explicit act', async () => {
  let requests = 0;
  await withFetchStub(async () => { requests += 1; throw new Error('offline: no network in this test'); }, async () => {
    await withHost(FIXTURE, async ({ call }) => {
      const view = await call('/api/overall-mcp/catalog', { body: { source: 'census', limit: 100 } });
      assert.equal(view.status, 200);
      assert.deepEqual(view.body.items, []);
      assert.match(view.body.sources['github-mcp'].note, /还没有普查索引/);
      assert.equal(requests, 0, 'the view does not answer "no census" by walking one');

      // The other half of that promise, and the one a background crawl would
      // break: filtering the market left no walk running behind the answer.
      const state = await call('/api/overall-mcp/census', { method: 'GET' });
      assert.equal(state.body.walking, false);
      assert.equal(state.body.rows, 0);
    });
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
      // This walk failed, which is not a reason the host skips the follow-up:
      // a finished census starts the evidence walk whatever its own outcome, so
      // this test has to end that one before it hands the stub to someone else.
      await quietEvidence(call);
    }, { files });
  });
});

// ---------------------------------------------------------------------------
// The census verbs the reader owns. Before `/census` a walk only ever started
// because someone happened to browse the GitHub source, and once started it
// could only be ended by unloading the plugin — a walk paces itself at 6.5s per
// request for up to 48 requests, so "I did not want this" had no answer. These
// cases pin the three things that makes it a contract: reading starts nothing,
// an unknown verb is refused instead of read as "just read", and stop really
// ends the walk rather than asking it to end eventually.
// ---------------------------------------------------------------------------

test('the census is a GET that starts nothing, and stop really ends the walk', async () => {
  const at = new Date(Date.now() - 40 * 3600_000).toISOString();
  const files = { 'github-index.json': censusDocument([censusRow('acme/calendar-mcp', { stars: 90 })], { at }) };
  let requests = 0;
  const held = [];
  // The first request is answered — an empty window, which is the cheapest
  // honest answer and lets the walk move on to plan its next one. Every later
  // request is held open until the signal aborts it: exactly what real fetch
  // does, and what makes "stop" a promise the host can keep rather than a hope.
  // Nothing here needs a network, and nothing waits 6.5 seconds: after the first
  // answer the walk is asleep between requests, which is where a reader stops it.
  const emptySearch = () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'x-ratelimit-remaining' ? '29' : null) },
    json: async () => ({ total_count: 0, incomplete_results: false, items: [] }),
  });
  const stub = (url, options = {}) => {
    requests += 1;
    held.push(String(url));
    if (requests === 1) return Promise.resolve(emptySearch());
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const fail = () => {
        const err = new Error('the operation was aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal?.aborted) return fail();
      signal?.addEventListener('abort', fail, { once: true });
      return undefined;
    });
  };

  await withFetchStub(stub, async () => {
    await withHost(FIXTURE, async ({ call }) => {
      // Reading is a GET, and it is a disk read: a stale census does not make a
      // reader who only looked pay for a walk.
      const before = await call('/api/overall-mcp/census', { method: 'GET' });
      assert.equal(before.status, 200);
      assert.equal(before.body.walking, false);
      assert.equal(before.body.rows, 1);
      assert.equal(before.body.complete, true);
      assert.equal(requests, 0, 'reading the census starts nothing');

      // A verb outside the set is the caller's error. Treated as "no action" it
      // would answer "here is the state" to a mistyped `stop` — indistinguishable
      // from success for whoever sent it.
      const bogus = await call('/api/overall-mcp/census', { body: { action: 'stpo' } });
      assert.equal(bogus.status, 400);
      assert.match(String(bogus.body.error), /unknown census action/);
      assert.equal(requests, 0, 'a refused verb does not walk either');

      // Start: `start` means a walk now, stale or not — that is the whole point
      // of the button, and the reason it passes `force`.
      const started = await call('/api/overall-mcp/census', { body: { action: 'start' } });
      assert.equal(started.status, 200);
      assert.equal(started.body.started, true);
      assert.equal(started.body.walking, true);
      await waitFor(() => (requests >= 1 ? true : null));
      assert.equal(held.length, 1, 'the walk asked GitHub before pacing');
      assert.match(held[0], /\/search\/repositories/);

      // While it runs, the state says so and carries progress: /status and this
      // route are the only places that can — the index file says "正在抓取" and
      // never says which request the walk is on. A request is counted when it
      // comes back, so the first one is already on the board here.
      const during = await waitFor(async () => {
        const res = await call('/api/overall-mcp/census', { method: 'GET' });
        return res.body.progress?.requests >= 1 ? res.body : null;
      });
      assert.equal(during.walking, true);
      assert.equal(during.progress.requests, 1);

      // A second start does not stack a second walk: `walking` is the honest
      // answer, and no new request is made for it.
      const again = await call('/api/overall-mcp/census', { body: { action: 'start' } });
      assert.equal(again.body.walking, true);
      assert.equal(again.body.started, false, 'one walk at a time');
      assert.equal(requests, 1);

      // Stop: the walk is aborted where it stands — asleep between requests, or
      // waiting on one. Either way it does not get to the next request.
      const stopped = await call('/api/overall-mcp/census', { body: { action: 'stop' } });
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.stopping, true);
      const after = await waitFor(async () => {
        const res = await call('/api/overall-mcp/census', { method: 'GET' });
        return res.body.walking ? null : res.body;
      });
      assert.equal(after.ended?.reason, 'user', 'it says a reader ended it, not that it was unloaded');
      assert.equal(after.rows, 1, 'the census that was on disk survives a stopped walk');
      // …and the stop is written down as an unfinished census, so the next
      // start resumes instead of believing the walk that stopped had finished.
      assert.equal(after.complete, false);
      assert.match(String(after.partial), /已手动停止/);
      assert.equal(requests, 1, 'stopping cost nothing: no request was made to cancel one');

      // Stopping again is not an error: the second stop reports that there was
      // nothing left to stop, which is what a double click deserves.
      const nothing = await call('/api/overall-mcp/census', { body: { action: 'stop' } });
      assert.equal(nothing.body.stopping, false);
      assert.equal(nothing.body.walking, false);
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

      // Leave nothing in flight. The walk paces itself 150ms per repository, so
      // it outlives the assertions above — and the next case installs its own
      // fetch stub, which a walk from *this* host would then read through (that
      // leak showed up as one unexplained raw request in the recovery-verbs case).
      await waitFor(async () => {
        const status = await call('/api/overall-mcp/status', { method: 'GET' });
        return status.body?.evidence?.walking === false ? true : null;
      });
    }, { files });
  });
});

test('the recovery walk is a GET that starts nothing, and stop ends it where it is', async () => {
  // The second background walk, and the one that most needs a stop: it reads
  // two thousand repositories at 150ms each. Same contract as the census verbs
  // (a GET only reads, a stop keeps what was already recovered), plus the two
  // things this walk owns: `force` is not what the button means, and a stop a
  // reader asked for is not a stop a credential would have prevented.
  const rows = [
    censusRow('acme/calendar-mcp', { stars: 900 }),
    censusRow('acme/mystery-mcp', { stars: 800 }),
    censusRow('acme/silent-mcp', { stars: 700 }),
  ];
  const files = { 'github-index.json': censusDocument(rows, { at: new Date().toISOString() }) };
  let rawReads = 0;
  const stub = async (url, init = {}) => {
    const target = String(url);
    // One repository with a manifest, one that never answers. Everything the
    // walk asks the first repository for is answered (a 404 for the files it
    // does not have is an answer); the second one hangs until it is aborted.
    if (target.includes('raw.githubusercontent.com/acme/calendar-mcp/')) {
      rawReads += 1;
      if (!target.endsWith('/HEAD/package.json')) return { ok: false, status: 404, text: async () => 'Not Found' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'acme-calendar-mcp', bin: { 'acme-calendar-mcp': 'cli.js' } }) };
    }
    if (target.startsWith('https://registry.npmjs.org/')) {
      rawReads += 1;
      return { ok: true, status: 200, text: async () => '{}' };
    }
    if (target.includes('raw.githubusercontent.com')) {
      // The second repository never answers on its own, so the walk is still in
      // flight when the stop arrives — and the stop reaches the request itself,
      // because the walk hands its signal down to the reader. The fallback timer
      // only keeps a run from hanging if that wiring ever breaks.
      rawReads += 1;
      return new Promise((resolve, reject) => {
        const signal = init?.signal;
        const settle = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve({ ok: false, status: 404, text: async () => 'Not Found' });
        }, 500);
        settle.unref?.();
        function onAbort() {
          clearTimeout(settle);
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        }
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    throw new Error(`unexpected request in this test: ${target}`);
  };
  await withFetchStub(stub, async () => {
    await withHost(FIXTURE, async ({ dir, call }) => {
      const before = await call('/api/overall-mcp/install-evidence', { method: 'GET' });
      assert.equal(before.status, 200);
      assert.equal(before.body.rows, 0);
      assert.equal(before.body.walking, false, 'reading the recovery starts nothing');
      // A read reports state, not the outcome of a verb: `started`/`stopping`
      // belong to the call that asked for one, so their absence here is the
      // contract rather than a missing field.
      assert.equal(before.body.started, undefined);
      assert.equal(before.body.stopping, undefined);

      const bogus = await call('/api/overall-mcp/install-evidence', { body: { action: 'stpo' } });
      assert.equal(bogus.status, 400);
      assert.match(String(bogus.body.error), /unknown evidence action/);
      assert.equal(rawReads, 0, 'a rejected verb reads nothing upstream either');

      const started = await call('/api/overall-mcp/install-evidence', { body: { action: 'start' } });
      assert.equal(started.body.started, true);
      assert.equal(started.body.walking, true, 'the walk is in flight, not awaited');

      // Wait for the walk to be *in* the first repository rather than for the
      // file: this walk writes once, when it ends, so the file is what proves a
      // stop lost nothing — not what proves a stop is possible.
      const during = await waitFor(async () => {
        const res = await call('/api/overall-mcp/install-evidence', { method: 'GET' });
        return res.body.progress?.attempted >= 1 ? res.body : null;
      });
      assert.equal(during.walking, true);
      assert.equal(during.started, undefined, 'reading is not starting');
      assert.equal(during.rows, 0, 'a walk that has not ended has written no document yet');

      // Asking again while it walks does not begin a second one.
      const again = await call('/api/overall-mcp/install-evidence', { body: { action: 'start' } });
      assert.equal(again.body.started, false);
      assert.equal(again.body.walking, true);
      assert.equal(again.body.skipped, undefined, 'a walk that is already running is not a skip');

      const readsBeforeStop = rawReads;
      const stopped = await call('/api/overall-mcp/install-evidence', { body: { action: 'stop' } });
      assert.equal(stopped.body.stopping, true);
      await waitFor(async () => {
        const res = await call('/api/overall-mcp/install-evidence', { method: 'GET' });
        return res.body.walking === false ? true : null;
      });
      assert.equal(rawReads, readsBeforeStop, 'stopping is not a request of its own');

      const after = await call('/api/overall-mcp/install-evidence', { method: 'GET' });
      assert.equal(after.body.ended.reason, 'user');
      assert.equal(after.body.rows, 1, 'the row recovered before the stop is still there');
      assert.equal(after.body.withCommand, 1);
      assert.equal(after.body.complete, false, 'a stopped walk is not a finished recovery');
      assert.match(String(after.body.partial), /已手动停止/);
      assert.doesNotMatch(String(after.body.partial), /token/, 'a stop the reader asked for is not answered with "get a token"');

      const nothing = await call('/api/overall-mcp/install-evidence', { body: { action: 'stop' } });
      assert.equal(nothing.body.stopping, false, 'a second stop has nothing left to stop');
      assert.equal(nothing.body.walking, false);

      // What a stop costs: nothing that was already recovered. The document the
      // stopped pass wrote holds the one command it had confirmed, and says the
      // pass is unfinished so the next "start" carries on from there.
      const held = JSON.parse(await fs.readFile(path.join(dir, 'install-evidence.json'), 'utf8'));
      const calendar = held.rows.find((row) => row.id === 'github:acme/calendar-mcp');
      assert.equal(calendar.kind, 'package.json');
      assert.deepEqual(calendar.install, { transport: 'stdio', command: 'npx', args: ['-y', 'acme-calendar-mcp'] });
      assert.equal(held.rows.some((row) => row.id === 'github:acme/mystery-mcp'), false, 'the repository it was reading when stopped is not inventing an answer');
      assert.equal(held.partial != null, true, 'the unfinished pass is written down for the next one');
    }, { files });
  });
});

test('the recovery button does not re-read rows that already have an answer', async () => {
  // `force` is the difference between "carry on" and "do it all again": without
  // it, a row whose last look found nothing is left alone until its window
  // passes, and a census with nothing left to check says so instead of walking.
  const rows = [censusRow('acme/calendar-mcp', { stars: 900 }), censusRow('acme/mystery-mcp', { stars: 800 })];
  const files = {
    'github-index.json': censusDocument(rows, { at: new Date().toISOString() }),
    'install-evidence.json': evidenceDocument([
      evidenceRow('github:acme/calendar-mcp'),
      evidenceRow('github:acme/mystery-mcp', { kind: 'none', reason: '仓库里没有可识别的清单文件' }),
    ]),
  };
  await withFetchStub(async (url) => { throw new Error(`no network in this test: ${url}`); }, async () => {
    await withHost(FIXTURE, async ({ call }) => {
      const answer = await call('/api/overall-mcp/install-evidence', { body: { action: 'start' } });
      assert.equal(answer.body.started, false);
      assert.equal(answer.body.walking, false);
      assert.equal(answer.body.skipped, 'nothing-to-do');
      assert.equal(answer.body.rows, 2, 'the rows that already have an answer are still reported');
      assert.equal(answer.body.withCommand, 1);
    }, { files });

    // …and a host with no census at all says that, rather than "done".
    await withHost(FIXTURE, async ({ call }) => {
      const answer = await call('/api/overall-mcp/install-evidence', { body: { action: 'start' } });
      assert.equal(answer.body.started, false);
      assert.equal(answer.body.skipped, 'no-census');
      assert.equal(answer.body.rows, 0);
    });
  });
});

test('a spent search budget reads as a wait, and nothing spends from it again', async () => {
  // Two background walks can be alive during this case, and they spend two
  // different budgets: the census walk asks the search API (10 requests/minute
  // anonymously), while the install-evidence walk reads raw repository files
  // (60 core requests/hour). Only the first one is what "an emptied window"
  // means, so the stub counts them separately — a single counter mixed them and
  // the case failed whenever the evidence walk happened to read a file first
  // (the stub threw on those raw URLs, `readRepoFile` labelled it a network
  // failure, and the request counter still went up).
  let requests = 0;
  let rawReads = 0;
  const refused = async (url) => {
    if (!/api\.github\.com\/search\/repositories/.test(String(url))) {
      rawReads += 1;
      throw new Error('offline (this test only answers the search API)');
    }
    requests += 1;
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
      //
      // The wait must not itself perform the call under test: /status never
      // asks an upstream (the census is a file read), while re-issuing the
      // catalog call would spend from exactly the window this case is trying to
      // prove is unspendable — a poll with real requests measures the poll, and
      // the request counter below is the assertion.
      await waitFor(async () => {
        const status = await call('/api/overall-mcp/status', { method: 'GET' });
        return status.body?.census?.walking === false ? true : null;
      });
      assert.equal(requests, 1, 'the walk itself stopped asking once the window was known to be empty');
      const second = await call('/api/overall-mcp/catalog', {
        body: { source: 'github-mcp', limit: 100, refresh: true },
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

/**
 * Leave no walk running for whichever test runs next.
 *
 * A census walk that *finishes* deliberately starts the evidence walk — the
 * host's own comment says why ("a census that just grew is the cheapest moment
 * to ask the repositories themselves how they are run"), and the two walks
 * share no quota. That second walk reads raw.githubusercontent.com at 150ms per
 * repository, so a test which returns while it is still going lends its
 * requests to the next test, where a counter reports a read this test never
 * made. This is the same class of cross-test leak the census itself had in
 * round 22: the fix belongs in the test that finishes the walk, not in the
 * counter of the test that follows it.
 */
async function quietEvidence(call, { polls = 60, everyMs = 5 } = {}) {
  let seen = false;
  for (let i = 0; i < polls; i += 1) {
    const state = await call('/api/overall-mcp/install-evidence', { method: 'GET' });
    const body = state.body ?? {};
    if (body.walking) {
      seen = true;
      await call('/api/overall-mcp/install-evidence', { body: { action: 'stop' } });
    } else if (seen) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return null;
}

// ---------------------------------------------------------------------------
// 「配置界面该由 MCP 的要求决定」.
// ---------------------------------------------------------------------------
// A Smithery row installed before its detail was consulted knows that it takes
// configuration (`--config` is right there in its args) and nothing about what
// it takes. The sheet used to open on that row with an empty free-form form and
// the line 「这个来源没有声明配置项」 — which read as this panel giving up, over a
// server that does declare a required key. The click now asks the source, so the
// form is the server's own list of requirements, and 「不用配置」 is only ever
// said after the source has answered.
test('opening 配置 asks Smithery for the requirements a row was installed without', async () => {
  const registry = {
    version: 1,
    servers: [{
      name: 'brave-search',
      source: 'catalog:smithery',
      transport: 'stdio',
      enabled: false,
      command: 'npx',
      args: ['-y', '@smithery/cli', 'run', 'brave'],
      // Written by an older build: the channel is known, the requirements are not.
      config: { fields: [], origin: 'smithery', via: 'cli-json', flag: '--config' },
    }],
  };
  const asked = [];
  await withFetchStub(async (url) => {
    asked.push(String(url));
    return new Response(JSON.stringify({
      qualifiedName: 'brave',
      remote: true,
      connections: [{
        type: 'http',
        deploymentUrl: 'https://brave.run.tools',
        configSchema: {
          type: 'object',
          required: ['braveApiKey'],
          properties: { braveApiKey: { type: 'string', title: 'Brave API Key' } },
        },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }, async () => {
    await withHost(registry, async ({ call, readRegistry }) => {
      const reply = await call('/api/overall-mcp/config-hints', { body: { name: 'brave-search', slot: 0 } });
      assert.equal(reply.status, 200);
      assert.equal(reply.body.healed, true);
      assert.deepEqual(asked, ['https://registry.smithery.ai/servers/brave']);
      const row = reply.body.server;
      // The sheet is opened on this row: it must name the required key, not offer
      // a blank line where a key belongs.
      assert.equal(row.config.origin, 'smithery');
      assert.equal(row.channel, 'cli-json');
      assert.deepEqual(row.config.fields.map((f) => f.key), ['braveApiKey']);
      assert.deepEqual(row.config.missing, ['braveApiKey']);
      assert.equal(row.config.fields[0].required, true);
      assert.equal(row.needConfig, true);
      // Written down, so the next click costs no request — and the row keeps the
      // channel it needs to deliver the value.
      const saved = await readRegistry();
      assert.equal(saved.servers[0].config.via, 'cli-json');
      assert.equal(saved.servers[0].config.flag, '--config');
      assert.deepEqual(saved.servers[0].config.schema.required, ['braveApiKey']);
      const again = await call('/api/overall-mcp/config-hints', { body: { name: 'brave-search', slot: 0 } });
      assert.equal(again.body.healed, false);
      assert.equal(asked.length, 1);
    });
  });
});

// A row that names no source at all is not an error: the sheet still opens, it
// just has nothing to declare. What it must not do is claim to have asked.
test('a row nothing can be asked about answers with itself, unhealed', async () => {
  const registry = {
    version: 1,
    servers: [{ name: 'fs', source: 'manual', transport: 'stdio', enabled: false, command: 'my-own-fs', args: ['--root', '.'] }],
  };
  let requests = 0;
  await withFetchStub(async () => { requests += 1; throw new Error('no network in this test'); }, async () => {
    await withHost(registry, async ({ call }) => {
      const reply = await call('/api/overall-mcp/config-hints', { body: { name: 'fs', slot: 0 } });
      assert.equal(reply.status, 200);
      assert.equal(reply.body.healed, false);
      assert.equal(reply.body.server.name, 'fs');
      assert.equal(reply.body.server.config, null);
      assert.equal(requests, 0);
      const missing = await call('/api/overall-mcp/config-hints', { body: { name: 'nope', slot: 0 } });
      assert.equal(missing.status, 404);
    });
  });
});

// ---------------------------------------------------------------------------
// 「测一下这台服务器能不能用」. The dot only knows whether a fiber exists; a server
// whose process died kept its row (and even 已连接) while the model could not see
// a single tool. 检查 answers with the four facts that decide a mount and says
// which one failed, so a dead row is diagnosable instead of merely grey.
test('检查 reports which link of the mount actually failed', async () => {
  const registry = {
    version: 1,
    servers: [{
      name: 'fs',
      source: 'manual',
      transport: 'stdio',
      enabled: false,
      command: 'my-own-fs',
      args: ['--root', '.'],
      env: {},
      // A declaration the user has not filled in: the row is unfinished, and 检查
      // has to say so even though nothing is mounted.
      config: {
        origin: 'official',
        fields: [{ key: 'FS_TOKEN', kind: 'env', label: 'FS_TOKEN', required: true, secret: true, declared: true }],
      },
    }],
  };
  await withHost(registry, async ({ call, readRegistry }) => {
    const reply = await call('/api/overall-mcp/health', { body: { name: 'fs', slot: 0 } });
    assert.equal(reply.status, 200);
    // Every check runs, in a fixed order, so the panel can point at the first ✗.
    assert.deepEqual(reply.body.health.checks.map((c) => c.id), ['enabled', 'mounted', 'handshake', 'tools', 'config']);
    assert.equal(reply.body.health.attempted, false);
    assert.equal(reply.body.ok, false);
    const config = reply.body.health.checks.find((c) => c.id === 'config');
    assert.equal(config.ok, false);
    assert.match(config.detail, /FS_TOKEN/);
    assert.equal(reply.body.health.checks.find((c) => c.id === 'enabled').ok, false);
    // The verdict travels with the row for the rest of this host run, so a
    // refresh inside the same session does not forget it…
    assert.equal(reply.body.server.health.ok, false);
    // …but it is never written down: a check answers 「这一刻能用吗」, and a stored
    // answer would still be asserting itself after the process it described had
    // been restarted. The file must stay free of it.
    const saved = await readRegistry();
    assert.equal(saved.servers[0].health, undefined);
    assert.equal(typeof reply.body.health.at, 'string');
    assert.equal((await call('/api/overall-mcp/health', { body: { name: 'nope', slot: 0 } })).status, 404);
  });
});

// ---------------------------------------------------------------------------
// 上一版把体检结论写进了注册表. It read as a permanent property of the row —
// 「检查健康」 still standing the morning after the host it described had been
// restarted — so the key is now session-only, and a file that still carries one
// is cleaned on load rather than trusted or silently ignored.
test('a health verdict left in the file by an older build is dropped on load', async () => {
  const registry = {
    version: 1,
    servers: [{
      name: 'fs',
      source: 'manual',
      transport: 'stdio',
      enabled: false,
      command: 'my-own-fs',
      args: [],
      env: {},
      health: { at: '2026-10-17T00:00:00.000Z', ok: true, attempted: false, toolCount: 3, checks: [], ms: 4 },
    }],
  };
  await withHost(registry, async ({ call, readRegistry }) => {
    const saved = await readRegistry();
    assert.equal(saved.servers[0].health, undefined);
    const payload = await call('/api/overall-mcp/servers');
    assert.equal(payload.body.servers[0].health, undefined);
  });
});

// ---------------------------------------------------------------------------
// 每行那句「这台服务器是干什么的」是服务器自己写的散文（lib/about.js），语言由
// 它的作者决定。On a Chinese panel with an English server that is one English
// line among Chinese ones, so it is translated — once per sentence, by the
// user's own model, and cached on disk so reopening the panel costs nothing.
test('purpose lines are translated once, then served from the cache', async () => {
  const seen = [];
  const stream = (options) => {
    seen.push(options);
    return (async function* chunks() { for (const chunk of textStream('["用于读取文档的工具。"]')) yield chunk; })();
  };
  const registry = {
    version: 1,
    servers: [{
      name: 'docs', source: 'manual', transport: 'stdio', enabled: false,
      command: 'x', args: [], env: {},
      about: { text: 'Tools for reading docs.', source: 'server', toolCount: 0 },
    }],
  };
  await withHost(registry, async ({ call, dir }) => {
    const first = await call('/api/overall-mcp/about-i18n', {
      body: { lang: 'zh-CN', items: [{ name: 'docs', text: 'Tools for reading docs.' }] },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.lang, 'zh', 'zh-CN and zh want the same sentence');
    assert.equal(first.body.translations.docs, '用于读取文档的工具。');
    assert.equal(first.body.unavailable, null);
    // One call, to the user's own route, at temperature 0, carrying the line and
    // the language it must be rendered in.
    assert.equal(seen.length, 1);
    assert.equal(seen[0].provider, 'fake-provider');
    assert.equal(seen[0].temperature, 0);
    assert.match(seen[0].messages[0].content[0].text, /Target language: zh/);
    assert.match(seen[0].messages[0].content[0].text, /1\. Tools for reading docs\./);
    // The translation is kept, so the next visit — even after a restart — is free.
    const cache = JSON.parse(await fs.readFile(path.join(dir, 'about-i18n.json'), 'utf8'));
    assert.deepEqual(cache, [{ lang: 'zh', source: 'Tools for reading docs.', text: '用于读取文档的工具。' }]);
    const second = await call('/api/overall-mcp/about-i18n', {
      body: { lang: 'zh', items: [{ name: 'docs', text: 'Tools for reading docs.' }] },
    });
    assert.equal(second.body.translations.docs, '用于读取文档的工具。');
    assert.equal(seen.length, 1, 'the cache answered the second visit, not the model');
  }, { llm: { stream } });
});

test('a line already in the reader\'s language is echoed back without asking', async () => {
  let calls = 0;
  const stream = () => {
    calls += 1;
    return (async function* chunks() { for (const chunk of textStream('["不该调我"]')) yield chunk; })();
  };
  await withHost(FIXTURE, async ({ call }) => {
    // 工具：… is written by this plugin in Chinese, and a command line is a
    // command line. Translating either would edit a fact rather than render it,
    // so a line the client labels as anything but `server` comes straight back.
    const reply = await call('/api/overall-mcp/about-i18n', {
      body: {
        lang: 'zh',
        items: [
          { name: 'a', text: '工具：read、write 等 2 个', source: 'tools' },
          { name: 'b', text: 'npx -y @scope/pkg --flag', source: 'command' },
        ],
      },
    });
    assert.equal(reply.body.translations.a, '工具：read、write 等 2 个');
    assert.equal(reply.body.translations.b, 'npx -y @scope/pkg --flag');
    assert.equal(reply.body.unavailable, null);
    assert.equal(reply.body.cached, 2);
    assert.equal(calls, 0, 'nothing needed translating');
  }, { llm: { stream } });
});

test('a host without a model leaves the sentence as the server wrote it', async () => {
  await withHost(FIXTURE, async ({ call }) => {
    const reply = await call('/api/overall-mcp/about-i18n', {
      body: { lang: 'zh', items: [{ name: 'docs', text: 'Tools for reading docs.' }] },
    });
    assert.equal(reply.status, 200, 'no model is not a panel error');
    assert.equal(reply.body.unavailable, 'no-llm');
    assert.deepEqual(reply.body.translations, {}, 'the client keeps the original line');
  });
});

test('a model that answers with prose does not get half-translated into the panel', async () => {
  const stream = () => (async function* chunks() {
    for (const chunk of textStream('Sure! Here is the translation you asked for:')) yield chunk;
  })();
  await withHost(FIXTURE, async ({ call }) => {
    const reply = await call('/api/overall-mcp/about-i18n', {
      body: { lang: 'zh', items: [{ name: 'docs', text: 'Tools for reading docs.' }] },
    });
    assert.equal(reply.body.unavailable, 'translate-failed');
    assert.deepEqual(reply.body.translations, {});
  }, { llm: { stream } });
});

// ---------------------------------------------------------------------------
// 配置在 `--config` 行上曾经写错袋子. A Smithery row's declared key is
// `kind: 'config'`, which means "this goes into the JSON string of the --config
// flag". The sheet wrote every non-header field to `env` — a bag that CLI never
// reads — so the save answered 已保存 while the row kept saying 还缺, forever.
test('a config-bag save lands in --config, not in env', async () => {
  const registry = {
    version: 1,
    servers: [{
      name: 'brave-search',
      source: 'catalog:smithery',
      transport: 'stdio',
      enabled: false,
      command: 'npx',
      args: ['-y', '@smithery/cli', 'run', 'brave'],
      env: {},
      config: {
        fields: [{ key: 'braveApiKey', kind: 'config', label: 'Brave API Key', required: true, secret: true, declared: true }],
        origin: 'smithery',
        via: 'cli-json',
        flag: '--config',
      },
    }],
  };
  await withHost(registry, async ({ call, readRegistry }) => {
    const reply = await call('/api/overall-mcp/configure', {
      body: { name: 'brave-search', slot: 0, config: { braveApiKey: 'BSA-test-value' } },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.saved, true);
    assert.deepEqual(reply.body.changed, [{ key: 'braveApiKey', kind: 'config', action: 'set' }]);
    // The row is satisfied, and the value is where the mount reads it.
    assert.equal(reply.body.needConfig, false);
    const row = (await readRegistry()).servers[0];
    assert.equal(row.configValues.braveApiKey, 'BSA-test-value');
    assert.equal('braveApiKey' in (row.env ?? {}), false);
    // The mask is computed on the way out, so it never reaches the file.
    assert.equal(reply.body.config.fields[0].value, '••••');
    // What the mount would actually be told — the whole point of the channel.
    assert.deepEqual(composeMountArgs(row), ['--config', '{"braveApiKey":"BSA-test-value"}']);
  });
});