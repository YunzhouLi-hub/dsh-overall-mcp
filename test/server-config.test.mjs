// The config detection behind 「这个服务器装好了，但还不能用」 (lib/server-config.js).
//
// What matters here, in order of how much damage getting it wrong does:
//
//   1. A secret's value never appears in a payload. `maskedFields` is the only
//      projection the panel and the model get, so it is asserted field by field
//      rather than by eyeballing a whole object.
//   2. 待配置 means a *required* value is missing. An optional field that is empty
//      is a hint; calling that 待配置 is how the badge becomes noise.
//   3. The evidence hierarchy works: an official declaration beats a guessed name
//      from the command line, and both beat "remote servers get an Authorization
//      box".
//   4. Writing a value cannot smuggle anything: no illegal names, no newline in a
//      header (request splitting), no `__proto__`.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyValues, argFields, configSpecFor, configState, fieldGaps, looksLikeCredentialFailure,
  maskedFields, normalizeField, officialFields, remoteFields, specOf, MAX_VALUE_CHARS,
} from '../lib/server-config.js';

/** The official registry record for github/github-mcp-server, verified live. */
const GITHUB_RAW = {
  name: 'io.github.github/github-mcp-server',
  packages: [{
    registryType: 'oci',
    identifier: 'ghcr.io/github/github-mcp-server:0.16.0',
    transport: { type: 'stdio' },
    environmentVariables: [{
      name: 'GITHUB_PERSONAL_ACCESS_TOKEN',
      description: 'Your GitHub personal access token with appropriate scopes.',
      isRequired: true,
      isSecret: true,
      format: 'string',
    }],
  }],
};

test('an official declaration is read as the fields it is', () => {
  const spec = officialFields({ raw: GITHUB_RAW });
  assert.equal(spec.origin, 'official');
  assert.equal(spec.fields.length, 1);
  const [field] = spec.fields;
  assert.equal(field.key, 'GITHUB_PERSONAL_ACCESS_TOKEN');
  assert.equal(field.kind, 'env');
  assert.equal(field.required, true);
  assert.equal(field.secret, true);
  assert.match(field.help, /personal access token/);
  // A record that declares nothing yields no spec at all, not an empty one.
  assert.equal(officialFields({ raw: { name: 'x' } }), null);
  assert.equal(officialFields({}), null);
  assert.equal(officialFields(null), null);
});

test('a declaration that only marks a variable optional does not make it required', () => {
  const spec = officialFields({ raw: { packages: [{ environmentVariables: [{ name: 'API_URL', isRequired: false }] }] } });
  assert.equal(spec.fields[0].required, false);
  assert.equal(spec.fields[0].secret, false);
});

test('remote-declared headers become header fields', () => {
  const spec = officialFields({ raw: { remotes: [{ type: 'streamable-http', headers: [{ name: 'Authorization', isRequired: true, isSecret: true }] }] } });
  assert.equal(spec.fields[0].kind, 'header');
  assert.equal(spec.fields[0].required, true);
});

test('the command line is read for env flags, placeholders and credential-shaped tokens', () => {
  const fields = argFields({
    command: 'npx',
    args: ['-y', 'some-server', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', '--env', 'LOG_LEVEL=debug', '--url=${API_BASE_URL}'],
  }).fields;
  const keys = fields.map((f) => f.key);
  assert.deepEqual(keys.sort(), ['API_BASE_URL', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'LOG_LEVEL']);
  // `-e NAME` is the official GitHub image's own shape: a bare token after the flag.
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  assert.equal(byKey.GITHUB_PERSONAL_ACCESS_TOKEN.secret, true);
  assert.equal(byKey.API_BASE_URL.secret, false);
});

test('an uppercase word alone is not evidence of a setting', () => {
  // `--read-only` and a bare `GITHUB` are ordinary arguments, not variables.
  const spec = argFields({ command: 'npx', args: ['-y', 'pkg', '--read-only', 'GITHUB', '--port', '8080'] });
  assert.equal(spec, null);
});

test('a URL placeholder is a field too', () => {
  const spec = argFields({ transport: 'streamable-http', url: 'https://example.test/mcp?key=${EXAMPLE_KEY}' });
  assert.equal(spec.fields[0].key, 'EXAMPLE_KEY');
});

test('official evidence outranks the command line, and both are deduped', () => {
  const item = { raw: GITHUB_RAW };
  const entry = { command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'image'] };
  const spec = configSpecFor(item, entry);
  assert.equal(spec.origin, 'official');
  assert.equal(spec.fields.length, 1);
  assert.equal(spec.fields[0].help, 'Your GitHub personal access token with appropriate scopes.');
});

