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
      '/api/overall-mcp/submissions', '/api/overall-mcp/submission-review',
    ]) {
      assert.ok(routes.has(route), `${route} is registered`);
    }
    for (const tool of [
      'overall_mcp_scan', 'overall_mcp_list', 'overall_mcp_search', 'overall_mcp_install',
      'overall_mcp_set_enabled', 'overall_mcp_set_source_enabled', 'overall_mcp_catalog',
      'overall_mcp_check_updates', 'overall_mcp_update', 'overall_mcp_remove',
      'overall_mcp_forget_orphans', 'overall_mcp_submissions',
    ]) {
      assert.ok(tools.has(tool), `${tool} is registered`);
    }
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

test('a submission is queued with its upload, and approving it writes a contribution row', async () => {
  const file = { name: '../../evil/notes.tgz', type: 'application/gzip', data: Buffer.from('hello').toString('base64') };
  await withHost(FIXTURE, async ({ dir, call, readRegistry }) => {
    const submitted = await call('/api/overall-mcp/submissions', {
      body: { name: 'acme-mcp', link: 'https://example.test/acme', note: 'demo server', contributor: '张三', file },
    });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.status, 'pending');
    assert.equal(submitted.body.submissions.pending, 1);
    const id = submitted.body.submitted;

    // The queue is readable on its own, and the panel's list rides along with
    // /servers so one fetch renders both.
    const listed = await call('/api/overall-mcp/submissions', { method: 'GET' });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);
    assert.equal(listed.body.items[0].contributor, '张三');
    assert.equal(listed.body.items[0].file.bytes, 5);

    // The upload keeps its bytes but never its path: a submitted name with `../`
    // in it is a filename here, not a route out of the data directory.
    const stored = path.join(dir, 'submissions', id, 'notes.tgz');
    assert.equal(await fs.readFile(stored, 'utf8'), 'hello');
    assert.equal(listed.body.items[0].file.name, 'notes.tgz');

    const approved = await call('/api/overall-mcp/submission-review', {
      body: { id, decision: 'approve', install: { transport: 'stdio', command: 'npx', args: ['-y', 'acme-mcp'] } },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.entry, 'acme-mcp');
    assert.equal(approved.body.displayOnly, false);
    const row = (await readRegistry()).servers.find((s) => s.name === 'acme-mcp');
    assert.equal(row.source, 'contribution');
    assert.equal(row.contributor, '张三');
    assert.equal(row.link, 'https://example.test/acme');
    assert.equal(row.command, 'npx');
    assert.equal(row.enabled, true, 'an approved contribution with a command is mounted');

    // A second approval under a name the registry already uses would make every
    // later name-keyed action ambiguous, so it is refused rather than guessed.
    const again = await call('/api/overall-mcp/submissions', {
      body: { name: 'acme-mcp', link: 'https://example.test/acme-2' },
    });
    const clashing = await call('/api/overall-mcp/submission-review', {
      body: { id: again.body.submitted, decision: 'approve', install: { transport: 'stdio', command: 'npx', args: ['-y', 'acme-mcp'] } },
    });
    assert.equal(clashing.status, 409);
    assert.match(clashing.body.error, /^duplicate contribution name: acme-mcp/);
  });
});

test('an approved submission with only a link is registered as display-only and cannot be enabled', async () => {
  await withHost(FIXTURE, async ({ call, readRegistry }) => {
    const submitted = await call('/api/overall-mcp/submissions', {
      body: { name: 'link-only', link: 'https://example.test/link-only' },
    });
    const approved = await call('/api/overall-mcp/submission-review', {
      body: { id: submitted.body.submitted, decision: 'approve' },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.displayOnly, true);
    assert.match(approved.body.note, /仅展示/);

    const row = (await readRegistry()).servers.find((s) => s.name === 'link-only');
    assert.equal(row.displayOnly, true);
    assert.equal(row.enabled, false, 'nothing to mount: enabled must stay false');
    assert.equal(row.command, undefined);

    // `toMcpConfig()` reads a missing command as a stdio launch, so switching
    // this row on would try to spawn `undefined`; the refusal has to say why.
    const enabled = await call('/api/overall-mcp/set-enabled', { body: { name: 'link-only', enabled: true } });
    assert.equal(enabled.status, 409);
    assert.match(enabled.body.error, /^display-only entry link-only/);

    const servers = await call('/api/overall-mcp/servers', { method: 'GET' });
    const shown = servers.body.servers.find((s) => s.name === 'link-only');
    assert.equal(shown.displayOnly, true);
    assert.equal(shown.link, 'https://example.test/link-only');
  });
});

test('a submission with no name, no link or too large a file is refused', async () => {
  await withHost(FIXTURE, async ({ call, readRegistry }) => {
    const noName = await call('/api/overall-mcp/submissions', { body: { link: 'https://example.test/x' } });
    assert.equal(noName.status, 400);
    assert.match(noName.body.error, /^invalid submission: name is required/);

    const badLink = await call('/api/overall-mcp/submissions', { body: { name: 'x', link: 'ftp://example.test/x' } });
    assert.equal(badLink.status, 400);
    assert.match(badLink.body.error, /^invalid submission: link must be an http\(s\) URL/);

    const huge = {
      name: 'huge',
      link: 'https://example.test/huge',
      file: { name: 'big.bin', data: Buffer.alloc(513 * 1024).toString('base64') },
    };
    const tooBig = await call('/api/overall-mcp/submissions', { body: huge });
    assert.equal(tooBig.status, 400);
    assert.match(tooBig.body.error, /^invalid submission: file is larger than 512 KB/);
    assert.deepEqual((await readRegistry()).servers.length, 3, 'nothing reached the registry');
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
    // The submission queue is agent-reachable too: an agent can record one,
    // list the pending ones, and approve it with the mountable information.
    assert.deepEqual(
      Object.keys(tools.get('overall_mcp_submissions').parameters).sort(),
      ['action', 'contributor', 'file', 'id', 'install', 'link', 'name', 'note', 'overwrite', 'reason', 'status'],
    );

    // The scan text used to promise the opposite of what the merge does
    // ("Existing entries are never overwritten" — an imported row *is* updated
    // in place when its command changed).
    const scan = tools.get('overall_mcp_scan').description;
    assert.ok(!/existing entries are never overwritten/i.test(scan));
    assert.match(scan, /added by hand is never overwritten/);
  });
});
