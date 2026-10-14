// The 「这个 MCP 是干什么的」 line (lib/about.js).
//
// The user's complaint was that a registered row explained nothing after the
// server's name (「MCP下载好之后后面的应该是解释这个MCP的作用」). What matters
// here: the server's own instructions win and are readable in one 12px row (no
// `###`/`**` debris), a server that ships no prose still gets something honest,
// and a server we truly know nothing about returns null instead of a guess.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ABOUT_MAX_CHARS, stripInlineMarkdown, firstParagraph, clampLine, toolNamesFor, describeAbout,
  aboutSourceLabel, needsInstructionsRead,
} from '../lib/about.js';

// Verbatim shape of a real server's instructions: dsh-mcp-client prefixes the
// section with `### MCP server: <name>`, and the server writes markdown prose
// under its own heading.
const CODEGRAPH = [
  '### MCP server: codegraph',
  '',
  '# Codegraph — code intelligence over an indexed knowledge graph',
  '',
  'Codegraph is a SQLite knowledge graph of every symbol, edge, and file in the',
  'workspace. Reads are sub-millisecond; the index lags writes by about a second.',
  '',
  '## Answer directly — don\'t delegate exploration',
  '',
  'For "how does X work" questions, answer DIRECTLY using 2-3 codegraph calls.',
].join('\n');

