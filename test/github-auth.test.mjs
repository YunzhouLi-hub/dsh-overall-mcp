// test/github-auth.test.mjs — GitHub credentials (lib/github-auth.js).
//
// Three things have to stay true, and each of them is a bug that would only
// show up in the field:
//
//   1. The token never appears in anything a caller can hand to the panel, the
//      log, /status or an error message. That is asserted directly, on the whole
//      serialized status object, because "remember not to log it" is not a
//      mechanism.
//   2. The `authorization` header only ever reaches the two hosts GitHub owns.
//      This plugin also calls Docker Hub, npm, PyPI, Smithery and the official
//      registry; handing a credential to any of them would leak it to a third
//      party.
//   3. Nothing here is required for the plugin to work. A missing token, an
//      unreadable file, a `gh` that is not installed and a token GitHub rejects
//      all resolve to "run anonymously", never to a thrown error — the census
//      and the market ran that way before this module existed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTH_FILE,
  clearToken,
  deactivateGithubAuth,
  githubAuthStatus,
  maskToken,
  readStoredToken,
  readTokenFromEnv,
  readTokenFromGhCli,
  resetGithubAuthCache,
  resolveGithubAuth,
  setActiveGithubAuth,
  storeToken,
  withGithubAuth,
} from '../lib/github-auth.js';

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

/** A throwaway data directory. */
async function withDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'overall-mcp-auth-'));
  try {
    return await run(dir);
  } finally {
    resetGithubAuthCache();
    setActiveGithubAuth(null);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A fetch stand-in that answers `/user` and `/rate_limit` like GitHub does. */
function githubStub({ login = 'octocat', scopes = 'repo, read:user', limit = 5000, remaining = 4998, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, headers: options.headers ?? {} });
    if (status !== 200) return { ok: false, status, headers: { get: () => null }, json: async () => ({}) };
    if (String(url).endsWith('/user')) {
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === 'x-oauth-scopes' ? scopes : null) },
        json: async () => ({ login, company: 'Acme' }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ resources: { core: { limit, remaining, reset: 1791926400 } } }),
    };
  };
  return { fetchImpl, calls };
}

test('a token is attached to GitHub hosts and to nothing else', () => {
  setActiveGithubAuth({ source: 'panel', token: TOKEN });
  const mine = withGithubAuth('https://api.github.com/search/repositories?q=x', { accept: 'application/json' });
  assert.equal(mine.authorization, `Bearer ${TOKEN}`);
  assert.equal(mine.accept, 'application/json', 'the caller keeps its own headers');

  const raw = withGithubAuth('https://raw.githubusercontent.com/owner/repo/HEAD/package.json', {});
  assert.equal(raw.authorization, `Bearer ${TOKEN}`);

  // Every other upstream this plugin talks to: no credential, ever.
  for (const url of [
    'https://hub.docker.com/v2/repositories/mcp/',
    'https://registry.npmjs.org/left-pad',
    'https://pypi.org/pypi/requests/json',
    'https://registry.smithery.ai/servers',
    'https://registry.modelcontextprotocol.io/v0/servers',
    'https://cdn.jsdelivr.net/gh/punkpeye/awesome-mcp-servers@main/README.md',
    'https://github.com/owner/repo.png',
    'https://evil.example/api.github.com/',
  ]) {
    assert.equal(withGithubAuth(url, { accept: 'application/json' }).authorization, undefined, url);
  }

  setActiveGithubAuth(null);
  assert.equal(withGithubAuth('https://api.github.com/user', {}).authorization, undefined);
});

test('a masked token is recognizable and useless', () => {
  assert.equal(maskToken(TOKEN), 'ghp_ab…6789');
  assert.equal(maskToken('short'), 'sh…rt');
  assert.equal(maskToken(''), null);
  assert.equal(maskToken(null), null);
  assert.ok(!maskToken(TOKEN).includes(TOKEN.slice(8)), 'the middle never survives');
});

test('the environment offers a token, and the prefixed name wins', () => {
  assert.deepEqual(readTokenFromEnv({ GITHUB_TOKEN: 'a' }), { token: 'a', source: 'env', via: 'GITHUB_TOKEN' });
  assert.equal(readTokenFromEnv({ DSH_GITHUB_TOKEN: 'b', GITHUB_TOKEN: 'a' }).token, 'b');
  assert.equal(readTokenFromEnv({ DSH_GITHUB_TOKEN: '  ' }), null);
  assert.equal(readTokenFromEnv({}), null);
});

