import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EVIDENCE_KEEP_MS, REFRESH_PLAN_MS, RETRY_NONE_MS,
  applyInstallEvidence, crawlInstallEvidence, describeInstallSource, evidenceDocumentOf,
  installEvidenceOf, installPlanFromFiles, mergeInstallEvidence, needsInstallEvidence,
  normalizeEvidenceDocument, packageJsonPlan, pyprojectPlan, readEvidenceDocument, readmeCommands,
  serverJsonPlan,
} from '../lib/repo-install.js';

const raw = (slug, file) => `https://raw.githubusercontent.com/${slug}/HEAD/${file}`;
const at = (ms) => new Date(ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

test('package.json yields an npm plan only when the package is runnable', () => {
  const plan = packageJsonPlan(JSON.stringify({ name: '@scope/server-files', bin: { x: 'cli.js' } }));
  assert.deepEqual(plan.install, { transport: 'stdio', command: 'npx', args: ['-y', '@scope/server-files'] });
  assert.equal(plan.kind, 'package.json');

  // `mcpName` is the registry's own marker that this package is an MCP server.
  assert.ok(packageJsonPlan(JSON.stringify({ name: 'plain-lib', mcpName: 'io.github.a/b' })).install);

  assert.match(packageJsonPlan(JSON.stringify({ name: 'lib', private: true, bin: {} })).rejected, /私有包/);
  assert.match(packageJsonPlan(JSON.stringify({ name: 'lib', bin: {} })).rejected, /没有 bin/);
  assert.equal(packageJsonPlan(JSON.stringify({ bin: 'x' })), null, 'no name is not a candidate');
  assert.equal(packageJsonPlan('not json'), null);
});

test('pyproject.toml yields a PyPI plan from the two spellings that mean "this project"', () => {
  const project = pyprojectPlan('[project]\nname = "mcp-server-git"\nversion = "1.0"\n');
  assert.deepEqual(project.install, { transport: 'stdio', command: 'uvx', args: ['mcp-server-git'] });
  assert.equal(project.registry, 'pypi');
  assert.equal(pyprojectPlan('[tool.poetry]\nname = "legacy-server"\n').name, 'legacy-server');
  assert.equal(pyprojectPlan('[tool.black]\nname = "not-a-project"\n'), null);
});

test('server.json is read the way the official registry is', () => {
  const npm = serverJsonPlan(JSON.stringify({ packages: [{ registryType: 'npm', identifier: '@acme/b-mcp' }] }));
  assert.deepEqual(npm.install, { transport: 'stdio', command: 'npx', args: ['-y', '@acme/b-mcp'] });
  const pypi = serverJsonPlan(JSON.stringify({ packages: [{ registry_type: 'pypi', identifier: 'mcp-thing' }] }));
  assert.equal(pypi.install.command, 'uvx');
  const remote = serverJsonPlan(JSON.stringify({ remotes: [{ url: 'https://api.example.com/mcp' }] }));
  assert.deepEqual(remote.install, { transport: 'streamable-http', url: 'https://api.example.com/mcp' });
  assert.equal(remote.registry, null, 'a remote needs no package confirmation');
  assert.equal(serverJsonPlan(JSON.stringify({ packages: [] })), null);
});

test('the strongest manifest wins, and a refusal does not claim the row', () => {
  const plan = installPlanFromFiles({
    serverJson: JSON.stringify({ packages: [{ registryType: 'npm', identifier: 'from-server-json' }] }),
    packageJson: JSON.stringify({ name: 'from-package-json', bin: 'x' }),
    pyproject: '[project]\nname = "from-pyproject"\n',
  });
  assert.equal(plan.name, 'from-server-json');

  const fallback = installPlanFromFiles({
    packageJson: JSON.stringify({ name: 'private-one', private: true }),
    pyproject: '[project]\nname = "published-one"\n',
  });
  assert.equal(fallback.name, 'published-one', 'a private package.json does not hide a published pyproject');
});

test('README command lines are read as candidates, npx and uvx only', () => {
  const commands = readmeCommands([
    '## Install',
    '```bash',
    'npx -y @modelcontextprotocol/server-everything',
    'npx -y same-again',
    'npx same-again',
    'npx install',
    'uvx --from mcp-server-git mcp-server-git',
    'uvx mcp-server-fetch',
    'docker run -i --rm mcp/not-read',
    '```',
  ].join('\n'));
  assert.deepEqual(commands.map((c) => `${c.registry}:${c.name}`), [
    'npm:@modelcontextprotocol/server-everything',
    'npm:same-again',
    'pypi:mcp-server-git',
    'pypi:mcp-server-fetch',
  ]);
  assert.equal(commands[0].kind, 'readme');
  assert.deepEqual(commands[0].install, { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] });
});

