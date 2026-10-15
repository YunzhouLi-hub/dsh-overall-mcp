// test/install-diagnosis.test.mjs — the text half of the install-failure
// diagnosis: what leaves the machine, and what comes back.
//
// The host plumbing (which model route, which stream) is covered by the
// plugin-contract test in test/index.test.mjs. This file covers the decisions
// that would be expensive to get wrong and cheap to test: a credential reaching
// a model provider, an invented flag reaching the user, and a stream of blocks
// turning into something other than the model's answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARG_LINES_MAX, DIAGNOSIS_MAX_CHARS, DIAGNOSIS_SYSTEM, ERROR_MAX_CHARS,
  buildDiagnosisPrompt, capText, diagnosisFactsOf, diagnosisTextOf, redactSecrets, redactUrl,
} from '../lib/install-diagnosis.js';

/** The registry entry shape `catalogItemToEntry` produces, plus a secret. */
function entry(over = {}) {
  return {
    name: 'team-search',
    source: 'catalog:docker-catalog',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@acme/search-mcp@1.2.3'],
    // Both of these exist on real entries and neither may reach the prompt.
    env: { ACME_API_KEY: 'sk-live-0123456789abcdef' },
    headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcd' },
    enabled: true,
    ...over,
  };
}

test('the facts of a failed install never carry the entry environment or headers', () => {
  const facts = diagnosisFactsOf({ item: { source: 'docker-catalog' }, entry: entry(), error: 'spawn npx ENOENT' });
  const rendered = JSON.stringify(facts);
  assert.ok(!rendered.includes('sk-live-0123456789abcdef'), 'the env value is absent');
  assert.ok(!rendered.includes('Bearer '), 'the header value is absent');
  assert.ok(!('env' in facts) && !('headers' in facts), 'neither field is copied at all');
  assert.equal(facts.name, 'team-search');
  assert.equal(facts.transport, 'stdio');
  assert.equal(facts.command, 'npx');
  assert.deepEqual(facts.args, ['-y', '@acme/search-mcp@1.2.3']);
});

test('labelled credentials and recognisable token shapes are redacted', () => {
  assert.equal(redactSecrets('npx -y pkg --api-key=sk-live-123'), 'npx -y pkg --api-key=<redacted>');
  assert.equal(redactSecrets('npx -y pkg --token sk-live-123'), 'npx -y pkg --token <redacted>');
  assert.equal(redactSecrets('run --password: hunter2 --verbose'), 'run --password: <redacted> --verbose');
  assert.equal(redactSecrets('Authorization: Bearer ghp_abcdefghijklmnop'), 'Authorization: Bearer <redacted>');
  assert.equal(redactSecrets('key AKIAIOSFODNN7EXAMPLE here'), 'key <redacted> here');
});

test('ordinary command lines survive redaction unchanged', () => {
  const line = 'npx -y @modelcontextprotocol/server-filesystem@2025.8.1 --root . --allow-write';
  assert.equal(redactSecrets(line), line);
  assert.equal(redactSecrets('spawn npx ENOENT'), 'spawn npx ENOENT');
  assert.equal(redactSecrets('MCP error -32000: Connection closed'), 'MCP error -32000: Connection closed');
});

test('a URL is quoted with its credentials removed and its shape kept', () => {
  const out = redactUrl('https://user:pw@mcp.example.com/sse?sig=abc123&tenant=acme#frag');
  const url = new URL(out);
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.equal(url.host, 'mcp.example.com');
  assert.equal(url.pathname, '/sse');
  assert.equal(url.searchParams.get('sig'), '<redacted>');
  assert.equal(url.searchParams.get('tenant'), 'acme');
  assert.equal(url.hash, '#frag');
});

test('a value that is not a URL is still redacted rather than passed through', () => {
  assert.equal(redactUrl('not a url --api-key=sk-live-123'), 'not a url --api-key=<redacted>');
});

