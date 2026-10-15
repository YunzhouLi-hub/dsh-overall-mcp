// lib/updates.js — package-version awareness for registered MCP servers.
//
// A registry entry only has a checkable "version" when it is launched through a
// package runner:
//   npx -y <pkg>[@ver] …            (npm family)
//   cmd.exe /d /c npx -y <pkg> …    (Windows wrapper, as imported from clients)
//   uvx <pkg>…                      (PyPI)
// Direct binaries (`codegraph serve --mcp`, `python server.py`) are reported as
// not detectable instead of guessing.
//
// Pure logic + injectable fetch; no I/O beyond the two registry lookups.

const NPM_RUNNERS = new Set(['npx', 'npx.cmd', 'npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd', 'bunx']);
const PY_RUNNERS = new Set(['uvx', 'uvx.exe', 'uv', 'pipx']);
const SHELL_WRAPPERS = /(?:^|[\\/])(?:cmd|cmd\.exe|sh|bash|zsh)$/i;
const NPM_REGISTRY = 'https://registry.npmjs.org';
const PYPI_REGISTRY = 'https://pypi.org/pypi';

/** Split `@scope/name@1.2.3` / `name@1.2.3` / `name` into { pkg, version }. */
export function splitPackageSpec(token) {
  if (typeof token !== 'string' || token === '') return null;
  const at = token.startsWith('@') ? token.indexOf('@', 1) : token.indexOf('@');
  if (at > 0) {
    const version = token.slice(at + 1);
    return { pkg: token.slice(0, at), version: version === '' ? null : version };
  }
  return { pkg: token, version: null };
}

/** Render the argument token for one package at one exact version. */
export function packageSpec(pkg, version) {
  return version ? `${pkg}@${version}` : pkg;
}

/**
 * Locate the package invocation inside one registry entry's command/args.
 * @returns {{manager:'npm'|'pypi', pkg:string, version:string|null, argsIndex:number}|null}
 */
export function parsePackageInvocation(entry) {
  if (!entry || entry.transport !== 'stdio') return null;
  const command = typeof entry.command === 'string' ? entry.command : '';
  const original = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const head = command.split(/[\\/]/).pop() ?? '';

  let tokens = original;
  let offset = 0;
  if (SHELL_WRAPPERS.test(head)) {
    const index = tokens.findIndex((t) => t === '/c' || t === '-c');
    if (index >= 0) {
      offset = index + 1;
      tokens = tokens.slice(offset);
    }
  }

  let manager = null;
  let runnerLocal = -1;
  if (NPM_RUNNERS.has(head.toLowerCase())) manager = 'npm';
  else if (PY_RUNNERS.has(head.toLowerCase())) manager = 'pypi';
  else {
    const index = tokens.findIndex((t) => {
      const lower = t.toLowerCase();
      return NPM_RUNNERS.has(lower) || PY_RUNNERS.has(lower);
    });
    if (index < 0) return null;
    manager = NPM_RUNNERS.has(tokens[index].toLowerCase()) ? 'npm' : 'pypi';
    runnerLocal = index;
  }

  const after = tokens.slice(runnerLocal + 1);
  const localIndex = after.findIndex((t) => t && !t.startsWith('-'));
  if (localIndex < 0) return null;

  const split = splitPackageSpec(after[localIndex]);
  if (!split?.pkg) return null;

  return {
    manager,
    pkg: split.pkg,
    version: split.version,
    argsIndex: offset + runnerLocal + 1 + localIndex,
  };
}

/** Numeric, prerelease-aware version comparison (a > b → positive). */
export function compareVersions(a, b) {
  const parse = (value) => String(value ?? '').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pre = (value) => (String(value ?? '').includes('-') ? String(value).split('-').slice(1).join('-') : '');
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  const pa = pre(a);
  const pb = pre(b);
  if (pa === pb) return 0;
  if (pa === '') return 1; // release outranks prerelease
  if (pb === '') return -1;
  return pa > pb ? 1 : -1;
}

/** Rewrite an entry's args so the package is pinned to `version`. */
export function pinArgs(entry, version) {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const invocation = parsePackageInvocation(entry);
  if (!invocation) return args;
  args[invocation.argsIndex] = packageSpec(invocation.pkg, version);
  return args;
}

async function fetchJson(url, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Look up the latest published version of one package. */
export async function latestPackageVersion(manager, pkg, opts = {}) {
  if (manager === 'npm') {
    const data = await fetchJson(`${NPM_REGISTRY}/${pkg}`, opts);
    const latest = data?.['dist-tags']?.latest ?? data?.version;
    if (!latest) throw new Error('no published version found');
    return String(latest);
  }
  const data = await fetchJson(`${PYPI_REGISTRY}/${pkg}/json`, opts);
  const latest = data?.info?.version;
  if (!latest) throw new Error('no published version found');
  return String(latest);
}

/**
 * Check one registry entry for an available update.
 * @returns {detectable, manager?, pkg?, current?, latest?, updateAvailable?, reason?}
 */
export async function checkEntryUpdate(entry, opts = {}) {
  const invocation = parsePackageInvocation(entry);
  if (!invocation) {
    return { detectable: false, reason: 'not launched through a package runner' };
  }
  const { manager, pkg, version } = invocation;
  try {
    const latest = await latestPackageVersion(manager, pkg, opts);
    const unpinned = version === null;
    return {
      detectable: true,
      manager,
      pkg,
      current: version ?? latest,
      latest,
      unpinned,
      // An unpinned runner already resolves to the newest release.
      updateAvailable: !unpinned && compareVersions(latest, version) > 0,
    };
  } catch (err) {
    return {
      detectable: true,
      manager,
      pkg,
      current: version,
      latest: null,
      updateAvailable: false,
      error: String(err?.message ?? err),
    };
  }
}

/**
 * Check every entry that has a package identity.
 * @returns {{entries: object[], updatable: number, checked: number}}
 */
export async function checkAllUpdates(entries, opts = {}) {
  const results = [];
  for (const entry of entries) {
    const check = await checkEntryUpdate(entry, opts);
    results.push({ name: entry.name, source: entry.source, enabled: entry.enabled !== false, ...check });
  }
  const checked = results.filter((r) => r.detectable).length;
  return { entries: results, checked, updatable: results.filter((r) => r.updateAvailable).length };
}