test('a plan is refreshed monthly, a miss is retried fortnightly', () => {
  const now = () => Date.now();
  const row = { id: 'github:a/b' };
  assert.equal(needsInstallEvidence(row, null), true);

  const miss = { id: 'github:a/b', install: null, at: at(now() - DAY) };
  assert.equal(needsInstallEvidence(row, miss), false);
  assert.equal(needsInstallEvidence(row, { ...miss, at: at(now() - RETRY_NONE_MS - DAY) }), true);

  const hit = { id: 'github:a/b', install: { transport: 'stdio' }, at: at(now() - 5 * DAY) };
  assert.equal(needsInstallEvidence(row, hit), false);
  assert.equal(needsInstallEvidence(row, { ...hit, at: at(now() - REFRESH_PLAN_MS - DAY) }), true);
  assert.equal(needsInstallEvidence({}, hit), false, 'a row without an id is not a candidate');
});

test('evidence folds into the old file: fresh rows win, unseen rows age out', () => {
  const now = Date.UTC(2026, 9, 15);
  const previous = [
    { id: 'github:a/one', install: null, at: at(now - 5 * DAY), firstSeen: at(now - 40 * DAY) },
    { id: 'github:a/gone', install: null, at: at(now - EVIDENCE_KEEP_MS - DAY) },
  ];
  const rows = mergeInstallEvidence(previous, [
    { id: 'github:a/one', install: { transport: 'stdio', command: 'npx', args: ['-y', 'one'] }, kind: 'package.json', at: at(now) },
    { id: 'github:a/two', install: null, at: at(now) },
  ], { at: at(now), now: () => now });

  assert.deepEqual(rows.map((r) => r.id), ['github:a/one', 'github:a/two'], 'the stale row is dropped');
  assert.equal(rows[0].kind, 'package.json');
  assert.equal(rows[0].firstSeen, at(now - 40 * DAY), 'firstSeen survives a refresh');
});

test('a confirmed plan becomes a transport, and the row says where it came from', () => {
  const evidence = { id: 'github:a/b', kind: 'package.json', registry: 'npm', name: 'b-mcp', install: { transport: 'stdio', command: 'npx', args: ['-y', 'b-mcp'] }, at: at(Date.now()) };
  const item = applyInstallEvidence({ id: 'github:a/b', transport: 'unknown', install: null, title: 'b' }, evidence);
  assert.equal(item.transport, 'stdio');
  assert.equal(item.install.command, 'npx');
  assert.deepEqual(item.installSource, {
    kind: 'package.json', registry: 'npm', name: 'b-mcp', at: evidence.at,
    text: '命令来自仓库 package.json；npm 上已确认这个包存在',
  });
  assert.match(describeInstallSource(evidence), /package\.json.*npm 上已确认/);
  assert.match(describeInstallSource({ kind: 'readme', registry: 'pypi', install: {} }), /README.*PyPI 上已确认/);
  assert.deepEqual(applyInstallEvidence({ id: 'x', install: null }, { id: 'x', install: null }), { id: 'x', install: null }, 'no plan leaves the row alone');
  assert.equal(applyInstallEvidence({ id: 'x', install: null }, null).install, null);
});

test('the walk reads manifests, confirms the package, and records the provenance', async () => {
  const texts = new Map([
    [raw('acme/npm-server', 'package.json'), JSON.stringify({ name: 'acme-npm-server', bin: { x: 'x.js' } })],
    [raw('acme/py-server', 'pyproject.toml'), '[project]\nname = "acme-py-server"\n'],
    [raw('acme/nothing', 'README.md'), '# Nothing\n\nNo install section here.\n'],
  ]);
  const notes = [];
  const seen = [];
  const walk = await crawlInstallEvidence({
    rows: [
      { id: 'github:acme/npm-server', repository: 'https://github.com/acme/npm-server' },
      { id: 'github:acme/py-server', repository: 'https://github.com/acme/py-server' },
      { id: 'github:acme/nothing', repository: 'https://github.com/acme/nothing' },
    ],
    fetchText: async (url) => texts.get(url) ?? null,
    verifyPackage: async ({ registry, name }) => { seen.push(`${registry}:${name}`); return name !== 'acme-nothing'; },
    minIntervalMs: 0,
    onProgress: (event) => notes.push(event),
  });

  const byId = new Map(walk.rows.map((r) => [r.id, r]));
  assert.equal(byId.get('github:acme/npm-server').install.command, 'npx');
  assert.equal(byId.get('github:acme/npm-server').kind, 'package.json');
  assert.equal(byId.get('github:acme/py-server').install.command, 'uvx');
  assert.equal(byId.get('github:acme/py-server').kind, 'pyproject.toml');
  assert.equal(byId.get('github:acme/nothing').kind, 'none');
  assert.match(byId.get('github:acme/nothing').reason, /没有可识别的清单文件/);
  assert.deepEqual(seen, ['npm:acme-npm-server', 'pypi:acme-py-server'], 'only plans that need a registry are confirmed');
  assert.equal(walk.complete, true);
  // server.json is asked before package.json, and the README only when no
  // manifest answers: 2 + 1 (confirm), 3 + 1, 4.
  assert.equal(walk.requests, 11);
  assert.equal(notes.length, 3);
});

