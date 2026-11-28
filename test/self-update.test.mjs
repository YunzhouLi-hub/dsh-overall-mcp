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
  runSelfUpdateCommand,
  updateSelf,
} from '../lib/self-update.js';

/** Build a fake install: <root>/profiles/<name>/node_modules/dsh-overall-mcp/index.js */
async function fakeProfile({ name = 'desktop', spec = '^0.1.0', version = '0.1.0', withPackage = true, repository } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'omkt-self-'));
  const profileDir = path.join(root, 'profiles', name);
  const packageDir = path.join(profileDir, 'node_modules', 'dsh-overall-mcp');
  await mkdir(packageDir, { recursive: true });
  const modulePath = path.join(packageDir, 'index.js');
  await writeFile(modulePath, '// stub\n', 'utf8');
  if (withPackage) {
    await writeFile(path.join(packageDir, 'package.json'),
      JSON.stringify({ name: 'dsh-overall-mcp', version, repository }), 'utf8');
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

test('the official GitHub install checks Releases and only shows instructions when newer', async () => {
  const p = await fakeProfile({ spec: 'github:YunzhouLi-hub/dsh-overall-mcp#fixed', version: '1.0.8' });
  try {
    let tag = 'v1.0.8';
    const fetchImpl = async url => {
      assert.equal(url, 'https://api.github.com/repos/YunzhouLi-hub/dsh-overall-mcp/releases/latest');
      return { ok: true, json: async () => ({ tag_name: tag, draft: false, prerelease: false }) };
    };
    const check = await checkSelfUpdate({
      moduleUrl: p.moduleUrl,
      fetchImpl,
    });
    assert.equal(check.checked, true);
    assert.equal(check.updateAvailable, false);
    assert.equal(check.reason, 'up-to-date');
    assert.equal(check.hint, undefined);
    tag = 'v1.0.9';
    const newer = await checkSelfUpdate({ moduleUrl: p.moduleUrl, fetchImpl });
    assert.equal(newer.updateAvailable, true);
    assert.equal(newer.manual, true);
    assert.equal(newer.releaseUrl, 'https://github.com/YunzhouLi-hub/dsh-overall-mcp/releases/tag/v1.0.9');
    for (const spec of [
      'https://github.com/YunzhouLi-hub/dsh-overall-mcp#main',
      'git+ssh://git@github.com/YunzhouLi-hub/dsh-overall-mcp.git#main',
      'git://github.com/YunzhouLi-hub/dsh-overall-mcp.git#main',
    ]) {
      await writeFile(path.join(p.profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-overall-mcp': spec } }));
      const alternate = await checkSelfUpdate({ moduleUrl: p.moduleUrl, fetchImpl });
      assert.equal(alternate.updateAvailable, true, spec);
      assert.equal(alternate.manual, true, spec);
    }
    const failed = await checkSelfUpdate({ moduleUrl: p.moduleUrl, fetchImpl: async () => ({ ok: false, status: 403 }) });
    assert.equal(failed.reason, 'lookup-failed');
    assert.match(failed.hint, /HTTP 403/);
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('a packaged GitHub release checks for updates after installation from a downloaded archive', async () => {
  const p = await fakeProfile({ spec: 'file:C:/Downloads/dsh-overall-mcp-1.0.8.tgz', version: '1.0.8',
    repository: { url: 'git+https://github.com/YunzhouLi-hub/dsh-overall-mcp.git' } });
  try {
    const fetchImpl = async url => {
      assert.equal(url, 'https://api.github.com/repos/YunzhouLi-hub/dsh-overall-mcp/releases/latest');
      return { ok: true, json: async () => ({ tag_name: 'v1.0.9' }) };
    };
    const report = await checkSelfUpdate({ moduleUrl: p.moduleUrl, fetchImpl });
    assert.equal(report.updateAvailable, true);
    assert.equal(report.manual, true);
    assert.match(report.releaseUrl, /\/v1\.0\.9$/);
    await writeFile(path.join(p.profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-overall-mcp': 'file:../local-checkout' } }));
    const local = await checkSelfUpdate({ moduleUrl: p.moduleUrl, fetchImpl: () => assert.fail('a local checkout must not query a release') });
    assert.equal(local.reason, 'linked');
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('updateSelf keeps installation of GitHub releases manual', async () => {
  const p = await fakeProfile({ spec: 'github:YunzhouLi-hub/dsh-overall-mcp' });
  try {
    let ran = 0;
    const result = await updateSelf({
      moduleUrl: p.moduleUrl,
      fetchImpl: async () => ({ ok: true, json: async () => ({ tag_name: 'v1.0.9' }) }),
      run: async () => { ran += 1; return { code: 0, stdout: '', stderr: '' }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'manual');
    assert.equal(result.command, null);
    assert.equal(ran, 0, 'no command may run for an install npm cannot resolve');
  } finally {
    await rm(p.root, { recursive: true, force: true });
  }
});

test('a pinned official GitHub install updates through the DSH manager to the checked release commit', async () => {
  const repo = 'YunzhouLi-hub/dsh-overall-mcp';
  const sha = 'b'.repeat(40);
  const p = await fakeProfile({ spec: `github:${repo}#${'a'.repeat(40)}`, version: '1.0.9' });
  try {
    const calls = [];
    let application = 'restart-required';
    let tagSha = sha;
    const pluginManager = {
      async updateBundle(...args) {
        calls.push(args);
        return { from: '1.0.9', to: '1.0.10', result: { changed: true, application,
          ...(application === 'failed' ? { error: { code: 'operation-error', diagnostic: 'install failed' } } : {}) } };
      },
    };
    const fetchImpl = async (url) => {
      if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v1.0.10' });
      assert.equal(url, `https://api.github.com/repos/${repo}/commits/v1.0.10`);
      return Response.json({ sha: tagSha });
    };
    const options = { moduleUrl: p.moduleUrl, fetchImpl, pluginManager, run: () => assert.fail('Git update must use DSH manager') };
    assert.equal((await checkSelfUpdate(options)).manual, false);
    const stale = await updateSelf({ ...options, expectedVersion: '1.0.9' });
    assert.equal(stale.reason, 'version-changed');
    assert.deepEqual(calls, []);
    const installed = await updateSelf({ ...options, expectedVersion: '1.0.10' });
    assert.deepEqual(calls, [['dsh-overall-mcp', '1.0.10', { spec: `github:${repo}#${sha}` }]]);
    assert.equal(installed.ok, true);
    assert.equal(installed.restartRequired, true);
    application = 'applied';
    assert.equal((await updateSelf(options)).restartRequired, false);
    application = 'failed';
    const failed = await updateSelf(options);
    assert.equal(failed.ok, false);
    assert.match(failed.hint, /install failed/);
    tagSha = 'main';
    await assert.rejects(updateSelf(options), /未返回完整提交/);
    assert.equal(calls.length, 3);
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


test('pnpm real paths resolve the owning desktop profile, never the store package', async () => {
  const p = await fakeProfile();
  try {
    const realDir = path.join(p.profileDir, 'node_modules', '.pnpm', 'dsh-overall-mcp@0.1.0', 'node_modules', 'dsh-overall-mcp');
    await mkdir(realDir, { recursive: true });
    await writeFile(path.join(realDir, 'package.json'), JSON.stringify({ name: 'dsh-overall-mcp', version: '0.1.0' }));
    const moduleUrl = pathToFileURL(path.join(realDir, 'index.js')).href;
    let invoked;
    const result = await updateSelf({ moduleUrl, fetchImpl: npmFetch('0.2.0'), run: async (file, args, opts) => {
      invoked = { args, cwd: opts.cwd }; return { code: 0, stdout: '', stderr: '' };
    } });
    assert.equal(result.ok, true);
    assert.equal(invoked.cwd, p.profileDir);
    assert.equal(invoked.args[2], 'desktop');
    await writeFile(path.join(p.profileDir, 'package.json'), '{broken');
    await assert.rejects(checkSelfUpdate({ moduleUrl, fetchImpl: npmFetch('0.2.0') }), /package.json/);
    await writeFile(path.join(p.profileDir, 'package.json'), '{}');
    assert.equal((await checkSelfUpdate({ moduleUrl, fetchImpl: npmFetch('0.2.0') })).reason, 'unknown-profile');
  } finally { await rm(p.root, { recursive: true, force: true }); }
});

test('Windows npm launcher executes its JS entry with literal arguments, without a shell', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh shim % audit-'));
  try {
    const packageDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(root, 'dsh.cmd'), '@echo must never execute this shim');
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: './cli.cjs' } }));
    await writeFile(path.join(packageDir, 'cli.cjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const args = ['--version', 'space value', '%PATH%', 'x&echo BAD', '$(echo BAD)'];
    const result = await runSelfUpdateCommand(path.join(root, 'dsh.cmd'), args, { cwd: root });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
    await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: '../escape.cjs' }));
    await assert.rejects(runSelfUpdateCommand(path.join(root, 'dsh.cmd'), args), /启动入口/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
