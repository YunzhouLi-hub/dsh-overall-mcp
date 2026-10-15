// test/submissions.test.mjs — lib/submissions.js, the 「申请收录 MCP 服务」 queue.
//
// The queue is the one place in this plugin that writes a file whose name comes
// from a remote submitter, and the one place where a wrong answer silently
// publishes something into the registry. Both are worth pinning down without a
// host: the store is pure data, so every rule here is a plain function call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_UPLOAD_BYTES, emptySubmissions, normalizeSubmissions, readSubmissions, writeSubmissions,
  newSubmission, newSubmissionId, reviewSubmissionIn, submissionsPayload, submissionEntry,
  submissionProblem, findSubmission, safeFileName,
} from '../lib/submissions.js';

test('safeFileName turns a submitted name into a bare file name', async () => {
  // A submitter controls this string and it becomes a path component.
  assert.equal(safeFileName('../../evil/notes.tgz'), 'notes.tgz');
  assert.equal(safeFileName('C:\\Users\\x\\a b.zip'), 'a b.zip');
  assert.equal(safeFileName('a:b*c?.json'), 'a-b-c-.json');
  assert.equal(safeFileName('   '), 'upload.bin');
  assert.equal(safeFileName(''), 'upload.bin');
  assert.equal(safeFileName(null), 'upload.bin');
  assert.equal(safeFileName('x'.repeat(400)).length, 120);
});

test('submissionProblem names what is missing, and accepts a plain form', async () => {
  assert.equal(submissionProblem({ name: 'acme', link: 'https://example.test/a' }), null);
  assert.match(submissionProblem({ link: 'https://example.test/a' }), /name is required/);
  assert.match(submissionProblem({ name: 'acme' }), /link is required/);
  assert.match(submissionProblem({ name: 'acme', link: 'ftp://example.test/a' }), /http\(s\) URL/);
  assert.match(submissionProblem({ name: 'acme', link: 'https://a', note: 'x'.repeat(401) }), /note is longer/);
  assert.match(submissionProblem({ name: 'acme', link: 'https://a', contributor: 'x'.repeat(41) }), /contributor is longer/);
});

test('normalizeSubmissions keeps usable rows and drops the rest', async () => {
  const store = normalizeSubmissions({
    version: 99,
    items: [
      { id: 's1', name: 'a', link: 'https://a', status: 'approved', contributor: 'me', entry: 'a', install: { transport: 'stdio', command: 'npx', args: ['-y', 'a'] }, reviewedAt: '2026-01-01' },
      { id: 's2', name: 'b', link: 'https://b', status: 'weird' },
      { id: 's3', name: '', link: 'https://c' },
      { name: 'd', link: 'https://d' },
      'not-an-object',
    ],
  });
  assert.equal(store.items.length, 2, 'a row with no id or no name is not a submission');
  assert.equal(store.items[0].status, 'approved');
  assert.equal(store.items[0].install.command, 'npx');
  assert.equal(store.items[0].contributor, 'me');
  // An unknown status is a pending one, not an approved one.
  assert.equal(store.items[1].status, 'pending');
  assert.equal(store.items[1].install, undefined);
  assert.deepEqual(emptySubmissions(), { version: 1, items: [] });
});

