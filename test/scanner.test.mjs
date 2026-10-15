// test/scanner.test.mjs — pure-logic tests for lib/scanner.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeServer, extractJsonServers, extractCodexTomlServers,
  scanHost, mergeIntoRegistry,
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