test('gh is asked once, then remembered — hits and misses alike', async () => {
  resetGithubAuthCache();
  const asked = [];
  const run = async (binary) => { asked.push(binary); return binary === 'gh.cmd' ? TOKEN : null; };
  const first = await readTokenFromGhCli({ run, platform: 'win32', now: () => 1000 });
  assert.deepEqual(first, { token: TOKEN, source: 'gh' });
  assert.deepEqual(asked, ['gh', 'gh.cmd'], 'the .cmd shim is tried when gh itself is not startable');
  assert.deepEqual(await readTokenFromGhCli({ run, platform: 'win32', now: () => 2000 }), first, 'a hit is cached');
  assert.deepEqual(asked, ['gh', 'gh.cmd']);

  resetGithubAuthCache();
  const missing = [];
  const none = await readTokenFromGhCli({ run: async (b) => { missing.push(b); return null; }, platform: 'linux', now: () => 5000 });
  assert.equal(none, null);
  assert.deepEqual(missing, ['gh'], 'no .cmd fallback off Windows');
  assert.equal(await readTokenFromGhCli({ run: async (b) => { missing.push(b); return null; }, platform: 'linux', now: () => 5001 }), null);
  assert.equal(missing.length, 1, 'a miss is cached too, so a panel refresh cannot spawn a process per click');
});

test('a pasted token round-trips through the data directory', async () => {
  await withDir(async (dir) => {
    assert.equal(await readStoredToken(dir), null, 'nothing stored yet');
    const stored = await storeToken(dir, `  ${TOKEN}  `);
    assert.equal(stored.masked, maskToken(TOKEN));
    // The file is written 0600 where that means something. Windows has no
    // POSIX mode bits at all — `chmod` there reports 0o666 and the file is
    // protected by the directory's ACL — so the assertion is POSIX-only rather
    // than pretending the number means the same thing on both platforms.
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(path.join(dir, AUTH_FILE))).mode & 0o777, 0o600);
    }
    const read = await readStoredToken(dir);
    assert.equal(read.token, TOKEN, 'the token is trimmed on the way in');
    assert.equal(read.source, 'panel');

    assert.equal(await clearToken(dir), true);
    assert.equal(await readStoredToken(dir), null);
    assert.equal(await clearToken(dir), false, 'clearing twice is reported, not thrown');

    await fs.writeFile(path.join(dir, AUTH_FILE), '{not json');
    assert.equal(await readStoredToken(dir), null, 'a damaged file is "no token", not a crash');
    await fs.writeFile(path.join(dir, AUTH_FILE), JSON.stringify({ token: '   ' }));
    assert.equal(await readStoredToken(dir), null);
    await assert.rejects(() => storeToken(dir, '   '), /empty token/);
  });
});

test('an anonymous host makes no probe and reports what anonymity costs', async () => {
  await withDir(async (dir) => {
    resetGithubAuthCache();
    let probed = 0;
    const status = await resolveGithubAuth({
      dir,
      env: {},
      useGh: false,
      fetchImpl: async () => { probed += 1; throw new Error('must not be called'); },
    });
    assert.equal(probed, 0, 'no credential means no request');
    assert.equal(status.source, 'anonymous');
    assert.equal(status.inUse, false);
    assert.equal(status.needsLogin, false);
    assert.match(status.note, /匿名访问/);
    assert.equal(withGithubAuth('https://api.github.com/user', {}).authorization, undefined);
    assert.equal(githubAuthStatus().source, 'anonymous');
  });
});

test('a valid token is probed, reported, and put to work', async () => {
  await withDir(async (dir) => {
    resetGithubAuthCache();
    await storeToken(dir, TOKEN);
    const { fetchImpl, calls } = githubStub();
    const status = await resolveGithubAuth({ dir, env: {}, useGh: false, fetchImpl });

    assert.equal(status.source, 'panel');
    assert.equal(status.masked, maskToken(TOKEN));
    assert.equal(status.login, 'octocat');
    assert.deepEqual(status.scopes, ['repo', 'read:user']);
    assert.deepEqual(status.rateLimit, { limit: 5000, remaining: 4998, resetAt: '2026-10-13T21:20:00.000Z' });
    assert.equal(status.inUse, true);
    assert.equal(status.error, null);
    assert.deepEqual(calls.map((c) => c.url), ['https://api.github.com/user', 'https://api.github.com/rate_limit']);
    assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);

    // The invariant that matters: nothing a caller can serialize carries the
    // token, and the header only exists inside this module.
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes(TOKEN));
    assert.ok(!serialized.includes(TOKEN.slice(10, 30)));
    assert.equal(withGithubAuth('https://api.github.com/user', {}).authorization, `Bearer ${TOKEN}`);

    // A second resolution inside the TTL reuses the probe instead of re-asking.
    const again = await resolveGithubAuth({ dir, env: {}, useGh: false, fetchImpl });
    assert.equal(calls.length, 2);
    assert.equal(again.login, 'octocat');
  });
});

