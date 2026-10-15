// test/catalog-cache.test.mjs — unit tests for lib/catalog-cache.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogCache, DEFAULT_SOURCE_TTL_MS } from '../lib/catalog-cache.js';

/** A clock the test drives, so TTL behaviour is asserted without waiting. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test('a remembered body and its validator come back, and reusing it is counted', () => {
  const cache = createCatalogCache();
  cache.remember('https://example.test/list', { etag: '"v1"', body: 'LIST' });

  assert.equal(cache.etagFor('https://example.test/list'), '"v1"');
  assert.equal(cache.rememberedBody('https://example.test/list'), 'LIST');

  // What a 304 is worth: the bytes we did not download.
  assert.equal(cache.reuse('https://example.test/list'), 'LIST');
  assert.deepEqual(cache.stats(), {
    requests: 0, notModified: 1, downloaded: 0, saved: 4, urls: 1, bytesHeld: 4, sources: 0,
  });
});

test('a server that sends no validator is remembered without one', () => {
  const cache = createCatalogCache();
  cache.remember('https://example.test/no-etag', { body: 'BODY' });
  assert.equal(cache.etagFor('https://example.test/no-etag'), undefined);
  // The body is still held: a source TTL can be served without any validator.
  assert.equal(cache.rememberedBody('https://example.test/no-etag'), 'BODY');
});

test('the same URL remembered twice keeps one entry and the newer body', () => {
  const cache = createCatalogCache();
  cache.remember('https://example.test/list', { etag: '"v1"', body: 'ONE' });
  cache.remember('https://example.test/list', { etag: '"v2"', body: 'TWO' });
  assert.equal(cache.stats().urls, 1);
  assert.equal(cache.stats().bytesHeld, 3);
  assert.equal(cache.etagFor('https://example.test/list'), '"v2"');
  assert.equal(cache.rememberedBody('https://example.test/list'), 'TWO');
});

test('a source result is reused inside its TTL and hidden after it', () => {
  const clock = fakeClock();
  const cache = createCatalogCache({ sourceTtlMs: 60_000, now: clock.now });
  cache.storeSourceResult('awesome-list|', { items: [{ id: 'a' }] });

  assert.equal(cache.sourceResult('awesome-list|').items.length, 1, 'fresh inside the TTL');
  clock.advance(DEFAULT_SOURCE_TTL_MS - 1);
  assert.equal(cache.sourceResult('awesome-list|').items.length, 1, 'still fresh at TTL-1');
  clock.advance(1);
  assert.equal(cache.sourceResult('awesome-list|'), undefined, 'expired at the TTL');
  // A failed walk asks for any age: a stale listing beats an empty market.
  assert.equal(cache.sourceResult('awesome-list|', { fresh: false }).items.length, 1);
});

test('expiry is per source and per query', () => {
  const clock = fakeClock();
  const cache = createCatalogCache({ sourceTtlMs: 1000, now: clock.now });
  cache.storeSourceResult('smithery|pg', { items: [] });
  clock.advance(1001);
  assert.equal(cache.sourceResult('smithery|pg'), undefined);
  assert.equal(cache.sourceResult('smithery|postgres'), undefined, 'a query we never walked');
});

test('storeSourceResult records when the source was read', () => {
  const clock = fakeClock(5000);
  const cache = createCatalogCache({ now: clock.now });
  cache.storeSourceResult('official-registry|x', { items: [] });
  assert.equal(cache.sourceResult('official-registry|x').at, 5000);
  // An explicit timestamp wins, so a walk can record when it *started*.
  cache.storeSourceResult('official-registry|y', { items: [], at: 4000 });
  assert.equal(cache.sourceResult('official-registry|y').at, 4000);
});

test('the url store is bounded and drops the least recently used entry', () => {
  const clock = fakeClock();
  const cache = createCatalogCache({ maxUrls: 2, now: clock.now });
  cache.remember('a', { body: 'A' });
  clock.advance(1);
  cache.remember('b', { body: 'B' });
  // Reading `a` must keep it: it is now the more recently used of the two.
  clock.advance(1);
  cache.reuse('a');
  clock.advance(1);
  cache.remember('c', { body: 'C' });

  assert.equal(cache.stats().urls, 2);
  assert.equal(cache.rememberedBody('b'), undefined, 'b was the oldest');
  assert.equal(cache.rememberedBody('a'), 'A');
  assert.equal(cache.rememberedBody('c'), 'C');
});

test('the url store is bounded by bytes as well as by count', () => {
  const cache = createCatalogCache({ maxUrls: 64, maxBytes: 10 });
  cache.remember('a', { body: 'AAAAAA' });   // 6 bytes
  cache.remember('b', { body: 'BBBBBBB' });  // 7 bytes -> over budget
  assert.ok(cache.stats().bytesHeld <= 10, 'holding 7 of 10 after dropping the oldest');
  assert.equal(cache.rememberedBody('a'), undefined);
  assert.equal(cache.rememberedBody('b'), 'BBBBBBB');
});

test('a body that cannot be measured does not break the store', () => {
  const cache = createCatalogCache();
  const cyclic = {};
  cyclic.self = cyclic; // JSON.stringify throws on this
  assert.doesNotThrow(() => cache.remember('cycle', { body: cyclic }));
  assert.equal(cache.rememberedBody('cycle'), cyclic);
  assert.doesNotThrow(() => cache.stats());
});

test('reuse of a URL we never held answers undefined instead of throwing', () => {
  const cache = createCatalogCache();
  assert.equal(cache.reuse('https://example.test/never'), undefined);
  assert.equal(cache.stats().notModified, 0, 'a miss is not a 304');
});
