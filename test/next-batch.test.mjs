// test/next-batch.test.mjs — the batch number comes from history, not memory.
//
// 40, 41, 42 and 43 each got two commits with the same number, because two
// sessions edited this repository at the same time and both trusted their own
// memory of "what the last one was". The fix is a rule, and a rule needs a
// test: whatever the commit graph looks like, the next number is
// (highest number present) + 1.
import test from 'node:test';
import assert from 'node:assert/strict';

import { highestBatch } from '../tools/next-batch.mjs';

test('no numbered commit yet means the next batch is the first', () => {
  assert.equal(highestBatch([]), 0);
  assert.equal(highestBatch(['init', 'chore: tidy up', '']), 0);
});

test('the highest number wins, not the newest commit', () => {
  // Numbering is not monotonic with time: a concurrent session can land a
  // lower number after a higher one — which is exactly how 40–43 collided.
  assert.equal(highestBatch(['第 28 批：a', '第 43 批（修）：b', '第 41 批：c']), 43);
  assert.equal(highestBatch(['第 9 批：x', '第 10 批：y']), 10);
});

test('the （修） suffix is part of the title, not of the number', () => {
  assert.equal(highestBatch(['第 12 批（修）：z']), 12);
  assert.equal(highestBatch(['第 7 批 (修)：half-width parens must not break it']), 7);
});

test('spacing variations do not confuse it', () => {
  assert.equal(highestBatch(['第12批：tight', '第  5 批：loose']), 12);
  assert.equal(highestBatch(['第\t3 批：tab']), 3);
});

test('a bare number or a word-numbered mention is not a batch', () => {
  assert.equal(highestBatch(['fix: 第 4 次重试', '第批：no digits', '批 12', '第 12 次']), 0);
});
