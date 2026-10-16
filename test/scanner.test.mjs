// test/scanner.test.mjs — pure-logic tests for lib/scanner.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeServer, extractJsonServers, extractCodexTomlServers,
  scanHost, mergeIntoRegistry, collapseDuplicateRows, scannedSources, findOrphans,
  setMountHolder, clearMountHolder,
} from '../lib/scanner.js';

test('normalizeServer stdio', () => {
  const e = normalizeServer('fs', { command: 'npx', args: ['-y', 'x'], env: { A: '1' } }, 'cursor');
  assert.equal(e.transport, 'stdio');
  assert.equal(e.command, 'npx');
  assert.deepEqual(e.args, ['-y', 'x']);
  assert.equal(e.source, 'cursor');
  assert.equal(e.enabled, true);
});

test('normalizeServer http with type discriminator', () => {
  const e = normalizeServer('api', { type: 'http', url: 'https://e/x', headers: { a: 'b', bad: 1 } }, 'vscode');
  assert.equal(e.transport, 'streamable-http');
  assert.deepEqual(e.headers, { a: 'b' });
});

test('normalizeServer rejects garbage', () => {
  assert.equal(normalizeServer('x', null, 'x'), null);
  assert.equal(normalizeServer('x', { args: [] }, 'x'), null);
  assert.equal(normalizeServer('x', { type: 'http' }, 'x'), null);
});

test('extractJsonServers reads mcpServers key', () => {
  assert.deepEqual(extractJsonServers({ mcpServers: { a: { command: 'x' } } }), { a: { command: 'x' } });
  assert.deepEqual(extractJsonServers({ foo: 1 }), {});
});

test('extractCodexTomlServers parses command/args/env', () => {
  const toml = `
[mcp_servers.fs]
command = "npx"
args = ["-y", "@x/fs"]
env = { K = "v" }

[other]
x = 1

[mcp_servers.http1]
url = "https://h/mcp"
`;
  const s = extractCodexTomlServers(toml);
  assert.equal(s.fs.command, 'npx');
  assert.deepEqual(s.fs.args, ['-y', '@x/fs']);
  assert.equal(s.http1.url, 'https://h/mcp');
});

test('scanHost merges multiple apps and reports missing files', async () => {
  const files = new Map([
    ['/h/.cursor/mcp.json', JSON.stringify({ mcpServers: { cur: { command: 'npx' } } })],
    ['/h/.codex/config.toml', '[mcp_servers.cx]\ncommand = "uvx"\nargs = ["y"]\n'],
  ]);
  const readFile = async (f) => files.get(f) ?? (() => { const e = new Error('nf'); e.code = 'ENOENT'; throw e; })();
  const { found, report } = await scanHost({ homedir: '/h', readFile });
  const names = found.map((f) => f.name).sort();
  assert.ok(names.includes('cur'));
  assert.ok(names.includes('cx'));
  assert.ok(report.every((r) => Array.isArray(r.serverNames)));
});

test('mergeIntoRegistry keeps a hand-added entry and never duplicates the name', () => {
  const registry = { version: 1, servers: [{ name: 'fs', source: 'manual', transport: 'stdio', command: 'other' }] };
  const found = [
    { name: 'fs', source: 'cursor', transport: 'stdio', command: 'npx', args: [] },
    { name: 'new', source: 'vscode', transport: 'stdio', command: 'x', args: [] },
  ];
  const r = mergeIntoRegistry(registry, found);
  assert.ok(r.added.includes('new'));
  assert.deepEqual(r.updated, []);
  assert.ok(r.skipped.includes('fs'), 'a manual entry owns its name');
  assert.equal(r.registry.servers.length, 2);
  assert.equal(r.registry.servers[0].command, 'other', 'manual command untouched');
});

