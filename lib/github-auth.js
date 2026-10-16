/**
 * GitHub credentials: where they come from, whether they work, and which hosts
 * are allowed to see them.
 *
 * Anonymous GitHub access is a hard ceiling. `api.github.com` allows 60 REST
 * requests per hour per IP, and `raw.githubusercontent.com` throttles a burst
 * long before any quota counter says so — measured on this host, a walk that
 * asked twice a second died at request 260 with `fetch failed` after covering
 * 77 of 2111 repositories. This plugin spends GitHub requests on four things:
 * the census (search), the market's star/issue numbers (repos API), repository
 * images and READMEs (raw), and the install-command walk (raw). A token raises
 * that ceiling to 5000/hour and is therefore worth having.
 *
 * It is never worth *requiring*: with no credential at all every path still
 * runs, just slower and sooner throttled. The anonymous source is the default
 * state, not an error state, which is why nothing here throws when it finds
 * nothing.
 *
 * Resolution order, first hit wins:
 *
 *   1. `panel`     — a token the user pasted, stored in the plugin's data dir
 *   2. `env`       — `DSH_GITHUB_TOKEN`, then `GITHUB_TOKEN`
 *   3. `gh`        — `gh auth token`, i.e. "they already logged in with the CLI"
 *   4. `anonymous` — no credential, and no complaint about it
 *
 * Two invariants hold this module together:
 *
 *   - **The token never leaves it.** Callers get a mask, a login and a quota —
 *     never the value — so the panel, `/status`, the event log and any error
 *     message physically cannot echo it. `withGithubAuth()` is how the value
 *     reaches a request, and it is the only reader.
 *   - **The header is an allow-list over hosts.** `api.github.com` and
 *     `raw.githubusercontent.com` only. A GitHub token is proof of identity to
 *     GitHub and to nobody else; this plugin also calls Docker Hub, npm, PyPI,
 *     Smithery and the official registry, and attaching the header there would
 *     hand a credential to a third party. The allow-list makes that impossible
 *     even by mistake, and it is asserted in the tests.
 *
 * A real OAuth device flow ("sign in with GitHub" without pasting anything) is
 * deliberately *not* implemented: it needs an OAuth app client id, and shipping
 * one would mean this plugin holding credentials that belong to whoever
 * registered it. The `gh` source is the honest way to offer account login
 * without that: `gh auth login` is the official CLI, it is already on many
 * developers' machines, and the token stays in gh's own keychain.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/** Where a pasted token is kept, inside the plugin's data directory. */
export const AUTH_FILE = 'github-auth.json';

/** The only two hosts a GitHub token is ever attached to. */
export const GITHUB_AUTH_HOSTS = Object.freeze(['api.github.com', 'raw.githubusercontent.com']);

const API = 'https://api.github.com';
const USER_AGENT = 'dsh-overall-mcp (DeepSeek Harness plugin)';

/**
 * The active credential, held for the module so every fetcher in the plugin
 * consults one value. Set only by `resolveGithubAuth()` — i.e. only after the
 * token has been validated — so a broken token can never disable the anonymous
 * paths that still work.
 */
let active = { source: 'anonymous', token: null, login: null };

/** Which source is answering right now (`anonymous` when nothing is set). */
export function activeGithubSource() {
  return active.source;
}

/** Test seam: drop the credential (and, with it, the resolved state). */
export function setActiveGithubAuth(next) {
  active = next
    ? { source: String(next.source ?? 'anonymous'), token: next.token ?? null, login: next.login ?? null }
    : { source: 'anonymous', token: null, login: null };
}

/**
 * Give up on a credential the upstream has already rejected.
 *
 * A 401 with a stored token is the one case where using the credential is worse
 * than not using it: every request would fail identically, and a walk that stops
 * on the first failure would end its pass over a token the user could simply
 * replace. Dropping it here means the next attempt goes out anonymously and
 * succeeds, while the panel still shows which token was refused and why.
 */
export function deactivateGithubAuth(reason) {
  setActiveGithubAuth(null);
  if (resolvedState.value) {
    resolvedState.value = {
      status: { ...resolvedState.value.status, inUse: false, error: String(reason ?? 'token 被上游拒绝'), needsLogin: true },
      active: null,
    };
  }
  return String(reason ?? '');
}

/** What the last resolution found — token-free, and safe to put on the wire. */
export function githubAuthStatus() {
  return resolvedState.value?.status ?? UNRESOLVED;
}

/**
 * The `authorization` header for one URL — or nothing.
 *
 * Merged into a caller's own headers rather than replacing them, so the accept
 * header, the ETag and the user agent stay the caller's business.
 *
 * @param {string} url - the request target.
 * @param {object} headers - the headers the caller already decided on.
 * @returns {object} the same headers, plus `authorization` when the host is one
 *   GitHub owns. Never a copy that drops the caller's other fields.
 */
export function withGithubAuth(url, headers = {}) {
  if (!active.token) return headers;
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return headers;
  }
  if (!GITHUB_AUTH_HOSTS.includes(host)) return headers;
  return { ...headers, authorization: `Bearer ${active.token}` };
}

