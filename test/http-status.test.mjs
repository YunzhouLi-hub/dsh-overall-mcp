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
});

test('httpStatusFor maps caller-side payload problems to 400', () => {
  assert.equal(httpStatusFor(new Error('key required')), 400);
  assert.equal(httpStatusFor(new Error('name required')), 400);
  assert.equal(httpStatusFor(new Error('item required')), 400);
  assert.equal(httpStatusFor(new Error('name (string) and enabled (boolean) required')), 400);
  assert.equal(httpStatusFor(new Error('item has no installable transport (stdio command or http url)')), 400);
  assert.equal(httpStatusFor(new Error('fs is not launched through a package runner; update it manually')), 400);
});

test('httpStatusFor maps an upstream registry failure to 502', () => {
  assert.equal(httpStatusFor(new Error('version lookup failed for left-pad: ETIMEDOUT')), 502);
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