test('a rejected token is reported, dropped, and never attached again', async () => {
  await withDir(async (dir) => {
    resetGithubAuthCache();
    await storeToken(dir, TOKEN);
    const status = await resolveGithubAuth({ dir, env: {}, useGh: false, fetchImpl: githubStub({ status: 401 }).fetchImpl });

    assert.equal(status.source, 'panel', 'the panel still knows which token was refused');
    assert.equal(status.masked, maskToken(TOKEN));
    assert.equal(status.inUse, false);
    assert.equal(status.needsLogin, true);
    assert.match(status.error, /无效或已过期/);
    assert.equal(withGithubAuth('https://api.github.com/user', {}).authorization, undefined, 'an unusable token is worse than none');
    assert.ok(!JSON.stringify(status).includes(TOKEN));
  });
});

test('a credential the upstream rejects mid-flight is deactivated, not kept', async () => {
  await withDir(async (dir) => {
    resetGithubAuthCache();
    await storeToken(dir, TOKEN);
    await resolveGithubAuth({ dir, env: {}, useGh: false, fetchImpl: githubStub().fetchImpl });
    assert.equal(withGithubAuth('https://raw.githubusercontent.com/a/b/HEAD/x', {}).authorization, `Bearer ${TOKEN}`);

    deactivateGithubAuth('GitHub 拒绝了这个 token（HTTP 401），已改用匿名访问');
    assert.equal(withGithubAuth('https://raw.githubusercontent.com/a/b/HEAD/x', {}).authorization, undefined);
    const status = githubAuthStatus();
    assert.equal(status.inUse, false);
    assert.equal(status.needsLogin, true);
    assert.match(status.error, /HTTP 401/);
    assert.equal(status.masked, maskToken(TOKEN), 'the panel can still say which token was dropped');
  });
});

test('the environment is used when the panel has stored nothing', async () => {
  await withDir(async (dir) => {
    resetGithubAuthCache();
    const { fetchImpl, calls } = githubStub({ login: 'from-env' });
    const status = await resolveGithubAuth({ dir, env: { DSH_GITHUB_TOKEN: TOKEN }, useGh: false, fetchImpl });
    assert.equal(status.source, 'env');
    assert.equal(status.login, 'from-env');
    assert.equal(calls[0].headers.authorization, `Bearer ${TOKEN}`);
  });
});

test('the gh source is only consulted when it is worth a process', async () => {
  await withDir(async (dir) => {
    resetGithubAuthCache();
    let spawned = 0;
    const run = async () => { spawned += 1; return TOKEN; };
    const quiet = await resolveGithubAuth({
      dir,
      env: {},
      useGh: false,
      run,
      platform: 'linux',
      fetchImpl: githubStub().fetchImpl,
    });
    assert.equal(spawned, 0, 'startup does not spawn anything');
    assert.equal(quiet.source, 'anonymous');

    const loud = await resolveGithubAuth({
      dir,
      env: {},
      useGh: true,
      force: true,
      run,
      platform: 'linux',
      fetchImpl: githubStub({ login: 'gh-user' }).fetchImpl,
    });
    assert.equal(spawned, 1);
    assert.equal(loud.source, 'gh');
    assert.equal(loud.login, 'gh-user');
  });
});

test('a probe that cannot reach GitHub is a reported state, not a failure', async () => {
  await withDir(async (dir) => {
    resetGithubAuthCache();
    await storeToken(dir, TOKEN);
    const status = await resolveGithubAuth({
      dir,
      env: {},
      useGh: false,
      fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); },
    });
    assert.equal(status.inUse, false);
    assert.equal(status.needsLogin, true);
    assert.match(status.error, /连不上 GitHub/);
    assert.equal(withGithubAuth('https://api.github.com/user', {}).authorization, undefined);
  });
});