test('the transport heading and the markdown are stripped, the sentence survives', () => {
  const line = firstParagraph(CODEGRAPH);
  assert.match(line, /^Codegraph is a SQLite knowledge graph/);
  assert.doesNotMatch(line, /###|MCP server: codegraph/);
  // The section's own heading is not the paragraph, but it is kept as a fallback.
  assert.doesNotMatch(line, /^# Codegraph/);
});

test('inline markdown that would look like debris in a row is removed', () => {
  assert.equal(stripInlineMarkdown('**bold** and `code` and [link](https://x.y)'), 'bold and code and link');
  assert.equal(stripInlineMarkdown('an ![image](a.png) inline'), 'an image inline');
  assert.equal(stripInlineMarkdown('line\n  break'), 'line break');
});

test('a prose-free server falls back to its heading, not to a heading-only blank line', () => {
  const headingOnly = '### MCP server: search\n\n# Search — web search for agents\n';
  assert.equal(firstParagraph(headingOnly), 'Search — web search for agents');

  // A navigation label plus a bullet list is not a purpose sentence.
  const labelsOnly = '### MCP server: x\n\nTools:\n\n- a\n- b\n';
  assert.equal(firstParagraph(labelsOnly), '');
  assert.equal(firstParagraph(''), '');
  assert.equal(firstParagraph(undefined), '');
});

test('a short banner paragraph is skipped in favour of a real sentence', () => {
  const text = '### MCP server: x\n\nOverview\n\nThis server indexes every markdown file in the workspace and answers questions about it.';
  assert.match(firstParagraph(text), /^This server indexes/);
});

test('clamping cuts at a sentence or word boundary and marks the cut', () => {
  const long = `${'word '.repeat(60)}end`;
  const cut = clampLine(long, 60);
  assert.ok(cut.length <= 61, `expected a bounded line, got ${cut.length}`);
  assert.ok(cut.endsWith('…'));

  const sentence = `First sentence is long enough to clamp here. ${'x'.repeat(200)}`;
  assert.equal(clampLine(sentence, 60), 'First sentence is long enough to clamp here.');

  // Nothing to cut: returned verbatim, no ellipsis.
  assert.equal(clampLine('Short and complete.', 60), 'Short and complete.');
});

test('tool names are the ones belonging to this server only', () => {
  const schemas = [
    { name: 'mcp__codegraph__codegraph_search' },
    { name: 'mcp__codegraph__codegraph_node' },
    { name: 'mcp__rea__analyze_function' },
    { name: 'read_file' },
    { name: 42 },
  ];
  assert.deepEqual(toolNamesFor(schemas, 'codegraph'), ['codegraph_search', 'codegraph_node']);
  assert.deepEqual(toolNamesFor(schemas, 'rea'), ['analyze_function']);
  assert.deepEqual(toolNamesFor(schemas, 'missing'), []);
  assert.deepEqual(toolNamesFor(null, 'rea'), []);
});

test('evidence order: server instructions, then tools, then the launch command', () => {
  const fromServer = describeAbout({ instructions: CODEGRAPH, toolNames: ['a', 'b'], command: ['npx', 'x'] });
  assert.equal(fromServer.source, 'server');
  assert.match(fromServer.text, /^Codegraph is a SQLite knowledge graph/);

  const fromTools = describeAbout({
    instructions: '### MCP server: x\n\nTools:\n\n',
    toolNames: ['codegraph_search', 'codegraph_node', 'codegraph_explore', 'codegraph_callers'],
    command: ['npx', '-y', 'codegraph'],
  });
  assert.equal(fromTools.source, 'tools');
  assert.equal(fromTools.toolCount, 4);
  assert.equal(fromTools.text, '工具：codegraph_search、codegraph_node、codegraph_explore 等 4 个');

  const shortTools = describeAbout({ toolNames: ['only_one'] });
  assert.equal(shortTools.text, '工具：only_one');

  // Nothing connected yet: the command is the only honest thing to show.
  const fromCommand = describeAbout({ command: ['npx', '-y', 'tayily-mcp@0.1.2'] });
  assert.equal(fromCommand.source, 'command');
  assert.equal(fromCommand.text, 'npx -y tayily-mcp@0.1.2');

  assert.equal(describeAbout({}), null);
  assert.equal(describeAbout({ command: [] }), null);
  assert.equal(describeAbout({ instructions: '   \n\n ' }), null);
});

test('the line stays inside the row budget for every source', () => {
  const huge = `### MCP server: x\n\n${'A very long sentence about capabilities. '.repeat(40)}`;
  for (const about of [
    describeAbout({ instructions: huge }),
    describeAbout({ toolNames: Array.from({ length: 40 }, (_, i) => `tool_with_a_long_name_${i}`) }),
    describeAbout({ command: ['npx', '-y', 'x'.repeat(400)] }),
  ]) {
    assert.ok(about.text.length <= ABOUT_MAX_CHARS + 1, `too long: ${about.text.length}`);
  }
});

test('every source has a label saying where the sentence came from', () => {
  assert.match(aboutSourceLabel('server'), /服务器自身的说明/);
  assert.match(aboutSourceLabel('tools'), /已注册的工具/);
  assert.match(aboutSourceLabel('command', { connecting: true }), /连接成功后/);
  assert.match(aboutSourceLabel('command'), /启动命令/);
  assert.equal(aboutSourceLabel(undefined), '');
});

// The re-read rule. dsh-mcp-client publishes the `mcp:<server>` section only
// while the server is connected, so a first look at a stopped server finds
// nothing — and if the host treated that as final, the row would show the launch
// command forever instead of switching to the server's own words on connect.
// The liveness bookmark is what keeps it both correct and bounded.
test('the instructions are re-read when a server connects, not on every payload', () => {
  assert.equal(needsInstructionsRead({ read: false, live: false, name: 'x' }), true,
    'the first read always happens');
  assert.equal(needsInstructionsRead({ read: true, rememberedGen: 'down', live: false, name: 'x' }), false,
    'a stopped server we already looked at is not re-read on every page load');
  assert.equal(needsInstructionsRead({ read: true, rememberedGen: 'down', live: true, name: 'x' }), true,
    'connecting again must be picked up — the section appears only now');
  assert.equal(needsInstructionsRead({ read: true, rememberedGen: 'live', live: true, name: 'x' }), false,
    'a steady connected server keeps the sentence it already published');
  assert.equal(needsInstructionsRead({ read: true, rememberedGen: 'live', live: false, name: 'x' }), true,
    'disconnecting invalidates the remembered section');
  assert.equal(needsInstructionsRead({ read: true, rememberedGen: undefined, live: false, name: '' }), false,
    'an entry with no usable server name has nothing to look up');
});