test('the queue round-trips through disk, and a corrupt file reads as empty', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'submissions-store-'));
  try {
    const file = path.join(home, 'submissions.json');
    const store = emptySubmissions();
    store.items.push(newSubmission({ name: 'acme', link: 'https://a', contributor: 'me' }, { id: 's1', at: '2026-01-01T00:00:00.000Z' }));
    await writeSubmissions(file, store);
    const reread = await readSubmissions(file);
    assert.equal(reread.items.length, 1);
    assert.equal(reread.items[0].id, 's1');

    await fs.writeFile(file, '{ not json', 'utf8');
    assert.deepEqual((await readSubmissions(file)).items, []);
    assert.deepEqual((await readSubmissions(path.join(home, 'absent.json'))).items, []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('newSubmission keeps the form, not the caller\'s file object', async () => {
  const item = newSubmission({
    name: '  acme  ',
    link: ' https://example.test/acme ',
    note: 'demo',
    contributor: '张三',
    // The bytes live on disk, written by the caller; only the metadata is stored.
    file: { name: 'a/b.tgz', bytes: 5, data: 'aGVsbG8=', path: 'submissions/s1/b.tgz' },
  }, { id: 's1', at: '2026-02-02T00:00:00.000Z' });
  assert.equal(item.status, 'pending');
  assert.equal(item.name, 'acme');
  assert.equal(item.link, 'https://example.test/acme');
  assert.equal(item.contributor, '张三');
  assert.deepEqual(item.file, { name: 'b.tgz', bytes: 5, path: 'submissions/s1/b.tgz' });
  assert.equal(item.file.data, undefined, 'base64 never reaches the stored JSON');
  assert.ok(newSubmissionId().startsWith('s'));

  const namelessFile = newSubmission({ name: 'a', link: 'https://a', file: { data: 'aGVsbG8=' } });
  assert.equal(namelessFile.file, undefined);
});

test('reviewSubmissionIn records the decision and refuses nonsense', async () => {
  const store = emptySubmissions();
  store.items.push(newSubmission({ name: 'acme', link: 'https://a' }, { id: 's1', at: '2026-01-01T00:00:00.000Z' }));
  store.items.push(newSubmission({ name: 'ghost', link: 'https://b' }, { id: 's2', at: '2026-01-02T00:00:00.000Z' }));

  const approved = reviewSubmissionIn(store, {
    id: 's1', decision: 'approve', install: { transport: 'streamable-http', url: 'https://a/mcp' }, entry: 'acme',
  });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.entry, 'acme');
  assert.deepEqual(approved.install, { transport: 'streamable-http', url: 'https://a/mcp' });

  const rejected = reviewSubmissionIn(store, { id: 's2', decision: 'reject', reason: '不是一个 MCP 服务' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, '不是一个 MCP 服务');
  assert.equal(rejected.install, undefined);

  assert.throws(() => reviewSubmissionIn(store, { id: 'nope', decision: 'approve' }), /^Error: unknown submission: nope$/);
  assert.throws(() => reviewSubmissionIn(store, { id: 's1', decision: 'maybe' }), /invalid submission decision/);
  assert.equal(findSubmission(store, 's1'), approved);
  assert.equal(findSubmission(store, 'nope'), null);
});

test('submissionEntry writes a mountable row or an explicitly display-only one', async () => {
  const item = { id: 's1', name: 'acme', link: 'https://example.test/acme', contributor: '张三', note: 'demo' };

  const stdio = submissionEntry(item, { install: { transport: 'stdio', command: 'npx', args: ['-y', 'acme'] } });
  assert.equal(stdio.source, 'contribution');
  assert.equal(stdio.transport, 'stdio');
  assert.equal(stdio.command, 'npx');
  assert.deepEqual(stdio.args, ['-y', 'acme']);
  assert.equal(stdio.enabled, true);
  assert.equal(stdio.contributor, '张三');
  assert.equal(stdio.displayOnly, undefined);

  const http = submissionEntry(item, { install: { transport: 'streamable-http', url: 'https://a/mcp' } });
  assert.equal(http.transport, 'streamable-http');
  assert.equal(http.url, 'https://a/mcp');
  assert.equal(http.enabled, true);

  // No mountable information: the row exists so the name and the link are
  // visible, and `toMcpConfig()` must never read it as a stdio launch.
  const display = submissionEntry(item, {});
  assert.equal(display.displayOnly, true);
  assert.equal(display.enabled, false);
  assert.equal(display.transport, 'discovery');
  assert.equal(display.command, undefined);
  assert.equal(display.url, undefined);
  assert.equal(display.submission, 's1');
  assert.equal(display.addedAt !== undefined, true);
});

test('submissionsPayload sorts newest first and counts only pending rows', async () => {
  const store = emptySubmissions();
  store.items.push(newSubmission({ name: 'old', link: 'https://a' }, { id: 's1', at: '2026-01-01T00:00:00.000Z' }));
  store.items.push(newSubmission({ name: 'new', link: 'https://b' }, { id: 's2', at: '2026-03-01T00:00:00.000Z' }));
  reviewSubmissionIn(store, { id: 's1', decision: 'approve' });
  const payload = submissionsPayload(store);
  assert.deepEqual(payload.items.map((item) => item.id), ['s2', 's1']);
  assert.equal(payload.pending, 1);
  assert.equal(submissionsPayload(emptySubmissions()).pending, 0);
  assert.equal(MAX_UPLOAD_BYTES, 512 * 1024);
});
