// User-added catalogue sources (lib/custom-sources.js).
//
// What matters here is not the happy path — add a URL, get a row — but the three
// ways this list can hurt the user: a plain-http address whose install commands
// could be rewritten in transit, a credential that would be written to disk in
// clear text, and a source that changes id across restarts so its cache, counts
// and panel row all drift apart. Each has a test below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  SOURCES_MAX, addSourceTo, defaultLabelFor, emptySources, normalizeSourceUrl,
  normalizeSourcesDocument, readSourcesDocument, removeSourceFrom, sourceIdFor,
  sourcesDocumentOf, validateSourceInput,
} from '../lib/custom-sources.js';

const GH = 'https://raw.githubusercontent.com/acme/mcp-registry/main/registry.json';

test('the id is derived from the address, so it survives a restart', () => {
  const id = sourceIdFor(GH);
  assert.equal(id, sourceIdFor(GH));
  assert.match(id, /^custom:/);
  assert.ok(id.length <= 48);
  // Host case and a trailing fragment cannot make a second source out of one.
  assert.equal(sourceIdFor('https://raw.githubusercontent.com/acme/mcp-registry/main/registry.json#x'), sourceIdFor(GH));
  assert.equal(sourceIdFor('not a url'), null);
});

test('https only: the rows become commands this machine executes', () => {
  const refused = normalizeSourceUrl('http://example.com/registry.json');
  assert.match(refused.error, /https/);
  // The reason travels with the refusal, because "只接受 https" alone reads as
  // an arbitrary rule.
  assert.match(refused.error, /明文/);
  assert.equal(normalizeSourceUrl(GH).url, GH);
});

test('a credential in the URL is refused instead of persisted', () => {
  const refused = normalizeSourceUrl('https://acme:ghp_secret@raw.githubusercontent.com/acme/x/main/r.json');
  assert.match(refused.error, /用户名\/密码/);
  assert.equal(normalizeSourceUrl('https://user@example.com/r.json').error !== undefined, true);
});

test('the query is kept, the fragment is dropped', () => {
  assert.equal(normalizeSourceUrl('https://example.com/r.json?v=2#top').url, 'https://example.com/r.json?v=2');
  assert.equal(normalizeSourceUrl('  https://example.com/r.json  ').url, 'https://example.com/r.json');
  assert.equal(normalizeSourceUrl('').error, '地址不能为空');
  assert.equal(normalizeSourceUrl('not a url').error.length > 0, true);
  assert.equal(normalizeSourceUrl('https://example.com/' + 'x'.repeat(700)).error.includes('过长'), true);
});

test('a label is optional; the default names the place the user recognises', () => {
  assert.equal(defaultLabelFor(GH), 'acme/mcp-registry');
  assert.equal(defaultLabelFor('https://cdn.jsdelivr.net/gh/acme/mcp-registry@main/registry.json'), 'acme/mcp-registry');
  assert.equal(defaultLabelFor('https://example.com/catalog/registry.json'), 'example.com/catalog');
  assert.equal(defaultLabelFor('https://example.com/'), 'example.com');
  const checked = validateSourceInput({ url: GH });
  assert.deepEqual(checked.source.label, 'acme/mcp-registry');
  // An explicit label wins and is bounded.
  assert.equal(validateSourceInput({ url: GH, label: '  ' + 'x'.repeat(80) }).source.label.length, 40);
});

test('the same address cannot be added twice, under either name', () => {
  const first = validateSourceInput({ url: GH });
  const clash = validateSourceInput({ url: GH }, { existing: [first.source] });
  assert.equal(clash.ok, false);
  assert.match(clash.error, /已经添加过/);
  // A malformed address is the caller's mistake; a duplicate is a conflict with
  // state the caller did not see. The route answers with these, so they must not
  // both come back as a plugin fault.
  assert.equal(clash.status, 409);
  assert.equal(validateSourceInput({ url: 'http://x.test/r.json' }).status, 400);
  assert.throws(() => addSourceTo(emptySources(), { url: 'http://x.test/r.json' }), (err) => err.status === 400 && err.code === 'invalid-source');
  assert.throws(() => addSourceTo(addSourceTo(emptySources(), { url: GH }).doc, { url: GH }), (err) => err.status === 409);
  // Editing a row keeps its own identity without tripping the check.
  assert.equal(validateSourceInput({ url: GH }, { existing: [first.source], selfId: first.source.id }).ok, true);
});

test('add and remove keep the document in a shape the reader accepts', () => {
  const a = addSourceTo(emptySources(), { url: GH });
  assert.equal(a.doc.sources.length, 1);
  const b = addSourceTo(a.doc, { url: 'https://example.com/other.json', label: '内部镜像' });
  assert.equal(b.doc.sources.length, 2);
  assert.equal(b.source.label, '内部镜像');
  const { doc, removed } = removeSourceFrom(b.doc, a.source.id);
  assert.equal(removed.label, 'acme/mcp-registry');
  assert.deepEqual(doc.sources.map((s) => s.id), [b.source.id]);
  // Removing something that is not there is not an error, it is an empty result.
  assert.equal(removeSourceFrom(doc, 'custom:nope').removed, null);
  // Round-trip: what is written is what is read.
  assert.deepEqual(normalizeSourcesDocument(sourcesDocumentOf(doc)).sources, doc.sources);
});

test('the list is bounded', () => {
  let doc = emptySources();
  for (let i = 0; i < SOURCES_MAX; i += 1) doc = addSourceTo(doc, { url: `https://example.com/${i}.json` }).doc;
  assert.equal(doc.sources.length, SOURCES_MAX);
  // Full is a conflict with the list, not a malformed address.
  assert.throws(() => addSourceTo(doc, { url: 'https://example.com/one-too-many.json' }), (err) => err.code === 'too-many-sources' && err.status === 409);
});

test('reading tolerates a bare array, drops unusable rows, and reports damage', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omkt-sources-'));
  const file = path.join(dir, 'sources.json');
  assert.deepEqual(await readSourcesDocument(file, readFile), { sources: [], damaged: null });

  await writeFile(file, JSON.stringify([
    { url: GH },
    { url: '   ' },
    { url: 'ftp://example.com/x.json' },
    { url: GH },
    { id: 'custom:hand-written', url: 'https://example.com/kept.json', label: '手写 id' },
    'not an object',
  ]), 'utf8');
  const read = await readSourcesDocument(file, readFile);
  assert.equal(read.damaged, null);
  assert.deepEqual(read.sources.map((s) => s.label), ['acme/mcp-registry', '手写 id']);
  assert.deepEqual(read.sources.map((s) => s.id), [sourceIdFor(GH), 'custom:hand-written']);

  await writeFile(file, '{ this is not json', 'utf8');
  const damaged = await readSourcesDocument(file, readFile);
  assert.deepEqual(damaged.sources, []);
  assert.ok(damaged.damaged.length > 0);
  await rm(dir, { recursive: true, force: true });
});

test('a non-file read error is damage, not an empty list', async () => {
  const read = await readSourcesDocument('/ignored.json', async () => {
    const err = new Error('EACCES: permission denied');
    err.code = 'EACCES';
    throw err;
  });
  assert.deepEqual(read.sources, []);
  assert.match(read.damaged, /EACCES/);
});
