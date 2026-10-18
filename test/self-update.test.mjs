// Self-update: the plugin's own version check must be honest about how it was
// installed. A `link:`/checkout install has no published version to move to, so
// the panel must never offer a button that would overwrite local work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkSelfUpdate,
  isGitSpec,
  readInstalledSpec,
  readSelfPackage,
  resolveInstall,
  resolveLauncher,
  updateSelf,
} from '../lib/self-update.js';

/** Build a fake install: <root>/profiles/<name>/node_modules/dsh-overall-mcp/index.js */
async function fakeProfile({ name = 'desktop', spec = '^0.1.0', version = '0.1.0', withPackage = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omkt-self-'));
  const profileDir = path.join(root, 'profiles', name);
  const packageDir = path.join(profileDir, 'node_modules', 'dsh-overall-mcp');
  await mkdir(packageDir, { recursive: true });
  const modulePath = path.join(packageDir, 'index.js');
  await writeFile(modulePath, '// stub\n', 'utf8');
  if (withPackage) {
    await writeFile(path.join(packageDir, 'package.json'),
      JSON.stringify({ name: 'dsh-overall-mcp', version }), 'utf8');
  }
  await writeFile(path.join(profileDir, 'package.json'),
    JSON.stringify({ name: `dsh-profile-${name}`, dependencies: { 'dsh-overall-mcp': spec } }), 'utf8');
  return { root, profileDir, packageDir, modulePath, moduleUrl: pathToFileURL(modulePath).href };
}

/** A linked checkout: the module lives outside any node_modules. */
async function fakeLink({ version = '0.1.0' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omkt-link-'));
  const packageDir = path.join(root, 'workspace', 'dsh-overall-mcp');
  await mkdir(packageDir, { recursive: true });
  const modulePath = path.join(packageDir, 'index.js');
  await writeFile(modulePath, '// stub\n', 'utf8');
  await writeFile(path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'dsh-overall-mcp', version }), 'utf8');
  return { root, packageDir, modulePath, moduleUrl: pathToFileURL(modulePath).href };
}

const npmFetch = (version) => async (url) => {
  assert.match(String(url), /registry\.npmjs\.org\/dsh-overall-mcp$/);
  return { ok: true, json: async () => ({ 'dist-tags': { latest: version } }) };
};

test('resolveInstall separates a profile install from a linked checkout', async () => {
  const p = await fakeProfile();
  const l = await fakeLink();
  try {
    const inside = resolveInstall(p.modulePath);
    assert.equal(inside.mode, 'registry');
    assert.equal(inside.profileName, 'desktop');
    assert.equal(inside.profileDir, p.profileDir);

    const linked = resolveInstall(l.modulePath);
    assert.equal(linked.mode, 'link');
    assert.equal(linked.profileName, null);
  } finally {
    await rm(p.root, { recursive: true, force: true });
    await rm(l.root, { recursive: true, force: true });
  }
});