test('a README command only counts once its package confirms', async () => {
  const texts = new Map([
    [raw('acme/readme-only', 'README.md'), 'Run it:\n\n```bash\nnpx -y ghost-package\nnpx -y acme-real-server\n```\n'],
    [raw('acme/none', 'README.md'), 'Run it:\n\n```bash\nnpx -y ghost-package\n```\n'],
  ]);
  const asked = [];
  const walk = await crawlInstallEvidence({
    rows: [
      { id: 'github:acme/readme-only', repository: 'acme/readme-only' },
      { id: 'github:acme/none', repository: 'acme/none' },
    ],
    fetchText: async (url) => texts.get(url) ?? null,
    verifyPackage: async ({ name }) => { asked.push(name); return name === 'acme-real-server'; },
    minIntervalMs: 0,
  });

  const byId = new Map(walk.rows.map((r) => [r.id, r]));
  assert.equal(byId.get('github:acme/readme-only').kind, 'readme');
  assert.deepEqual(byId.get('github:acme/readme-only').install.args, ['-y', 'acme-real-server']);
  assert.equal(byId.get('github:acme/readme-only').name, 'acme-real-server');
  assert.equal(byId.get('github:acme/none').install, null);
  assert.equal(byId.get('github:acme/none').kind, 'none');
  assert.deepEqual(asked, ['ghost-package', 'acme-real-server', 'ghost-package']);
});

test('a remote-only server.json needs no confirmation, and a budget stop keeps what it found', async () => {
  const texts = new Map([
    [raw('acme/remote', 'server.json'), JSON.stringify({ remotes: [{ url: 'https://acme.test/mcp' }] })],
    [raw('acme/npm-server', 'package.json'), JSON.stringify({ name: 'acme-npm-server', bin: 'x' })],
  ]);
  const verified = [];
  const walk = await crawlInstallEvidence({
    rows: [
      { id: 'github:acme/remote', repository: 'acme/remote' },
      { id: 'github:acme/npm-server', repository: 'acme/npm-server' },
      { id: 'github:acme/third', repository: 'acme/third' },
    ],
    fetchText: async (url) => texts.get(url) ?? null,
    verifyPackage: async ({ name }) => { verified.push(name); return true; },
    minIntervalMs: 0,
    maxRequests: 2,
  });

  assert.deepEqual(verified, [], 'the remote plan spends its request on the file, not on a registry');
  assert.equal(walk.rows[0].install.transport, 'streamable-http');
  assert.equal(walk.complete, false);
  assert.match(walk.partial, /请求预算用完（2 次）/);
  assert.equal(walk.requests, 2);
});

test('a walk that runs out of time stops with a time reason, not a request failure', async () => {
  let clock = 0;
  const walk = await crawlInstallEvidence({
    rows: [
      { id: 'github:acme/one', repository: 'acme/one' },
      { id: 'github:acme/two', repository: 'acme/two' },
    ],
    fetchText: async () => { clock += 1000; return null; },
    verifyPackage: async () => true,
    minIntervalMs: 0,
    maxMs: 5000,
    now: () => clock,
  });
  assert.equal(walk.complete, false);
  assert.match(walk.partial, /本次时间用完（约 0 分钟）/);
  assert.ok(walk.requests < 8, `stopped early, spent ${walk.requests}`);
});

test('an upstream refusal is named as one, and the walk keeps what it already found', async () => {
  const texts = new Map([[raw('acme/one', 'package.json'), JSON.stringify({ name: 'acme-one', bin: 'x' })]]);
  const walk = await crawlInstallEvidence({
    rows: [
      { id: 'github:acme/one', repository: 'acme/one' },
      { id: 'github:acme/two', repository: 'acme/two' },
    ],
    fetchText: async (url) => {
      if (!texts.has(url) && url.includes('acme/two')) {
        const err = new Error('HTTP 429');
        err.code = 'refused';
        throw err;
      }
      return texts.get(url) ?? null;
    },
    verifyPackage: async () => true,
    minIntervalMs: 0,
  });
  assert.equal(walk.rows.find((r) => r.id === 'github:acme/one').install.command, 'npx');
  assert.equal(walk.complete, false);
  assert.match(walk.partial, /上游要求降速：HTTP 429/);
});

test('a damaged evidence file is reported, and a missing one is simply "nothing yet"', async () => {  const missing = await readEvidenceDocument('nope.json', async () => { const err = new Error('nope'); err.code = 'ENOENT'; throw err; });
  assert.deepEqual(missing, { doc: null, damaged: null });

  const broken = await readEvidenceDocument('bad.json', async () => '{oops');
  assert.equal(broken.doc, null);
  assert.match(broken.damaged, /damaged/);

  const good = await readEvidenceDocument('ok.json', async () => JSON.stringify(evidenceDocumentOf({
    at: at(Date.now()), rows: [{ id: 'github:a/b', install: null, at: at(Date.now()) }], requests: 3,
  })));
  assert.equal(good.damaged, null);
  assert.equal(installEvidenceOf(good.doc, 'github:a/b').id, 'github:a/b');
  assert.equal(installEvidenceOf(good.doc, 'github:a/missing'), null);

  const empty = normalizeEvidenceDocument({ rows: [{ id: 'x' }, { nope: 1 }] });
  assert.deepEqual(empty.rows.map((r) => r.id), ['x']);
  assert.equal(empty.partial, null);
});