test('mergeIntoRegistry updates an imported entry in place and keeps local state', () => {
  const registry = {
    version: 1,
    servers: [{ name: 'cur', source: 'cursor', enabled: false, transport: 'stdio', command: 'old', args: [] }],
  };
  const found = [{ name: 'cur', source: 'cursor', enabled: true, transport: 'stdio', command: 'new', args: ['--x'] }];
  const r = mergeIntoRegistry(registry, found);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.updated, ['cur']);
  assert.equal(r.registry.servers.length, 1, 'no name-cursor duplicate row');
  assert.equal(r.registry.servers[0].name, 'cur');
  assert.equal(r.registry.servers[0].command, 'new');
  assert.deepEqual(r.registry.servers[0].args, ['--x']);
  assert.equal(r.registry.servers[0].enabled, false, 'a local 停用 outranks the config file');

  const same = mergeIntoRegistry(registry, [{ ...found[0], command: 'old', args: [] }]);
  assert.deepEqual(same.updated, []);
  assert.ok(same.skipped.includes('cur'), 'an identical re-scan is a no-op');
});

test('mergeIntoRegistry keeps the document keys a scan does not own', () => {
  // `favorites` lives beside `servers` in the same document. The merge used to
  // return a fresh `{version, servers}` object, and the caller saves what it
  // returns — so one scan silently un-starred every market bookmark.
  const registry = {
    version: 1,
    favorites: ['smithery:brave', 'official:ac.snag/snag'],
    scanned: { at: '2026-01-01T00:00:00.000Z', sources: ['cursor'], unreadable: [] },
    servers: [],
  };
  const r = mergeIntoRegistry(registry, [{ name: 'cur', source: 'cursor', transport: 'stdio', command: 'npx', args: [] }]);
  assert.deepEqual(r.registry.favorites, ['smithery:brave', 'official:ac.snag/snag']);
  assert.deepEqual(r.registry.servers.map((s) => s.name), ['cur']);
  assert.equal(registry.servers.length, 0, 'the input registry itself is still untouched');
  // A registry with nothing but `servers` (or nothing at all) still works.
  assert.deepEqual(mergeIntoRegistry(null, []).registry, { version: 1, servers: [] });
});

// The reported state: a config that defines `rea` while an entry named `rea`
// already existed left `rea-cursor` rows behind, all pinned to a stale version.
// They are found by comparing the registry against what the last scan actually
// read — but only the ones that mount nothing. The row that is holding a mount
// serves tools (on this machine: `rea-cursor` at 6.5.0, the `mcp__rea-cursor__*`
// namespace), and no config file mentioning it is not a reason to take it away.
test('findOrphans names imported entries their own source no longer defines', () => {
  const registry = {
    version: 1,
    servers: [
      { name: 'rea', source: 'cursor', transport: 'stdio', command: 'cmd.exe', args: ['/d', '/c', 'npx', '-y', 'rea-agents@6.1.0', 'mcp'] },
      { name: 'rea-cursor', source: 'cursor', transport: 'stdio', command: 'cmd.exe', args: [], serverName: 'rea-cursor' },
      { name: 'rea-cursor', source: 'cursor', transport: 'stdio', command: 'cmd.exe', args: [] },
      { name: 'tayily-mcp', source: 'claude-desktop', transport: 'stdio', command: 'npx', args: [] },
      { name: 'hand', source: 'manual', transport: 'stdio', command: 'x', args: [] },
    ],
  };
  const scanned = { at: '2026-10-15T13:19:28.457Z', sources: { cursor: ['rea'], 'claude-desktop': ['tayily-mcp'] }, unreadable: [] };
  const orphans = findOrphans(registry, scanned);
  assert.deepEqual(orphans.map((s) => s.name), ['rea-cursor']);
  assert.equal(orphans[0], registry.servers[2], 'the inert row is named');
  assert.ok(!orphans.includes(registry.servers[1]),
    'the row that holds a mount is left alone: it is the entry serving the tools');
});

