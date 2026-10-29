// lib/self-update.js — does *this plugin* have a newer published version?
//
// The panel manages two different kinds of "update", and they must not be
// confused:
//   - lib/updates.js  → the MCP *servers* this plugin mounts (npx / uvx pins);
//   - this module     → the plugin itself (`dsh-overall-mcp` as a DSH plugin).
//
// The install shape decides whether a self-update is even meaningful:
//   - `node_modules/…` inside a profile  → pnpm owns the version; npm can have
//     a newer release, so the check is real and the update is `dsh plugin --profile <p> add <pkg>@<v>`;
//   - anywhere else (`link:` / a workspace checkout) → the loaded code *is* the
//     source tree the user edits. There is no published update to apply, and
//     pretending otherwise would offer a button that overwrites local work.
//
// Everything here is pure enough to unit-test: the network call and the child
// process are both injectable.

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, latestPackageVersion } from './updates.js';

const PACKAGE_NAME = 'dsh-overall-mcp';
const DEFAULT_CACHE_MS = 10 * 60 * 1000;

/** Read `{ name, version }` from the package.json that owns `moduleUrl`. */
export async function readSelfPackage(moduleUrl) {
  const dir = path.dirname(fileURLToPath(moduleUrl));
  const raw = await readFile(path.join(dir, 'package.json'), 'utf8');
  const pkg = JSON.parse(raw);
  return { name: typeof pkg.name === 'string' && pkg.name ? pkg.name : PACKAGE_NAME, version: String(pkg.version ?? '') };
}

/**
 * Where is this plugin's code loaded from, and who owns its version?
 * @returns {{mode:'registry'|'link', packageDir:string, profileDir:string|null,
 *            profileName:string|null, spec:string|null}}
 */
export function resolveInstall(modulePath) {
  const packageDir = path.dirname(modulePath);
  // The *last* node_modules segment, so nested stores (pnpm's .pnpm layout)
  // still resolve to the profile that owns the dependency.
  const marker = `${path.sep}node_modules${path.sep}`;
  const at = modulePath.lastIndexOf(marker);
  if (at === -1) {
    return { mode: 'link', packageDir, profileDir: null, profileName: null, spec: null };
  }
  const profileDir = modulePath.slice(0, at);
  const profileName = path.basename(profileDir);
  return { mode: 'registry', packageDir, profileDir, profileName, spec: null };
}