test('readSelfPackage and readInstalledSpec read the manifests that own the code', async () => {
  const p = await fakeProfile({ spec: '^0.2.0', version: '0.1.9' });
  try {
    assert.deepEqual(await readSelfPackage(p.moduleUrl), { name: 'dsh-overall-mcp', version: '0.1.9' });
    assert.equal(await readInstalledSpec(p.profileDir), '^0.2.0');
    assert.equal(await readInstalledSpec(null), null);
    assert.equal(await readInstalledSpec(path.join(p.root, 'nope')), null);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('a newer published version is offered, an equal one is not', async () => {
  const p = await fakeProfile({ version: '0.1.0' });
  try {
    const newer = await checkSelfUpdate({ moduleUrl: p.moduleUrl, fetchImpl: npmFetch('0.2.0') });
    assert.equal(newer.install, 'registry');
    assert.equal(newer.profileName, 'desktop');
    assert.equal(newer.latest, '0.2.0');
    assert.equal(newer.updateAvailable, true);
    assert.equal(newer.reason, 'newer-published');

    const same = await checkSelfUpdate({ moduleUrl: p.moduleUrl, fetchImpl: npmFetch('0.1.0') });
    assert.equal(same.updateAvailable, false);
    assert.equal(same.reason, 'up-to-date');
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('a linked checkout never offers an update, whatever npm says', async () => {
  const l = await fakeLink();
  try {
    let called = 0;
    const check = await checkSelfUpdate({
      moduleUrl: l.moduleUrl,
      fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({ 'dist-tags': { latest: '9.9.9' } }) }; },
    });
    assert.equal(check.install, 'link');
    assert.equal(check.checked, false);
    assert.equal(check.updateAvailable, false);
    assert.equal(check.reason, 'linked');
    assert.match(check.hint, /link/);
    assert.equal(called, 0, 'no registry request for an install npm cannot update');
  } finally {
    await rm(l.root, { recursive: true, force: true });
  }
});

test('a link: spec inside node_modules is treated as linked too', async () => {
  const p = await fakeProfile({ spec: 'link:../../workspace/dsh-overall-mcp' });
  try {
    const check = await checkSelfUpdate({
      moduleUrl: p.moduleUrl,
      fetchImpl: async () => { throw new Error('must not be called'); },
    });
    assert.equal(check.updateAvailable, false);
    assert.equal(check.reason, 'linked');
    assert.equal(check.spec, 'link:../../workspace/dsh-overall-mcp');
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('a Git source install is not an npm install, so there is nothing to compare', async () => {
  const p = await fakeProfile({ spec: 'github:YunzhouLi-hub/dsh-overall-mcp' });
  try {
    let called = 0;
    const check = await checkSelfUpdate({
      moduleUrl: p.moduleUrl,
      fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({ 'dist-tags': { latest: '9.9.9' } }) }; },
    });
    // It *is* a profile install — the code sits in node_modules — but nothing
    // npm knows about defines what that install should become.
    assert.equal(check.install, 'registry');
    assert.equal(check.checked, false);
    assert.equal(check.updateAvailable, false);
    assert.equal(check.reason, 'git');
    assert.equal(check.spec, 'github:YunzhouLi-hub/dsh-overall-mcp');
    assert.match(check.hint, /dsh plugin add github:YunzhouLi-hub\/dsh-overall-mcp/);
    assert.equal(called, 0, 'a Git install must not be looked up on npm');
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('updateSelf refuses a Git install instead of running an npm command', async () => {
  const p = await fakeProfile({ spec: 'github:YunzhouLi-hub/dsh-overall-mcp' });
  try {
    let ran = 0;
    const result = await updateSelf({
      moduleUrl: p.moduleUrl,
      run: async () => { ran += 1; return { code: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'git');
    assert.equal(result.command, null);
    assert.equal(ran, 0, 'no command may run for an install npm cannot resolve');
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('isGitSpec knows the spellings pnpm accepts, and nothing else', () => {
  for (const spec of [
    'github:YunzhouLi-hub/dsh-overall-mcp',
    'github:owner/repo#v1.2.3',
    'git+https://github.com/owner/repo.git',
    'git://github.com/owner/repo.git',
    'https://github.com/owner/repo.git',
    'https://github.com/owner/repo.git#main',
  ]) {
    assert.equal(isGitSpec(spec), true, spec);
  }
  for (const spec of ['^0.2.0', '0.12.7', 'link:../x', 'file:../x', 'workspace:*', '', 'https://example.com/readme', null, undefined]) {
    assert.equal(isGitSpec(spec), false, String(spec));
  }
});

test('a registry failure degrades to “no update”, never to an exception', async () => {
  const p = await fakeProfile();
  try {
    const check = await checkSelfUpdate({
      moduleUrl: p.moduleUrl,
      fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    });
    assert.equal(check.checked, true);
    assert.equal(check.updateAvailable, false);
    assert.equal(check.reason, 'lookup-failed');
    assert.match(check.hint, /404/);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('the memo absorbs repeated checks and force bypasses it', async () => {
  const p = await fakeProfile();
  const cache = {};
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ 'dist-tags': { latest: '0.2.0' } }) }; };
  try {
    await checkSelfUpdate({ moduleUrl: p.moduleUrl, fetchImpl, cache });
    const second = await checkSelfUpdate({ moduleUrl: p.moduleUrl, fetchImpl, cache });
    assert.equal(calls, 1);
    assert.equal(second.cached, true);
    await checkSelfUpdate({ moduleUrl: p.moduleUrl, fetchImpl, cache, force: true });
    assert.equal(calls, 2);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('updateSelf runs the profile install command and reports the version move', async () => {
  const p = await fakeProfile({ version: '0.1.0' });
  const seen = [];
  try {
    const result = await updateSelf({
      moduleUrl: p.moduleUrl,
      fetchImpl: npmFetch('0.3.0'),
      launcher: 'dsh',
      run: async (file, args, opts) => {
        seen.push({ file, args, cwd: opts.cwd });
        return { code: 0, stdout: 'Progress: resolved 1, reused 0\n+ dsh-overall-mcp 0.3.0\n', stderr: '' };
      },
    });
    assert.deepEqual(seen, [{ file: 'dsh', args: ['plugin', '--profile', 'desktop', 'add', 'dsh-overall-mcp@0.3.0'], cwd: p.profileDir }]);
    assert.equal(result.ok, true);
    assert.equal(result.command, 'dsh plugin --profile desktop add dsh-overall-mcp@0.3.0');
    assert.equal(result.from, '0.1.0');
    assert.equal(result.to, '0.3.0');
    assert.equal(result.restartRequired, true);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('updateSelf refuses to run when there is nothing to install', async () => {
  const p = await fakeProfile({ version: '0.1.0' });
  const l = await fakeLink();
  let ran = 0;
  try {
    const upToDate = await updateSelf({
      moduleUrl: p.moduleUrl,
      fetchImpl: npmFetch('0.1.0'),
      run: async () => { ran += 1; return { code: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(upToDate.ok, false);
    assert.equal(upToDate.reason, 'up-to-date');

    const linked = await updateSelf({
      moduleUrl: l.moduleUrl,
      fetchImpl: npmFetch('9.9.9'),
      run: async () => { ran += 1; return { code: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(linked.ok, false);
    assert.equal(linked.reason, 'linked');
    assert.equal(ran, 0, 'no child process for a case that cannot be updated');
  } finally {
    await rm(p.root, { recursive: true, force: true });
    await rm(l.root, { recursive: true, force: true });
  }
});

test('a failed install keeps the command so the panel can hand it to the user', async () => {
  const p = await fakeProfile({ version: '0.1.0' });
  try {
    const result = await updateSelf({
      moduleUrl: p.moduleUrl,
      fetchImpl: npmFetch('0.4.0'),
      run: async () => ({ code: 1, stdout: '', stderr: 'ERR_PNPM_NO_MATCHING_VERSION' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.updated, false);
    assert.match(result.command, /add dsh-overall-mcp@0\.4\.0$/);
    assert.match(result.stderr, /ERR_PNPM_NO_MATCHING_VERSION/);
    assert.match(result.hint, /手动执行/);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('resolveLauncher prefers an existing DSH_BIN and always returns something runnable', () => {
  const previous = process.env.DSH_BIN;
  try {
    const selfUrl = new URL('../lib/self-update.js', import.meta.url);
    const libPath = path.dirname(new URL(selfUrl).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    process.env.DSH_BIN = path.join(libPath, 'updates.js');
    assert.equal(resolveLauncher(), process.env.DSH_BIN);
    process.env.DSH_BIN = path.join(libPath, 'no-such-file');
    assert.ok(resolveLauncher().length > 0);
  } finally {
    if (previous === undefined) delete process.env.DSH_BIN;
    else process.env.DSH_BIN = previous;
  }
});

test('this checkout is loaded as a link, so this plugin never self-updates from npm', async () => {
  // The repository's own test run must observe the honest answer for its own
  // layout — the workspace copy is not inside a profile's node_modules.
  const here = new URL('../index.js', import.meta.url);
  const check = await checkSelfUpdate({ moduleUrl: here.href, fetchImpl: npmFetch('99.0.0') });
  assert.equal(check.install, 'link');
  assert.equal(check.updateAvailable, false);
  assert.equal(check.version, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(existsSync(new URL('../index.js', import.meta.url)), true);
});