test('capText trims, keeps the head, and marks what it cut', () => {
  assert.equal(capText('  hello  '), 'hello');
  assert.equal(capText('abc', 3), 'abc');
  const long = 'x'.repeat(50);
  const capped = capText(long, 10);
  assert.equal(capped.length, 10);
  assert.ok(capped.endsWith('…'));
  assert.ok(capped.startsWith('xxxxxxxx'));
});

test('the prompt carries the command, the error, and a count of what it left out', () => {
  const facts = diagnosisFactsOf({
    item: { source: 'docker-catalog', repository: 'https://github.com/acme/search-mcp', version: '1.2.3' },
    entry: entry({ args: Array.from({ length: ARG_LINES_MAX + 3 }, (_, i) => `--arg${i}`) }),
    error: 'spawn npx ENOENT',
  });
  const prompt = buildDiagnosisPrompt(facts);
  assert.ok(prompt.includes('- 名称：team-search'));
  assert.ok(prompt.includes('- 传输：stdio 命令'));
  assert.ok(prompt.includes('- 命令：npx'));
  assert.ok(prompt.includes('- 参数 1：--arg0'));
  assert.ok(prompt.includes(`- 另有 3 个参数未列出`));
  assert.ok(prompt.includes('- 仓库：https://github.com/acme/search-mcp'));
  assert.ok(prompt.includes('spawn npx ENOENT'));
  assert.ok(prompt.includes('宿主报告的错误'));
});

test('an http entry is described by address, not by command', () => {
  const facts = diagnosisFactsOf({
    item: { source: 'official-registry' },
    entry: entry({ transport: 'streamable-http', command: undefined, args: undefined, url: 'https://mcp.example.com/mcp?token=sk-live-123' }),
    error: 'HTTP 401',
  });
  const prompt = buildDiagnosisPrompt(facts);
  assert.ok(prompt.includes('- 传输：streamable-http 地址'));
  assert.ok(prompt.includes('https://mcp.example.com/mcp?token=%3Credacted%3E'));
  assert.ok(!prompt.includes('sk-live-123'), 'the token never reaches the prompt');
  assert.ok(!prompt.includes('- 命令：'));
});

test('a missing error text is stated instead of being left blank', () => {
  const prompt = buildDiagnosisPrompt(diagnosisFactsOf({ entry: entry(), error: '' }));
  assert.ok(prompt.includes('(没有错误文本)'));
});

test('a very long error is capped, and the cap is announced by its ellipsis', () => {
  const facts = diagnosisFactsOf({ entry: entry(), error: `${'e'.repeat(5000)}` });
  assert.equal(facts.error.length, ERROR_MAX_CHARS);
  assert.ok(facts.error.endsWith('…'));
});

test('the diagnosis is the text blocks only, joined and capped', () => {
  const blocks = [
    { type: 'reasoning', text: 'thinking about it' },
    { type: 'text', text: 'npx 找不到这个包。' },
    { type: 'text', text: '  先运行 npm view @acme/search-mcp version 确认版本存在。  ' },
  ];
  assert.equal(diagnosisTextOf(blocks), 'npx 找不到这个包。\n\n先运行 npm view @acme/search-mcp version 确认版本存在。');
  assert.ok(!diagnosisTextOf(blocks).includes('thinking'));
  assert.equal(diagnosisTextOf([]), '');
  assert.equal(diagnosisTextOf(null), '');
  assert.equal(diagnosisTextOf([{ type: 'reasoning', text: 'only thinking' }]), '');
  const long = diagnosisTextOf([{ type: 'text', text: 'y'.repeat(2000) }]);
  assert.equal(long.length, DIAGNOSIS_MAX_CHARS);
  assert.ok(long.endsWith('…'));
});

test('the system instruction refuses the advice that would make a failure worse', () => {
  assert.ok(DIAGNOSIS_SYSTEM.includes('禁止'));
  assert.ok(DIAGNOSIS_SYSTEM.includes('编造'));
  assert.ok(DIAGNOSIS_SYSTEM.includes('沙箱'));
  assert.ok(DIAGNOSIS_SYSTEM.includes('三行'));
});