/** Read the profile's declared spec for this package (`^1.2.3`, `link:…`, …). */
export async function readInstalledSpec(profileDir, name = PACKAGE_NAME) {
  if (!profileDir) return null;
  try {
    const raw = await readFile(path.join(profileDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const spec = pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name];
    return typeof spec === 'string' ? spec : null;
  } catch {
    return null;
  }
}

/**
 * Is this dependency spec a Git source rather than a published version?
 *
 * pnpm accepts several spellings — `github:owner/repo`, `git+https://…`,
 * `git://…#tag`, a bare `https://…/repo.git` — and none of them names a
 * version on a registry. The distinction matters here: a Git install has no
 * "newer published version" to look for, so asking npm would answer 404 for a
 * package that was never meant to exist there.
 */
export function isGitSpec(spec) {
  if (typeof spec !== 'string') return false;
  const value = spec.trim();
  return /^github:/i.test(value)
    || /^git\+/i.test(value)
    || /^git:/i.test(value)
    || /^https?:\/\/\S+\.git(#.*)?$/i.test(value);
}

/**
 * Check whether a newer published version of this plugin exists.
 *
 * @param {object} options
 * @param {string} options.moduleUrl      `import.meta.url` of the caller
 * @param {Function} [options.fetchImpl]  fetch replacement (tests)
 * @param {number} [options.cacheMs]      memo window; 0 disables the cache
 * @param {boolean} [options.force]       bypass the memo
 * @param {object|null} [options.cache]   caller-owned memo holder
 */
export async function checkSelfUpdate({
  moduleUrl,
  fetchImpl = fetch,
  cacheMs = DEFAULT_CACHE_MS,
  force = false,
  cache = null,
} = {}) {
  const self = await readSelfPackage(moduleUrl);
  const install = resolveInstall(fileURLToPath(moduleUrl));
  const base = {
    name: self.name,
    version: self.version,
    install: install.mode,
    packageDir: install.packageDir,
    profileDir: install.profileDir,
    profileName: install.profileName,
  };

  if (install.mode === 'link') {
    return {
      ...base,
      checked: false,
      latest: null,
      updateAvailable: false,
      reason: 'linked',
      hint: '当前 profile 以 link: 指向本地目录，直接改本地代码即可；不提供从 npm 更新',
    };
  }

  const spec = await readInstalledSpec(install.profileDir, self.name);
  if (spec && /^(link|file|workspace|portal):/.test(spec)) {
    return {
      ...base,
      spec,
      checked: false,
      latest: null,
      updateAvailable: false,
      reason: 'linked',
      hint: `profile 里声明为 ${spec}，本地目录就是版本来源`,
    };
  }

  // A Git source install carries no published version: the lockfile pins a
  // commit, and the only meaningful update is re-adding the same spec (with a
  // new `#tag` if the user wants to pin one). Reporting "npm has no such
  // package" would be true, and useless — this package was never meant to be
  // on npm, so the check itself does not apply.
  if (spec && isGitSpec(spec)) {
    return {
      ...base,
      spec,
      checked: false,
      latest: null,
      updateAvailable: false,
      reason: 'git',
      hint: `profile 里声明为 ${spec}，锁文件钉住的是某个提交；要更新就重新执行 dsh plugin add ${spec}（想钉版本可以写成 ${spec}#<tag>）`,
    };
  }

  const key = `${self.name}@${self.version}`;
  if (!force && cache && cacheMs > 0 && cache.key === key && Date.now() - cache.at < cacheMs) {
    return { ...cache.value, cached: true };
  }

  let latest = null;
  try {
    latest = await latestPackageVersion('npm', self.name, { fetchImpl });
  } catch (err) {
    const value = {
      ...base,
      spec,
      checked: true,
      latest: null,
      updateAvailable: false,
      reason: 'lookup-failed',
      hint: `npm 上查不到 ${self.name} 的发布版本：${String(err?.message ?? err)}`,
    };
    if (cache) Object.assign(cache, { key, at: Date.now(), value });
    return value;
  }

  const updateAvailable = compareVersions(latest, self.version) > 0;
  const value = {
    ...base,
    spec,
    checked: true,
    latest,
    updateAvailable,
    reason: updateAvailable ? 'newer-published' : 'up-to-date',
  };
  if (cache) Object.assign(cache, { key, at: Date.now(), value });
  return value;
}

/** Locate the `dsh` launcher without assuming the app's PATH is the user's. */
export function resolveLauncher() {
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN;
  const appData = process.env.APPDATA;
  if (appData) {
    for (const candidate of ['dsh.cmd', 'dsh.exe', 'dsh']) {
      const full = path.join(appData, 'npm', candidate);
      if (existsSync(full)) return full;
    }
  }
  return 'dsh';
}

/** Default runner: one child process, bounded output, no shell interpolation of args. */
function defaultRun(file, args, { cwd, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || (error ? String(error.message ?? '') : ''),
        });
      });
  });
}

/**
 * Install the newer published version into the profile that loads this plugin.
 * Returns the exact command it ran, so the panel can show it either way.
 */
export async function updateSelf({ moduleUrl, fetchImpl = fetch, run = defaultRun, launcher = resolveLauncher() } = {}) {
  const check = await checkSelfUpdate({ moduleUrl, fetchImpl, force: true });
  if (!check.checked) {
    return { ok: false, updated: false, reason: check.reason, hint: check.hint, command: null };
  }
  if (!check.updateAvailable) {
    return { ok: false, updated: false, reason: check.reason, version: check.version, latest: check.latest, command: null };
  }
  if (!check.profileName) {
    return { ok: false, updated: false, reason: 'unknown-profile', hint: '无法确定当前 profile 名称', command: null };
  }
  const args = ['plugin', '--profile', check.profileName, 'add', `${check.name}@${check.latest}`];
  const command = `dsh ${args.join(' ')}`;
  const result = await run(launcher, args, { cwd: check.profileDir });
  return {
    ok: result.code === 0,
    updated: result.code === 0,
    command,
    from: check.version,
    to: check.latest,
    code: result.code,
    stdout: result.stdout.trim().slice(-4000),
    stderr: result.stderr.trim().slice(-4000),
    restartRequired: true,
    hint: result.code === 0
      ? `已安装 ${check.name}@${check.latest}；重启 DSH 后生效`
      : '自动更新失败，可在终端手动执行上面这条命令',
  };
}