test('findOrphans refuses to judge a source the scan could not read', () => {
  const registry = {
    version: 1,
    servers: [
      { name: 'solo', source: 'windsurf', transport: 'stdio', command: 'x', args: [] },
      { name: 'ghost', source: 'cursor', transport: 'stdio', command: 'x', args: [] },
    ],
  };
  // windsurf was never read (no file), cursor was read and did not define `ghost`.
  assert.deepEqual(findOrphans(registry, { sources: { cursor: ['rea'] } }).map((s) => s.name), ['ghost']);
  // No scan at all: nothing can be proven, so nothing is flagged.
  assert.deepEqual(findOrphans(registry, null), []);
  assert.deepEqual(findOrphans(registry, {}), []);
});

test('findOrphans never names a row that is holding a mount', () => {
  const registry = {
    version: 1,
    servers: [
      // No config file mentions this one, and it is the only row for the name:
      // sweeping it would disconnect the tools it is serving right now.
      { name: 'rea-cursor', source: 'cursor', transport: 'stdio', command: 'cmd.exe', args: [], serverName: 'rea-cursor' },
    ],
  };
  assert.deepEqual(findOrphans(registry, { sources: { cursor: ['rea'] } }), []);
  // An empty `serverName` is the "not mounted" case, so that same row is swept
  // once it really has no mount behind it.
  assert.deepEqual(
    findOrphans({ servers: [{ ...registry.servers[0], serverName: '' }] }, { sources: { cursor: ['rea'] } }).map((s) => s.name),
    ['rea-cursor'],
  );
});

// `fibers` is keyed by name, so one row per name holds the mount — but a run of
// per-row 「更新」 on four same-named rows stamped three of them, and findOrphans
// reads that stamp to decide which rows are still alive. Exclusive or absent.
test('setMountHolder keeps exactly one row of a duplicated name marked', () => {
  const rows = [
    { name: 'rea-cursor', serverName: 'rea-cursor' },
    { name: 'rea-cursor' },
    { name: 'other', serverName: 'other' },
  ];
  setMountHolder(rows, 'rea-cursor', rows[1], 'rea-cursor');
  assert.equal(rows[0].serverName, undefined, 'the previous holder gives the mark up');
  assert.equal(rows[1].serverName, 'rea-cursor');
  assert.equal(rows[2].serverName, 'other', 'another name is none of this call\u2019s business');
  clearMountHolder(rows, 'rea-cursor');
  assert.equal(rows[0].serverName, undefined);
  assert.equal(rows[1].serverName, undefined);
});

test('an inert duplicate of a mounted name is still swept', () => {
  const rows = [
    { name: 'rea-cursor', source: 'cursor', transport: 'stdio', command: 'cmd.exe', args: [] },
    { name: 'rea-cursor', source: 'cursor', transport: 'stdio', command: 'cmd.exe', args: [] },
  ];
  setMountHolder(rows, 'rea-cursor', rows[0], 'rea-cursor');
  const scanned = { sources: { cursor: ['rea'] } };
  assert.deepEqual(findOrphans({ servers: rows }, scanned), [rows[1]]);
  // With the mount gone, both rows are leftovers and both are sweepable.
  clearMountHolder(rows, 'rea-cursor');
  assert.deepEqual(findOrphans({ servers: rows }, scanned), rows);
});

