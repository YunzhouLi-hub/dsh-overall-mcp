// test/http-status.test.mjs — pure-logic tests for lib/http-status.js
//
// The guard's status is what the settings page reports and what decides whether
// a failure is logged, so each class of throw is pinned here: a lookup that
// found nothing, a caller mistake, an upstream failure, and "we did not
// anticipate this" (which must stay a 500 rather than being quietly downgraded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpStatusFor } from '../lib/http-status.js';

test('httpStatusFor maps lookups to 404', () => {
  assert.equal(httpStatusFor(new Error('unknown server: rea')), 404);
  assert.equal(httpStatusFor(new Error('unknown source: cursor')), 404);
  // A submission id the queue no longer has: reviewed in this panel's other
  // window, or in the MCP tool, between the render and the click.
  assert.equal(httpStatusFor(new Error('unknown submission: s1abc2')), 404);
});

test('httpStatusFor maps caller-side payload problems to 400', () => {
  assert.equal(httpStatusFor(new Error('key required')), 400);
  assert.equal(httpStatusFor(new Error('name required')), 400);
  assert.equal(httpStatusFor(new Error('item required')), 400);
  assert.equal(httpStatusFor(new Error('name (string) and enabled (boolean) required')), 400);
  assert.equal(httpStatusFor(new Error('item has no installable transport (stdio command or http url)')), 400);
  assert.equal(httpStatusFor(new Error('fs is not launched through a package runner; update it manually')), 400);
  // A submission the reviewer cannot act on: the form was incomplete (or the
  // upload was over the cap), so the panel must show the reason as a form error
  // rather than as a plugin fault.
  assert.equal(httpStatusFor(new Error('invalid submission: link must be an http(s) URL')), 400);
  assert.equal(httpStatusFor(new Error('invalid submission: file is larger than 512 KB')), 400);
  // The review form itself was wrong (neither approve nor reject), which is the
  // panel's bug to show as a form error, not a plugin fault.
  assert.equal(httpStatusFor(new Error('invalid submission decision: maybe（要 approve 或 reject）')), 400);
});

test('httpStatusFor maps an upstream registry failure to 502', () => {
  assert.equal(httpStatusFor(new Error('version lookup failed for left-pad: ETIMEDOUT')), 502);
});

// Both of these are the panel racing itself: the row was removed or re-scanned
// between the render and the click. Answering 500 made a routine retry look like
// a plugin fault, and the guard logs 5xx.
test('httpStatusFor maps a row that moved under the caller to 409', () => {
  assert.equal(httpStatusFor(new Error('ambiguous server name: rea-cursor（4 条同名记录）；请带上 slot')), 409);
  assert.equal(httpStatusFor(new Error('stale entry: rea-cursor（注册表已变化，请刷新后重试）')), 409);
});

// A conflict with state the caller did not see: the name is already owned by a
// hand-added record, so the install is refused instead of replacing it. 400
// would blame the caller's payload; 500 would send a maintainer after a bug.
test('httpStatusFor maps a manual-entry collision to 409', () => {
  assert.equal(httpStatusFor(new Error('manual entry fs: 这是手工添加的记录，安装不会覆盖它；请先移除它，或带 overwrite=true 明确替换')), 409);
  // Approving a submission under a name the registry already uses, and
  // switching on a row that has nothing to mount: both are "this conflicts with
  // state you did not see", not plugin faults.
  assert.equal(httpStatusFor(new Error('duplicate contribution name: acme（注册表里已有同名记录）；请改名，或带 overwrite=true 明确替换')), 409);
  assert.equal(httpStatusFor(new Error('display-only entry link-only: 这条「个人贡献」只有链接、没有挂载信息，无法挂载')), 409);
});

test('httpStatusFor falls back to 500 for anything unrecognised', () => {
  assert.equal(httpStatusFor(new Error('socket hang up')), 500);
  assert.equal(httpStatusFor('a thrown string'), 500);
  assert.equal(httpStatusFor(undefined), 500);
  // A message that merely *mentions* a word from another rule must not be
  // reclassified: only a recognised shape decides.
  assert.equal(httpStatusFor(new Error('connect ECONNREFUSED: retry required')), 500);
});

test('httpStatusFor honours an explicit status on the error', () => {
  assert.equal(httpStatusFor(Object.assign(new Error('nope'), { status: 409 })), 409);
  // …but only a plausible one: an out-of-range or non-numeric `status` is
  // ignored rather than echoed into the HTTP response.
  assert.equal(httpStatusFor(Object.assign(new Error('boom'), { status: 200 })), 500);
  assert.equal(httpStatusFor(Object.assign(new Error('boom'), { status: 999 })), 500);
  assert.equal(httpStatusFor(Object.assign(new Error('boom'), { status: 'teapot' })), 500);
  // An explicit status still loses to nothing: a known lookup keeps its own.
  assert.equal(httpStatusFor(Object.assign(new Error('unknown server: x'), { status: 503 })), 503);
});
