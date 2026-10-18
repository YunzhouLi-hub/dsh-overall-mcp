// lib/health.js — 「检查」里握手那一项怎么读。
//
// A handshake that has not finished is not the same fact as a handshake that is
// still running. The panel used to print 「握手未完成（8s 内没返回）」 for a row
// whose mount was still in flight — and printed it after 21 ms, because the check
// read a leftover flag instead of waiting: the number in the sentence was the
// mount's deadline, not anything this check had observed. A verdict has to be
// about the moment it was taken.
//
// So the check now waits for the in-flight mount (bounded, see
// `HEALTH_HANDSHAKE_WAIT_MS` in index.js) and this function words the result from
// what actually happened: `waitedMs` 0 means nobody waited, and the sentence then
// must not claim a duration at all.

/** How many seconds a wait actually covered, never rounding down to 0. */
export function waitedSeconds(waitedMs) {
  const ms = Number(waitedMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.round(ms / 1000));
}

/**
 * The `handshake` check.
 *
 * @param mounted - a fiber exists for this row (or another plugin provides it).
 * @param starting - that fiber's readiness wait expired and it is still working.
 * @param waitedMs - how long this check itself waited before answering.
 */
export function handshakeCheck({ mounted, starting, waitedMs = 0 } = {}) {
  if (!mounted) return { ok: false, detail: '未开始' };
  if (!starting) return { ok: true, detail: '握手完成' };
  const seconds = waitedSeconds(waitedMs);
  if (seconds === 0) {
    // No wait happened: say what is known, and nothing more.
    return { ok: false, detail: '握手仍未完成' };
  }
  return {
    ok: false,
    detail: `握手在 ${seconds}s 内仍未完成（这条命令可能要求交互式登录，或首次运行正在下载）`,
  };
}
