// tools/render-detail.mjs — render the detail panel against a fake React tree.
//
// The panel once shipped with every fact row showing its label and no value:
// DetailRow destructured `{ children }` while being called with a positional
// second argument. Syntax checks, link coverage and the registration smoke all
// passed, because none of them render. This walks the real element tree the
// component produces and asserts on what a user would actually see.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'client', 'client.js');

const reactStub = {
  createElement: (type, props, ...children) => {
    const p = props ?? {};
    // Expand function components: a stub that only records the element type
    // hides everything the component renders (MarketCard's preview strip).
    if (typeof type === 'function') return type({ ...p, children });
    return { type, props: p, children };
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
};
const requireShim = (id) => {
  if (id === 'react') return reactStub;
  throw new Error(`unexpected module request: ${id}`);
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
const code = await readFile(bundlePath, 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', 'require', code)(globalThis.window, requireShim);
const { __test } = captured.factory(requireShim);
assert.ok(__test?.MarketDetail, 'client exports __test.MarketDetail');

/** Flatten an element tree into a list of nodes. */
function walk(node, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (node && typeof node === 'object' && 'type' in node) {
    out.push(node);
    walk(node.children, out);
    walk(node.props?.children, out);
  }
  return out;
}

/** All text contained in a subtree. */
function textOf(node) {
  const parts = [];
  const collect = (n) => {
    if (n == null || n === false) return;
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(collect); return; }
    if (typeof n === 'object' && 'type' in n) { collect(n.children); collect(n.props?.children); }
  };
  collect(node);
  return parts.join('');
}

// One representative item per source, matching what the host actually sends
// (post-annotateItem: raw stripped, qualifiedName promoted, installable set).
const samples = [
  {
    name: 'official-registry (stdio npm package, has repo)',
    item: {
      id: 'official:ac.snag/snag', title: 'snag', source: 'official-registry', author: 'ac.snag',
      description: 'Evidence capture for browser bugs.', version: '1.0.0', transport: 'stdio',
      install: { transport: 'stdio', command: 'npx', args: ['-y', '@snag/mcp'] },
      repository: 'https://github.com/snag/mcp', homepage: 'https://snag.ac',
      tags: ['npm'], official: true, installable: true, installed: false,
    },
    expect: { links: ['官网', 'GitHub 仓库', 'GitHub 镜像'], cmd: 'npx -y @snag/mcp' },
  },
  {
    name: 'awesome-list (discovery-only, repo is all it has)',
    item: {
      id: 'awesome:gatyh/3dtexel-mcp', title: '3dtexel-mcp', source: 'awesome-list', author: 'Gatyh',
      description: 'Official 3D Texel server.', transport: 'unknown', install: null,
      repository: 'https://github.com/Gatyh/3dtexel-mcp', tags: ['Art & Culture', 'TypeScript'],
      installable: false, installed: false,
    },
    expect: { links: ['GitHub 仓库', 'GitHub 镜像'], cmd: null },
  },
  {
    name: 'awesome-remote (hosted endpoint, website and endpoint differ)',
    item: {
      id: 'remote:https://mcp.neon.com/mcp', title: 'Neon', source: 'awesome-remote', author: 'mcp.neon.com',
      description: 'Serverless Postgres.', transport: 'streamable-http',
      install: { transport: 'streamable-http', url: 'https://mcp.neon.com/mcp' },
      homepage: 'https://neon.com', tags: ['Databases', '免登录'],
      installable: true, installed: false,
    },
    expect: { links: ['官网', 'MCP 端点'], cmd: 'https://mcp.neon.com/mcp' },
  },
  {
    name: 'smithery (repository points at its own listing)',
    item: {
      id: 'smithery:brave', title: 'Brave Search', source: 'smithery', author: 'brave',
      description: 'Web search.', transport: 'stdio',
      install: { transport: 'stdio', command: 'npx', args: ['-y', '@smithery/cli', 'run', 'brave'] },
      repository: 'https://brave.com/search/api/', installs: 87579, installsLabel: '次启动',
      verified: true, qualifiedName: 'brave', installable: true, installed: false,
    },
    expect: { links: ['主页', 'Smithery 页面'], cmd: 'npx -y @smithery/cli run brave' },
  },
  {
    // The GitHub search source: no installer, no `/repos` enrichment entry, but
    // the row itself carries the repository facts — they must still be stated.
    name: 'github search row (facts live on the row, no enrichment)',
    item: {
      id: 'github:github/github-mcp-server', title: 'github-mcp-server', source: 'github-mcp', author: 'github',
      description: "GitHub's official MCP Server", transport: 'unknown', install: null,
      repository: 'https://github.com/github/github-mcp-server', tags: ['mcp', 'github'],
      stars: 33637, forks: 2100, openIssues: 143, language: 'Go', updatedAt: '2026-10-01T00:00:00Z',
      installable: false, installed: false,
    },
    expect: { links: ['GitHub 仓库'], text: ['Go', '33.6k', '2.1k'] },
  },
];

for (const { name, item, expect } of samples) {
  const tree = __test.MarketDetail({ item, stats: {}, busy: false, onClose: () => {}, onInstall: () => {} });
  const nodes = walk(tree);
  const all = textOf(tree);

  // 1. Every fact row carries a non-empty value. This is the exact assertion
  //    the original bug failed: labels rendered, values did not.
  const rows = nodes.filter((n) => n.type === __test.DetailRow || (typeof n.type === 'function' && n.type.name === 'DetailRow'));
  // DetailRow is called as a plain function, so its OUTPUT appears inline; find
  // rows by their two-span shape instead: key "k" (label) plus key "v" (value).
  const rowPairs = nodes.filter((n) => n.props?.key === 'v');
  assert.ok(rowPairs.length >= 7, `${name}: expected the fact table, found ${rowPairs.length} value cells`);
  for (const cell of rowPairs) {
    assert.ok(textOf(cell).trim().length > 0, `${name}: a fact value rendered empty`);
  }

  // 2. The description is present in full.
  assert.ok(all.includes(item.description), `${name}: description missing`);

  // 3. Expected link chips, by label.
  const anchors = nodes.filter((n) => n.type === 'a');
  const labels = anchors.map((a) => textOf(a));
  for (const want of expect.links) {
    assert.ok(labels.includes(want), `${name}: link chip "${want}" missing (has: ${labels.join(', ')})`);
  }

  // 4. The exact install command, or its documented absence.
  if (expect.cmd) {
    assert.ok(all.includes(expect.cmd), `${name}: install command "${expect.cmd}" missing`);
  }

  // 4b. Facts the row carries must be stated even with no enrichment entry
  //     (the GitHub search source is the only one that ships them).
  for (const want of expect.text ?? []) {
    assert.ok(all.includes(want), `${name}: "${want}" missing from the panel (got ${all.slice(0, 240)})`);
  }

  // 5. No anchor ever points at the raw.githubusercontent mirror chain — links
  //    are for humans, not for the fetch fallback.
  for (const a of anchors) {
    assert.ok(!String(a.props.href).includes('jsdelivr.net'), `${name}: CDN mirror leaked into a UI link`);
  }

  console.log(`ok  ${name} — ${rowPairs.length} facts, links: ${labels.join(' / ')}`);
}

// --- the copy button is wiring, not decoration -----------------------------
// A copy affordance that copies nothing is worse than no button: it tells the
// user the command is on their clipboard. The label alone would pass a render
// test either way, so drive the real button against a stubbed clipboard.
{
  const sample = samples.find((s) => s.expect.cmd);
  const { item } = sample;
  const expected = sample.expect.cmd;
  const wrote = [];
  const before = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let stubbed = true;
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { clipboard: { writeText: async (text) => { wrote.push(text); } } },
    });
  } catch {
    // A host that will not let `navigator` be replaced still runs the button;
    // it just takes the selection fallback, which cannot be observed here.
    stubbed = false;
  }
  try {
    const tree = __test.MarketDetail({ item, stats: {}, busy: false, onClose: () => {}, onInstall: () => {} });
    const nodes = walk(tree);
    assert.ok(nodes.some((n) => textOf(n) === '将执行的命令'),
      'the command block still states what it is');
    const buttons = nodes.filter((n) => n.type === 'button' && textOf(n) === '复制');
    assert.equal(buttons.length, 1, 'the command block offers exactly one copy button');
    assert.equal(buttons[0].props.title, '复制这条命令', 'the copy button explains itself');
    await buttons[0].props.onClick();
    if (stubbed) {
      assert.deepEqual(wrote, [expected],
        `the copy button must hand over the command (got ${JSON.stringify(wrote)})`);
    }
  } finally {
    if (before) Object.defineProperty(globalThis, 'navigator', before);
    else delete globalThis.navigator;
  }
  console.log(`ok  copy button hands the command over${stubbed ? '' : ' (clipboard not stubbable on this host)'}`);
}

console.log('\ndetail panel renders: facts filled, links present, commands shown');