// The old merge renamed a conflicting import to `name-<source>` and pushed a new
// row per scan, so one Cursor entry left four `rea-cursor` rows behind. Three of
// them carried a mount stamp from the version that did not stamp exclusively,
// which is why findOrphans() refused to clean them: same name, same contract
// means one server, and collapsing has to keep the row that owns the mount.
test('collapseDuplicateRows keeps one row per name and contract, and says what it dropped', () => {
  const row = (over = {}) => ({
    name: 'rea-cursor', source: 'cursor', transport: 'stdio', command: 'cmd.exe',
    args: ['/d', '/c', 'npx', '-y', 'rea-agents@6.5.0', 'mcp'], enabled: true, ...over,
  });
  const registry = {
    favorites: ['official-registry:foo'],
    servers: [
      row({ importedAt: '2026-10-13T08:23:07Z' }),
      row({ serverName: 'rea-cursor', importedAt: '2026-10-13T08:33:56Z' }),
      row({ serverName: 'rea-cursor', importedAt: '2026-10-13T08:33:57Z', providedExternally: true }),
      row({ importedAt: '2026-10-14T06:53:56Z' }),
      // Same contract, different name: a second install, not a duplicate.
      row({ name: 'rea', providedExternally: true, importedAt: '2026-10-12T00:54:29Z' }),
      // Same name, different contract: a changed server, not a duplicate.
      row({ args: ['/d', '/c', 'npx', '-y', 'rea-agents@6.1.0', 'mcp'] }),
    ],
  };
  const { registry: out, collapsed } = collapseDuplicateRows(registry);
  assert.deepEqual(collapsed, [{ name: 'rea-cursor', dropped: 3 }]);
  assert.deepEqual(out.servers.map((s) => s.args.at(-2)), ['rea-agents@6.5.0', 'rea-agents@6.5.0', 'rea-agents@6.1.0']);
  assert.deepEqual(out.servers.map((s) => s.name), ['rea-cursor', 'rea', 'rea-cursor']);
  const kept = out.servers[0];
  assert.equal(kept.serverName, 'rea-cursor', 'the row holding the mount survives');
  assert.equal(kept.providedExternally, true, 'a twin that was provided externally is remembered');
  assert.equal(kept.importedAt, '2026-10-13T08:23:07Z', 'the first sighting wins');
  assert.deepEqual(out.favorites, ['official-registry:foo'], 'top-level keys are not the collapse\u2019s business');
  assert.equal(registry.servers.length, 6, 'the input is not mutated');
});

test('collapseDuplicateRows never turns a mounted server off, and never turns one on', () => {
  const row = (over = {}) => ({
    name: 'x', transport: 'stdio', command: 'npx', args: ['-y', 'x'], ...over,
  });
  const on = collapseDuplicateRows({ servers: [row({ serverName: 'x' }), row({ enabled: false })] });
  assert.equal(on.registry.servers.length, 1);
  assert.equal(on.registry.servers[0].enabled, undefined, 'the surviving row keeps its own state');
  const off = collapseDuplicateRows({ servers: [row({ enabled: false, serverName: 'x' }), row()] });
  assert.equal(off.registry.servers[0].enabled, false);
});

test('mergeIntoRegistry reports the duplicate rows it collapsed', () => {
  const twin = (at) => ({
    name: 'rea-cursor', source: 'cursor', transport: 'stdio', command: 'cmd.exe',
    args: ['/d', '/c', 'npx', '-y', 'rea-agents@6.5.0', 'mcp'], enabled: true, importedAt: at,
  });
  const registry = { version: 1, servers: [twin('a'), twin('b'), twin('c')] };
  const found = [{ name: 'rea', source: 'cursor', transport: 'stdio', command: 'cmd.exe', args: registry.servers[0].args }];
  const r = mergeIntoRegistry(registry, found);
  assert.deepEqual(r.collapsed, [{ name: 'rea-cursor', dropped: 2 }]);
  assert.equal(r.registry.servers.filter((s) => s.name === 'rea-cursor').length, 1);
  assert.deepEqual(r.added, ['rea'], 'a different name is still an import');
});

test('scannedSources separates "read and empty" from "could not read"', () => {
  const read = scannedSources([
    { app: 'cursor', file: '/h/.cursor/mcp.json', serverNames: ['cur'] },
    { app: 'vscode', file: '/h/Code/User/mcp.json', serverNames: [] },
    { app: 'windsurf', file: '/h/.codeium/windsurf/mcp_config.json', error: 'not-found' },
    { app: 'gemini-cli', file: '/h/.gemini/settings.json', error: 'EACCES: permission denied' },
  ]);
  assert.deepEqual(read.sources, { cursor: ['cur'], vscode: [] });
  assert.equal('windsurf' in read.sources, false, 'a missing file is unknown, not empty');
  assert.deepEqual(read.unreadable, ['/h/.gemini/settings.json']);
});