/** `ghp_ab…cd12` — enough to recognize a token, never enough to use one. */
export function maskToken(token) {
  const value = String(token ?? '');
  if (!value) return null;
  if (value.length <= 12) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/**
 * The environment's token, if the deployment set one.
 *
 * `DSH_GITHUB_TOKEN` wins over `GITHUB_TOKEN` because the generic name may
 * belong to something else on the same machine, while the prefixed one can only
 * have been meant for us.
 */
export function readTokenFromEnv(env = process.env) {
  for (const name of ['DSH_GITHUB_TOKEN', 'GITHUB_TOKEN']) {
    const value = String(env?.[name] ?? '').trim();
    if (value) return { token: value, source: 'env', via: name };
  }
  return null;
}

/**
 * `gh auth token` — "they are already logged in".
 *
 * Cached in both directions: a hit for ten minutes, a miss for five, so a panel
 * that refreshes cannot spawn a process per click, and a machine without `gh`
 * is asked at most twice per session.
 */
const ghCache = { at: 0, token: null, ttl: 0 };

export function resetGhCache() {
  ghCache.at = 0;
  ghCache.token = null;
  ghCache.ttl = 0;
}

function runGhOnce(binary, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(binary, ['auth', 'token'], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const value = String(stdout ?? '').trim();
        return resolve(value || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * @param {object} [options]
 * @param {Function} [options.run] - test seam: `(binary) => Promise<string|null>`.
 * @param {string} [options.platform] - test seam: decides the `.cmd` fallback.
 * @param {number} [options.now]
 * @param {boolean} [options.force] - ignore the cache (the panel's 重新检测).
 */
export async function readTokenFromGhCli({ run = runGhOnce, platform = process.platform, now = Date.now, force = false } = {}) {
  if (!force && ghCache.at && now() - ghCache.at < ghCache.ttl) {
    return ghCache.token ? { token: ghCache.token, source: 'gh' } : null;
  }
  // `gh` from the MSI is `gh.exe`; installed through a node package manager it
  // is a `gh.cmd` shim, which `execFile` cannot start without a shell. Trying
  // the second name is cheaper than reasoning about which install this is.
  const found = (await run('gh')) ?? (platform === 'win32' ? await run('gh.cmd') : null);
  ghCache.at = now();
  ghCache.token = found;
  ghCache.ttl = found ? 10 * 60 * 1000 : 5 * 60 * 1000;
  return found ? { token: found, source: 'gh' } : null;
}

/** The stored panel token, if any. Unreadable or malformed reads as "none". */
export async function readStoredToken(dir, { readFile = (file, enc) => fs.readFile(file, enc) } = {}) {
  try {
    const raw = await readFile(path.join(dir, AUTH_FILE), 'utf8');
    const doc = JSON.parse(String(raw));
    const token = typeof doc?.token === 'string' ? doc.token.trim() : '';
    if (!token) return null;
    return { token, source: 'panel', at: typeof doc.at === 'string' ? doc.at : null };
  } catch {
    return null;
  }
}

/** Write the pasted token atomically, readable only by this user. */
export async function storeToken(dir, token, { now = Date.now } = {}) {
  const value = String(token ?? '').trim();
  if (!value) throw new Error('empty token');
  const file = path.join(dir, AUTH_FILE);
  const tmp = `${file}.tmp`;
  const at = new Date(now()).toISOString();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmp, JSON.stringify({ token: value, at }, null, '\t'), { mode: 0o600 });
  await fs.rename(tmp, file);
  return { at, masked: maskToken(value) };
}

/** Forget the stored copy. Other sources are untouched — we never had them. */
export async function clearToken(dir, { unlink = (file) => fs.unlink(file) } = {}) {
  try {
    await unlink(path.join(dir, AUTH_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Ask GitHub who this token is, and how much quota it has.
 *
 * `/user` is the only cheap proof that a token is valid at all; `/rate_limit`
 * then turns "we have a token" into "we have 4998 of 5000 requests", which is
 * the number worth putting in front of a user who just pasted one.
 *
 * @returns {Promise<{login: string|null, scopes: string[], rateLimit: object|null, organization: string|null}>}
 * @throws {Error} with `code` `unauthorized` | `forbidden` | `network`, and a
 *   `message` that is safe to show (it never contains the token).
 */
export async function probeToken(token, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const headers = {
    'user-agent': USER_AGENT,
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
  };
  const ask = async (url) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { headers, signal: ctl.signal });
    } catch (err) {
      const failure = new Error(`连不上 GitHub：${String(err?.message ?? err)}`);
      failure.code = 'network';
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  };

  const res = await ask(`${API}/user`);
  if (res.status === 401) {
    const err = new Error('GitHub 说这个 token 无效或已过期（HTTP 401）');
    err.code = 'unauthorized';
    throw err;
  }
  if (res.status === 403) {
    const err = new Error('GitHub 拒绝了这个 token（HTTP 403）——它可能缺少读取公开信息的权限');
    err.code = 'forbidden';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`GitHub 校验 token 时返回 HTTP ${res.status}`);
    err.code = 'network';
    throw err;
  }
  const scopes = String(res.headers?.get?.('x-oauth-scopes') ?? '')
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
  let login = null;
  let organization = null;
  try {
    const body = await res.json();
    login = typeof body?.login === 'string' ? body.login : null;
    organization = typeof body?.company === 'string' && body.company ? body.company : null;
  } catch { /* the identity is a nicety; the quota below is the point */ }

  let rateLimit = null;
  try {
    const quotaRes = await ask(`${API}/rate_limit`);
    if (quotaRes.ok) {
      const body = await quotaRes.json();
      const core = body?.resources?.core;
      if (core && Number.isFinite(Number(core.limit))) {
        rateLimit = {
          limit: Number(core.limit),
          remaining: Number(core.remaining ?? 0),
          resetAt: Number.isFinite(Number(core.reset)) ? new Date(Number(core.reset) * 1000).toISOString() : null,
        };
      }
    }
  } catch { /* a quota we could not read is not a broken token */ }

  return { login, scopes, rateLimit, organization };
}

/**
 * Resolve the credential, validate it, and make it the active one.
 *
 * The returned object is deliberately token-free — see the module comment. It
 * is what `/status` and the panel are built from, so the invariant "a token
 * cannot be echoed" holds by construction rather than by remembering.
 *
 * `useGh: false` skips the `gh` probe. Plugin startup passes it, because
 * spawning a process to ask a question nobody asked yet is rude, and because
 * the interesting sources (a pasted token, the environment) are answered
 * without leaving the process. The panel — which *is* asking "can we use the
 * account you already have?" — lets it run.
 *
 * @param {object} options
 * @param {string} options.dir - the plugin's data directory.
 * @param {object} [options.env] - environment to read (`DSH_GITHUB_TOKEN`…).
 * @param {number} [options.ttlMs] - how long a resolution is reused.
 * @param {boolean} [options.force] - re-probe now (panel 重新检测 / token 变更).
 * @param {boolean} [options.useGh] - consult `gh auth token` (default true).
 * @returns {Promise<object>} the status object described above.
 */
const resolvedState = { at: 0, value: null };

/** The shape `/status` reports before anything has been resolved. */
const UNRESOLVED = Object.freeze({
  source: 'anonymous',
  masked: null,
  login: null,
  scopes: [],
  rateLimit: null,
  checkedAt: null,
  storedAt: null,
  error: null,
  needsLogin: false,
  inUse: false,
  note: 'GitHub 凭据尚未检测。',
});

export async function resolveGithubAuth({
  dir,
  env = process.env,
  run,
  platform,
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = 10 * 60 * 1000,
  force = false,
  useGh = true,
} = {}) {
  if (!force && resolvedState.at && now() - resolvedState.at < ttlMs && resolvedState.value) {
    setActiveGithubAuth(resolvedState.value.active);
    return resolvedState.value.status;
  }

  const stored = await readStoredToken(dir);
  const found = stored
    ?? readTokenFromEnv(env)
    ?? (useGh
      ? await readTokenFromGhCli({ ...(run ? { run } : {}), ...(platform ? { platform } : {}), now, force })
      : null);

  const base = {
    source: found?.source ?? 'anonymous',
    masked: found ? maskToken(found.token) : null,
    login: null,
    scopes: [],
    rateLimit: null,
    checkedAt: new Date(now()).toISOString(),
    storedAt: stored?.at ?? null,
    error: null,
    needsLogin: false,
    inUse: Boolean(found),
    ...(found?.via ? { via: found.via } : {}),
  };

  if (!found) {
    // No credential is a working state, and the panel should say what it costs
    // rather than look like something is missing.
    const status = { ...base, inUse: false, note: '匿名访问：GitHub 每小时只给 60 次请求。' };
    setActiveGithubAuth(null);
    resolvedState.at = now();
    resolvedState.value = { status, active: null };
    return status;
  }

  let status = base;
  let usable = found;
  try {
    const probe = await probeToken(found.token, { fetchImpl });
    status = { ...base, ...probe, inUse: true };
  } catch (err) {
    // An unusable token is worse than none: attaching it turns every GitHub
    // request into a 401. So it is reported and dropped, and the anonymous
    // paths keep working — which is the whole reason they exist.
    status = { ...base, error: String(err?.message ?? err), needsLogin: true, inUse: false };
    usable = null;
  }
  const nextActive = usable ? { source: usable.source, token: usable.token, login: status.login } : null;
  setActiveGithubAuth(nextActive);
  resolvedState.at = now();
  resolvedState.value = { status, active: nextActive };
  return status;
}

/** Test seam: forget the resolved state (not the stored token). */
export function resetGithubAuthCache() {
  resolvedState.at = 0;
  resolvedState.value = null;
  resetGhCache();
}
