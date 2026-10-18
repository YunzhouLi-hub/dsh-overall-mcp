import assert from 'node:assert/strict';
import test from 'node:test';

import { handshakeCheck, waitedSeconds } from '../lib/health.js';

test('waitedSeconds rounds up to a whole second and never reports zero for a real wait', () => {
  assert.equal(waitedSeconds(0), 0);
  assert.equal(waitedSeconds(-5), 0);
  assert.equal(waitedSeconds(undefined), 0);
  assert.equal(waitedSeconds(21), 1);
  assert.equal(waitedSeconds(12000), 12);
  assert.equal(waitedSeconds(12400), 12);
});

test('handshakeCheck says nothing about a mount that never started', () => {
  const check = handshakeCheck({ mounted: false, starting: false });
  assert.deepEqual(check, { ok: false, detail: '未开始' });
});

test('handshakeCheck calls a settled mount a finished handshake', () => {
  const check = handshakeCheck({ mounted: true, starting: false, waitedMs: 40 });
  assert.deepEqual(check, { ok: true, detail: '握手完成' });
});

test('handshakeCheck prints the wait it actually covered', () => {
  const check = handshakeCheck({ mounted: true, starting: true, waitedMs: 12000 });
  assert.equal(check.ok, false);
  assert.equal(
    check.detail,
    '握手在 12s 内仍未完成（这条命令可能要求交互式登录，或首次运行正在下载）',
  );
});

test('handshakeCheck claims no duration when it did not wait', () => {
  // The old wording said 「8s 内没返回」 after 21 ms. A verdict may only mention a
  // wait that happened.
  const check = handshakeCheck({ mounted: true, starting: true, waitedMs: 0 });
  assert.equal(check.ok, false);
  assert.equal(check.detail, '握手仍未完成');
  assert.equal(/8s|\d+s 内/.test(check.detail), false);
});