test('a remote entry always offers one optional Authorization header', () => {
  const spec = remoteFields({ transport: 'streamable-http', url: 'https://example.test/mcp' });
  assert.equal(spec.fields.length, 1);
  assert.equal(spec.fields[0].key, 'Authorization');
  assert.equal(spec.fields[0].kind, 'header');
  assert.equal(spec.fields[0].required, false);
  assert.equal(spec.fields[0].secret, true);
  assert.equal(remoteFields({ transport: 'stdio', command: 'npx' }), null);
});

test('a required value that is absent is missing, an optional one is only pending', () => {
  const spec = {
    fields: [
      { key: 'GH_TOKEN', kind: 'env', required: true, secret: true },
      { key: 'LOG_LEVEL', kind: 'env', required: false, secret: false },
    ],
  };
  assert.deepEqual(fieldGaps(spec, {}), { missing: ['GH_TOKEN'], pending: ['LOG_LEVEL'] });
  assert.deepEqual(fieldGaps(spec, { env: { GH_TOKEN: 'x', LOG_LEVEL: 'debug' } }), { missing: [], pending: [] });
  // Whitespace is not a value.
  assert.deepEqual(fieldGaps(spec, { env: { GH_TOKEN: '   ' } }), { missing: ['GH_TOKEN'], pending: ['LOG_LEVEL'] });
  assert.equal(configState(spec, {}).needs, true);
  assert.equal(configState(spec, { env: { GH_TOKEN: 'x' } }).needs, false);
  assert.equal(configState(null, {}), null);
});

test('a secret value is masked, and a non-secret value is echoed', () => {
  const spec = {
    origin: 'official',
    fields: [
      { key: 'GH_TOKEN', kind: 'env', label: 'GH_TOKEN', required: true, secret: true },
      { key: 'API_BASE_URL', kind: 'env', label: 'API_BASE_URL', required: false, secret: false },
    ],
  };
  const payload = maskedFields(spec, { env: { GH_TOKEN: 'ghp_secret_value', API_BASE_URL: 'https://api.test' } });
  const byKey = Object.fromEntries(payload.fields.map((f) => [f.key, f]));
  assert.equal(byKey.GH_TOKEN.value, '••••');
  assert.equal(byKey.GH_TOKEN.hasValue, true);
  assert.equal(byKey.API_BASE_URL.value, 'https://api.test');
  // The secret never reaches the payload, in any field.
  assert.equal(JSON.stringify(payload).includes('ghp_secret_value'), false);
  // `origin` rides along so the panel can say where the field came from.
  assert.equal(payload.origin, 'official');
  assert.equal(maskedFields(null, {}), null);
  assert.equal(maskedFields({ fields: [] }, {}), null);
});

test('writing a value updates the right bag, and an empty string clears it', () => {
  const entry = { env: { OLD: '1' }, headers: {} };
  const { changed, rejected } = applyValues(entry, {
    env: { NEW_KEY: ' v ', OLD: '' },
    headers: { Authorization: 'Bearer abc' },
  });
  assert.deepEqual(rejected, []);
  assert.deepEqual(entry.env, { NEW_KEY: ' v ' });
  assert.deepEqual(entry.headers, { Authorization: 'Bearer abc' });
  assert.deepEqual(changed.map((c) => `${c.kind}:${c.key}:${c.action}`).sort(),
    ['env:NEW_KEY:set', 'env:OLD:cleared', 'header:Authorization:set']);
});

