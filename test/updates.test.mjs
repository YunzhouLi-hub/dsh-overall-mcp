// test/updates.test.mjs — pure-logic tests for lib/updates.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitPackageSpec, packageSpec, parsePackageInvocation, compareVersions,
  pinArgs, checkEntryUpdate, checkAllUpdates, checkDescribesEntry,
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

// A verdict is written for the entry as it was, and it names the version it saw.
// The registry in the field held an entry pinned to 6.5.0 that still carried the
// check written when it pinned 6.1.0, so the row advertised 「可更新 → 6.5.0」 —
// an update to the version it was already running.
test('checkDescribesEntry keeps a verdict that still matches the pinned version', () => {
  const entry = { transport: 'stdio', command: 'npx', args: ['-y', 'rea-agents@6.1.0'] };
  const stored = { at: '2026-10-15T05:19:28.457Z', current: '6.1.0', latest: '6.5.0', updateAvailable: true };
  assert.equal(checkDescribesEntry(entry, stored), true);
});

test('checkDescribesEntry refuses a verdict written for a different pin', () => {
  // The entry has since moved to 6.5.0 (a re-import from the client's config),
  // and the stored verdict still describes the 6.1.0 launch.
  const entry = { transport: 'stdio', command: 'npx', args: ['-y', 'rea-agents@6.5.0'] };
  const stored = { at: '2026-10-15T05:19:28.457Z', current: '6.1.0', latest: '6.5.0', updateAvailable: true };
  assert.equal(checkDescribesEntry(entry, stored), false);
});

test('checkDescribesEntry keeps a not-checkable note and an unpinned verdict', () => {
  const direct = { transport: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] };
  assert.equal(checkDescribesEntry(direct, { detectable: false, reason: 'not launched through a package runner' }), true);
  const unpinned = { transport: 'stdio', command: 'npx', args: ['-y', 'rea-agents'] };
  assert.equal(checkDescribesEntry(unpinned, { current: '6.5.0', latest: '6.5.0', updateAvailable: false }), true);
  assert.equal(checkDescribesEntry(direct, null), false);
});

// The host writes each verdict back to the entry it was computed FROM, by
// position. It used to match by name, so a config that defines the same server
// twice stamped the first entry with the last verdict for that name and left the
// others with none — the other half of the 「可更新 → 6.5.0」 report.
test('checkAllUpdates keeps one result per entry, even when names repeat', async () => {
  const entries = [
    { name: 'rea-cursor', transport: 'stdio', command: 'npx', args: ['-y', 'rea-agents@6.5.0'] },
    { name: 'rea-cursor', transport: 'stdio', command: 'npx', args: ['-y', 'rea-agents@6.1.0'] },
  ];
  const r = await checkAllUpdates(entries, { fetchImpl: npmFetch('6.5.0') });
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries.map((e) => e.current), ['6.5.0', '6.1.0']);
  assert.deepEqual(r.entries.map((e) => e.updateAvailable), [false, true]);
});

// A lookup that errored is not a verdict of 「已是最新」: `latest` is null and
// `error` says why. The panel's summary only knew `checked`/`updatable`, so a
// machine with no registry access reported every server as up to date.
test('checkAllUpdates counts failed lookups apart from up-to-date ones', async () => {
  const entries = [
    { name: 'ok', transport: 'stdio', command: 'npx', args: ['-y', 'good-mcp@1.0.0'] },
    { name: 'off', transport: 'stdio', command: 'npx', args: ['-y', 'ghost-mcp@1.0.0'] },
  ];
  const flaky = async (url) => {
    if (String(url).includes('ghost-mcp')) throw new Error('offline');
    return { ok: true, json: async () => ({ 'dist-tags': { latest: '1.0.0' } }) };
  };
  const r = await checkAllUpdates(entries, { fetchImpl: flaky });
  assert.equal(r.checked, 2);
  assert.equal(r.updatable, 0);
  assert.equal(r.failed, 1);
  assert.equal(r.entries.find((e) => e.name === 'off').error, 'offline');
  assert.equal(r.entries.find((e) => e.name === 'ok').latest, '1.0.0');
});
