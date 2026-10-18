import test from 'node:test';
import assert from 'node:assert/strict';

import { authDemandOf, challengeOf, probeRemoteAuth } from '../lib/remote-auth.js';

test('a WWW-Authenticate challenge is read into its scheme and parameters', () => {
  const challenge = challengeOf(
    'Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="https://x/.well-known/oauth-protected-resource"',
  );
  assert.equal(challenge.scheme, 'bearer');
  assert.equal(challenge.params.error, 'invalid_token');
  assert.equal(challenge.params.error_description, 'Missing Authorization header');
  assert.equal(challenge.params.resource_metadata, 'https://x/.well-known/oauth-protected-resource');
  assert.equal(challengeOf(''), null);
  assert.equal(challengeOf(null), null);
  assert.equal(challengeOf('Basic realm="ops"').scheme, 'basic');
});

test('a 200 means no token is required, and a 401 means one is', () => {
  assert.deepEqual(authDemandOf(200, null), { status: 200, required: false });
  const demand = authDemandOf(401, 'Bearer error="invalid_token", error_description="Missing Authorization header"');
  assert.equal(demand.status, 401);
  assert.equal(demand.required, true);
  assert.equal(demand.scheme, 'bearer');
  assert.equal(demand.description, 'Missing Authorization header');
  assert.equal('raw' in demand, false, 'a Bearer challenge is understood, not merely raw');
});

test('a 401 without a challenge is still gated, and anything else is unknown', () => {
  // No header to read, but the endpoint did refuse — never call that 「fine」.
  assert.equal(authDemandOf(401, null).required, true);
  assert.equal(authDemandOf(401, null).raw, true);
  assert.equal(authDemandOf(403, 'Bearer').required, null);
  assert.equal(authDemandOf(500, null).required, null);
  assert.equal(authDemandOf(undefined, null).required, null);
});

test('the probe sends one initialize and reports the challenge it gets back', async () => {
  const seen = [];
  const demand = await probeRemoteAuth('https://demo.run.tools', {
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return {
        status: 401,
        headers: { get: (name) => (String(name).toLowerCase() === 'www-authenticate' ? 'Bearer error="invalid_token", error_description="Missing Authorization header"' : null) },
        text: async () => '',
      };
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://demo.run.tools');
  assert.equal(seen[0].options.method, 'POST');
  assert.match(seen[0].options.headers.accept, /text\/event-stream/, 'a streamable-http server may answer with SSE');
  const body = JSON.parse(seen[0].options.body);
  assert.equal(body.method, 'initialize');
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(demand.required, true);
  assert.equal(demand.description, 'Missing Authorization header');
});

test('the probe answers null when it cannot reach the endpoint', async () => {
  // 「不知道」 must stay distinguishable from 「不需要」: a probe that times out
  // must not make the panel demand a token from every remote server.
  const demand = await probeRemoteAuth('https://demo.run.tools', {
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(demand, null);
});

test('the probe refuses anything that is not an http endpoint', async () => {
  let called = false;
  const demand = await probeRemoteAuth('file:///etc/passwd', {
    fetchImpl: async () => { called = true; return { status: 200, headers: { get: () => null }, text: async () => '' }; },
  });
  assert.equal(demand, null);
  assert.equal(called, false);
});