test('writing a value refuses what cannot be sent literally', () => {
  const entry = {};
  const { changed, rejected } = applyValues(entry, {
    env: { 'bad name': 'x', __proto__: 'x', '1LEADING': 'x' },
    headers: { 'X-Test': 'a\r\nInjected: yes', 'bad header': 'x' },
  });
  // `__proto__` through an object literal sets the prototype, so it is asserted
  // the way a caller can actually send it: a plain assignment on the bag.
  const viaBag = {};
  applyValues(viaBag, { env: JSON.parse('{"__proto__":"x"}') });
  assert.equal(changed.length, 0);
  assert.equal(Object.keys(entry.env ?? {}).length, 0);
  assert.equal(Object.keys(entry.headers ?? {}).length, 0);
  assert.deepEqual(rejected.map((r) => r.reason).sort(), [
    '不是合法的环境变量名',
    '不是合法的环境变量名',
    '不是合法的请求头名',
    '请求头的值不能含换行',
  ]);
  assert.deepEqual(Object.keys(viaBag.env ?? {}), []);
});

test('an unchanged value is not reported as a change', () => {
  const entry = { env: { A: '1' } };
  assert.deepEqual(applyValues(entry, { env: { A: '1' } }).changed, []);
});

test('an oversized value is capped instead of stored whole', () => {
  const entry = {};
  applyValues(entry, { env: { BIG: 'x'.repeat(MAX_VALUE_CHARS + 10) } });
  assert.equal(entry.env.BIG.length, MAX_VALUE_CHARS);
});

test('the failure classifier knows identity errors from everything else', () => {
  assert.equal(looksLikeCredentialFailure('401 Unauthorized'), true);
  assert.equal(looksLikeCredentialFailure('Missing required env GITHUB_TOKEN'), true);
  assert.equal(looksLikeCredentialFailure('You need to authenticate before using this server'), true);
  assert.equal(looksLikeCredentialFailure('请先配置 GITHUB_PERSONAL_ACCESS_TOKEN'), true);
  assert.equal(looksLikeCredentialFailure('spawn npx ENOENT'), false);
  assert.equal(looksLikeCredentialFailure('MCP error -32000: Connection closed'), false);
  // A quota wall is not fixed by a token.
  assert.equal(looksLikeCredentialFailure('API rate limit exceeded for 1.2.3.4'), false);
  assert.equal(looksLikeCredentialFailure(''), false);
});

test('a field name has to be legal for its kind, and the label defaults to the key', () => {
  assert.equal(normalizeField({ key: 'GOOD_NAME' }).label, 'GOOD_NAME');
  assert.equal(normalizeField({ key: 'bad-name' }), null);
  assert.equal(normalizeField({ key: 'X-Test', kind: 'header' }).kind, 'header');
  assert.equal(normalizeField({ key: '__proto__' }), null);
  assert.equal(normalizeField({ key: 'X-Test', kind: 'header' }).secret, false);
  assert.equal(normalizeField({ key: 'WITH_HELP', help: 'a'.repeat(900) }).help.length, 400);
});

test('a stored spec is read back without re-deriving it', () => {
  const entry = {
    config: { origin: 'official', fields: [{ key: 'GH_TOKEN', kind: 'env', required: true, secret: true }] },
    env: {},
  };
  const spec = specOf(entry);
  assert.equal(spec.origin, 'official');
  assert.deepEqual(fieldGaps(spec, entry).missing, ['GH_TOKEN']);
  // An entry with no stored spec falls back to its own command line.
  assert.equal(specOf({ command: 'npx', args: ['-y', 'pkg'] }), null);
});
