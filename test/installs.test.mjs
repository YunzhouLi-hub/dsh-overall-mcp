// The market's local install counter (lib/installs.js).
//
// The two source-published figures (Smithery's `useCount`, Docker's
// `pull_count`) never include installs made from this panel, so ours are counted
// separately next to the registry. What matters for the panel: a count is keyed
// to the *same* id the card uses, it survives a restart, and a missing or
// corrupt file degrades to "no installs yet" instead of taking the page down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  installKeyOf, emptyInstalls, normalizeInstalls, readInstalls, writeInstalls,
  recordInstallIn, localInstallsOf, localLastInstallOf,
} from '../lib/installs.js';

test('the key is the catalogue id the card already uses', () => {
  assert.equal(installKeyOf({ id: 'smithery:brave' }), 'smithery:brave');
  assert.equal(installKeyOf({ id: '  official:ac.snag/snag  ' }), 'official:ac.snag/snag');
  // An item handed to the install tool without an id falls back to the registry
  // name, so the count still lands somewhere stable.
  assert.equal(installKeyOf({ title: 'x' }, 'brave-search'), 'name:brave-search');
  assert.equal(installKeyOf({}, null), null);
  assert.equal(installKeyOf(null), null);
  // An id from a remote catalogue cannot be trusted to be short.
  assert.equal(installKeyOf({ id: 'a'.repeat(400) }).length, 200);
});

test('a missing file is an empty store, not a throw', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omkt-installs-'));
  const store = await readInstalls(path.join(dir, 'nope.json'));
  assert.deepEqual(store, { version: 1, entries: {} });
  await rm(dir, { recursive: true, force: true });
});

test('a corrupt file is an empty store too', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omkt-installs-'));
  const file = path.join(dir, 'installs.json');
  await writeFile(file, '{ not json at all', 'utf8');
  assert.deepEqual(await readInstalls(file), { version: 1, entries: {} });
  await rm(dir, { recursive: true, force: true });
});

test('recording counts up, keeps the first sighting and moves the last', () => {
  const store = emptyInstalls();
  const first = recordInstallIn(store, { key: 'smithery:brave', name: 'brave', at: '2026-10-14T08:00:00.000Z' });
  assert.deepEqual(first, {
    count: 1, firstAt: '2026-10-14T08:00:00.000Z', lastAt: '2026-10-14T08:00:00.000Z', name: 'brave',
  });
  const second = recordInstallIn(store, { key: 'smithery:brave', at: '2026-10-15T09:30:00.000Z' });
  assert.equal(second.count, 2);
  assert.equal(second.firstAt, '2026-10-14T08:00:00.000Z', 'the first sighting is not the first install');
  assert.equal(second.lastAt, '2026-10-15T09:30:00.000Z');
  assert.equal(second.name, 'brave', 'an unnamed re-install keeps the stored name');
  // A missing key is refused rather than silently counted under `undefined`.
  assert.equal(recordInstallIn(store, { key: null }), null);
  assert.deepEqual(Object.keys(store.entries), ['smithery:brave']);
});

test('lookups are by id, and unknown ids are zero', () => {
  const store = emptyInstalls();
  recordInstallIn(store, { key: 'smithery:brave', at: '2026-10-14T08:00:00.000Z' });
  recordInstallIn(store, { key: 'smithery:brave', at: '2026-10-14T09:00:00.000Z' });
  recordInstallIn(store, { key: 'name:brave-search', name: 'brave-search', at: '2026-10-14T10:00:00.000Z' });
  assert.equal(localInstallsOf(store, { id: 'smithery:brave' }), 2);
  assert.equal(localInstallsOf(store, { id: 'smithery:other' }), 0);
  assert.equal(localInstallsOf(store, {}), 0);
  // The install tool can hand us an item without an id; the fallback name is the
  // same key the annotation used, which is why the row still lights up.
  assert.equal(localInstallsOf(store, { title: 'Brave' }, 'brave-search'), 1);
  assert.equal(localLastInstallOf(store, { id: 'smithery:brave' }), '2026-10-14T09:00:00.000Z');
  assert.equal(localLastInstallOf(store, { id: 'smithery:other' }), null);
});

test('what is on disk is coerced, and nonsense is dropped', () => {
  const store = normalizeInstalls({
    entries: {
      good: { count: '3', firstAt: 'a', lastAt: 'b', name: 'n' },
      zero: { count: 0 },
      negative: { count: -4 },
      notANumber: { count: 'many' },
      empty: null,
      fractional: { count: 2.7 },
    },
  });
  assert.deepEqual(Object.keys(store.entries).sort(), ['fractional', 'good']);
  assert.equal(store.entries.good.count, 3);
  assert.equal(store.entries.fractional.count, 2);
  // Anything that is not an entries object is a fresh store: an array, a string
  // and `null` are all "we learned nothing", never a crash.
  for (const junk of [null, 42, 'x', [], { entries: [] }, { entries: 'x' }]) {
    assert.deepEqual(normalizeInstalls(junk), { version: 1, entries: {} });
  }
});

test('a written store reads back', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'omkt-installs-'));
  const file = path.join(dir, 'installs.json');
  const store = emptyInstalls();
  recordInstallIn(store, { key: 'smithery:brave', name: 'brave', at: '2026-10-14T08:00:00.000Z' });
  await writeInstalls(file, store);
  const back = await readInstalls(file);
  assert.equal(localInstallsOf(back, { id: 'smithery:brave' }), 1);
  // Written through a temp file + rename: the temp file must not be left behind.
  const leftovers = (await import('node:fs')).readdirSync(dir);
  assert.deepEqual(leftovers, ['installs.json']);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.version, 1);
  await rm(dir, { recursive: true, force: true });
});
