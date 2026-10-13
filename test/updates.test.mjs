// test/updates.test.mjs — pure-logic tests for lib/updates.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitPackageSpec, packageSpec, parsePackageInvocation, compareVersions,
  pinArgs, checkEntryUpdate, checkAllUpdates,
} from '../lib/updates.js';

test('splitPackageSpec handles plain and scoped specs', () => {
  assert.deepEqual(splitPackageSpec('rea-agents@6.1.0'), { pkg: 'rea-agents', version: '6.1.0' });
  assert.deepEqual(splitPackageSpec('rea-agents'), { pkg: 'rea-agents', version: null });
  assert.deepEqual(splitPackageSpec('@scope/name@1.2.3'), { pkg: '@scope/name', version: '1.2.3' });
  assert.deepEqual(splitPackageSpec('@scope/name'), { pkg: '@scope/name', version: null });
  assert.deepEqual(splitPackageSpec('@smithery/cli@latest'), { pkg: '@smithery/cli', version: 'latest' });
  assert.equal(packageSpec('rea-agents', '6.4.0'), 'rea-agents@6.4.0');
});

test('parsePackageInvocation reads direct npx and uvx invocations', () => {
  assert.deepEqual(
    parsePackageInvocation({ transport: 'stdio', command: 'npx', args: ['-y', 'rea-agents@6.1.0', 'mcp'] }),
    { manager: 'npm', pkg: 'rea-agents', version: '6.1.0', argsIndex: 1 },
  );
  assert.deepEqual(
    parsePackageInvocation({ transport: 'stdio', command: 'uvx', args: ['mcp-server-git'] }),
    { manager: 'pypi', pkg: 'mcp-server-git', version: null, argsIndex: 0 },
  );
});

test('parsePackageInvocation unwraps the Windows shell form', () => {
  const entry = {
    transport: 'stdio',
    command: 'cmd.exe',
    args: ['/d', '/c', 'npx', '-y', 'rea-agents@6.1.0', 'mcp'],
  };
  assert.deepEqual(parsePackageInvocation(entry), {
    manager: 'npm', pkg: 'rea-agents', version: '6.1.0', argsIndex: 4,
  });
});

test('parsePackageInvocation returns null for direct binaries and http', () => {
  assert.equal(parsePackageInvocation({ transport: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] }), null);
  assert.equal(parsePackageInvocation({ transport: 'stdio', command: 'python', args: ['server.py'] }), null);
  assert.equal(parsePackageInvocation({ transport: 'streamable-http', url: 'https://x' }), null);
});

test('compareVersions orders releases and prereleases', () => {
  assert.ok(compareVersions('6.4.0', '6.1.0') > 0);
  assert.ok(compareVersions('6.1.0', '6.1.0') === 0);
  assert.ok(compareVersions('6.10.0', '6.9.9') > 0);
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
});

test('pinArgs rewrites the package token in place', () => {
  const entry = { transport: 'stdio', command: 'cmd.exe', args: ['/d', '/c', 'npx', '-y', 'rea-agents@6.1.0', 'mcp'] };
  assert.deepEqual(pinArgs(entry, '6.4.0'), ['/d', '/c', 'npx', '-y', 'rea-agents@6.4.0', 'mcp']);
  const direct = { transport: 'stdio', command: 'npx', args: ['-y', 'rea-agents', 'mcp'] };
  assert.deepEqual(pinArgs(direct, '6.4.0'), ['-y', 'rea-agents@6.4.0', 'mcp']);
});

const npmFetch = (latest) => async (url) => {
  if (!String(url).includes('registry.npmjs.org')) throw new Error('unexpected url');
  return { ok: true, json: async () => ({ 'dist-tags': { latest } }) };
};

test('checkEntryUpdate reports an available update', async () => {
  const entry = { name: 'rea', transport: 'stdio', command: 'cmd.exe', args: ['/d', '/c', 'npx', '-y', 'rea-agents@6.1.0', 'mcp'] };
  const r = await checkEntryUpdate(entry, { fetchImpl: npmFetch('6.4.0') });
  assert.equal(r.detectable, true);
  assert.equal(r.pkg, 'rea-agents');
  assert.equal(r.current, '6.1.0');
  assert.equal(r.latest, '6.4.0');
  assert.equal(r.updateAvailable, true);
});

test('checkEntryUpdate treats an unpinned runner as already current', async () => {
  const entry = { name: 'x', transport: 'stdio', command: 'npx', args: ['-y', 'some-mcp'] };
  const r = await checkEntryUpdate(entry, { fetchImpl: npmFetch('2.0.0') });
  assert.equal(r.unpinned, true);
  assert.equal(r.updateAvailable, false);
});

test('checkEntryUpdate surfaces lookup failures without throwing', async () => {
  const entry = { name: 'x', transport: 'stdio', command: 'npx', args: ['-y', 'ghost-mcp@1.0.0'] };
  const failing = async () => { throw new Error('offline'); };
  const r = await checkEntryUpdate(entry, { fetchImpl: failing });
  assert.equal(r.detectable, true);
  assert.equal(r.updateAvailable, false);
  assert.equal(r.error, 'offline');
});

test('checkAllUpdates summarises the registry', async () => {
  const entries = [
    { name: 'rea', transport: 'stdio', command: 'npx', args: ['-y', 'rea-agents@6.1.0'] },
    { name: 'graph', transport: 'stdio', command: 'codegraph', args: ['serve'] },
    { name: 'smi', transport: 'stdio', command: 'npx', args: ['-y', '@smithery/cli@1.0.0'] },
  ];
  const r = await checkAllUpdates(entries, { fetchImpl: npmFetch('6.4.0') });
  assert.equal(r.checked, 2);
  assert.equal(r.updatable, 2);
  assert.equal(r.entries.find((e) => e.name === 'graph').detectable, false);
});
