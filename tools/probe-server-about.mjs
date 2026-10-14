// tools/probe-server-about.mjs — the 已注册 row must say what the server DOES.
//
// The user's report (with a screenshot of the row): 「MCP下载好之后后面的应该是
// 解释这个MCP的作用」 — the text after a server's name was `stdio · 已连接 ·
// 工具前缀 mcp__x__`, which explains nothing about the server. This probe renders
// the real Section against a fake React and pins the replacement:
//
//   * the purpose sentence is the FIRST line of the row's text block (above the
//     transport/state facts, not after them);
//   * the technical facts survive as the second, smaller line;
//   * a long sentence is clamped to two lines instead of growing the row;
//   * a server the host could say nothing about renders no empty element;
//   * the tooltip names the evidence the sentence came from.
//
// Self-contained on purpose: the fake-React harness is copied rather than shared
// with render-market-tab.mjs so a change to the market tab cannot mask a
// regression here (that is the failure mode both files exist to catch).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'client', 'client.js');

// --- fake React (per-component hook frames, effects run between passes) -----
const frames = [];
const effects = [];
const frameStore = new Map();
const ordinals = new Map();
const reactStub = {
  createElement: (type, props, ...children) => {
    const p = props ?? {};
    if (typeof type === 'function') return type({ ...p, children });
    return { type, props: p, children };
  },
  useState(initial) {
    const frame = frames[frames.length - 1];
    const i = frame.cursor++;
    if (!(i in frame.hooks)) frame.hooks[i] = typeof initial === 'function' ? initial() : initial;
    const write = (next) => { frame.hooks[i] = typeof next === 'function' ? next(frame.hooks[i]) : next; };
    return [frame.hooks[i], write];
  },
  useEffect(fn) { effects.push(fn); },
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
};
const requireShim = (id) => {
  if (id === 'react') return reactStub;
  throw new Error(`unexpected module request: ${id}`);
};

// --- fixture: one server per evidence source --------------------------------
const LONG_PURPOSE = 'Codegraph is a SQLite knowledge graph of every symbol, edge and file in the workspace, and it answers architecture questions from that index instead of re-reading the tree.';
const SERVERS = [
  {
    name: 'codegraph', serverName: 'codegraph', transport: 'stdio', source: 'claude-code',
    enabled: true, connected: true, status: 'connected',
    about: { text: LONG_PURPOSE, source: 'server', toolCount: 0 },
    aboutLabel: '来自服务器自身的说明（MCP initialize）',
  },
  {
    name: 'tayily-mcp', serverName: 'tayily-mcp', transport: 'stdio', source: 'claude-desktop',
    enabled: true, connected: true, status: 'connected',
    about: { text: '工具：search、fetch、describe 等 4 个', source: 'tools', toolCount: 4 },
    aboutLabel: '根据该服务器已注册的工具推断',
  },
  {
    name: 'cold-server', serverName: 'cold-server', transport: 'stdio', source: 'cursor',
    enabled: false, connected: false, status: 'stopped',
    about: null, aboutLabel: '',
  },
];

let captured = null;
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
globalThis.document = {
  head: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, appendChild() {} }),
  getElementById: () => null,
};
let serverCalls = 0;
globalThis.fetch = async (url, init) => {
  const ok = (value) => ({ ok: true, status: 200, json: async () => value });
  const p = String(url).replace('/api/overall-mcp', '');
  if (p.startsWith('/servers')) {
    serverCalls += 1;
    // The host answers with the resolved purpose line attached to each server.
    return ok({ servers: SERVERS.map((s) => ({ ...s })) });
  }
  void init;
  return ok({});
};

// Red self-test (`OMKT_RED_ABOUT=1`): drop the purpose node from the source. That
// is precisely the regression the user reported — a row that explains transport
// and state but not the server — and it must make this probe exit non-zero.
const RED = process.env.OMKT_RED_ABOUT === '1';
const code = await readFile(bundlePath, 'utf8');
const source = RED
  ? code.replace(/key: "about", style: styles\.about/g, 'key: "about-red", style: styles.about')
  : code;
if (RED) assert.notEqual(source, code, 'red mutation applied (the purpose node exists to remove)');
// eslint-disable-next-line no-new-func
new Function('window', 'require', source)(globalThis.window, requireShim);
const mod = captured.factory(requireShim);
assert.equal(typeof mod.Section, 'function', 'client exports Section');

function renderNode(node) {
  if (node == null || node === false || node === true) return null;
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (typeof node.type === 'function') {
    const name = node.type.name || 'anonymous';
    const ordinal = ordinals.get(name) ?? 0;
    ordinals.set(name, ordinal + 1);
    const key = `${name}#${ordinal}`;
    let frame = frameStore.get(key);
    if (!frame) { frame = { hooks: [], cursor: 0 }; frameStore.set(key, frame); }
    frame.cursor = 0;
    frames.push(frame);
    let out;
    try { out = node.type(node.props ?? {}); } finally { frames.pop(); }
    return renderNode(out);
  }
  const props = { ...(node.props ?? {}) };
  if ('children' in props) props.children = renderNode(props.children);
  return { type: node.type, props, children: (node.children ?? []).map(renderNode) };
}
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });
async function render() {
  for (let pass = 0; pass < 6; pass += 1) {
    ordinals.clear();
    renderNode({ type: mod.Section, props: {} });
    for (const fn of effects.splice(0, effects.length)) fn();
    await settle();
    await settle();
  }
  ordinals.clear();
  return renderNode({ type: mod.Section, props: {} });
}

function walk(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if ('type' in node) {
    out.push(node);
    walk(node.children, out);
    walk(node.props?.children, out);
  }
  return out;
}
function textOf(node) {
  const parts = [];
  const collect = (n) => {
    if (n == null || n === false || n === true) return;
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(collect); return; }
    if (typeof n === 'object' && 'type' in n) { collect(n.children); collect(n.props?.children); }
  };
  collect(node);
  return parts.join('');
}

/** Only the text directly inside this element, ignoring nested elements. */
function directText(node) {
  const parts = [];
  const collect = (c) => {
    if (typeof c === 'string' || typeof c === 'number') parts.push(String(c));
    else if (Array.isArray(c)) c.forEach(collect);
  };
  collect(node.children ?? []);
  collect(node.props?.children);
  return parts.join('');
}

const nodes = walk(await render());
assert.ok(serverCalls > 0, 'the registry tab fetched /servers');
if (process.env.DEBUG_ABOUT) {
  // Kept in the probe: when the row shape changes, the failure is almost always
  // "the client rendered something I did not expect", and this is the fastest
  // way to see what it actually rendered.
  console.log('[debug] /servers calls:', serverCalls, '| nodes:', nodes.length);
  console.log('[debug] text:', textOf(nodes).slice(0, 600));
}

// --- locate each row by the client's own node keys -------------------------
// ServerRow names its nodes `name`, `about` and `meta`. Keys are the client's
// declared contract for its render output, so a style refactor cannot silently
// turn this probe into a no-op that passes while the row regressed. The name is
// restricted to a span because the page's search input also carries key `name`.
const keyed = (key) => nodes.filter((n) => n.props?.key === key);
const nameIdx = keyed('name').filter((n) => n.type === 'span').map((n) => nodes.indexOf(n));
assert.equal(nameIdx.length, SERVERS.length, `one name span per registered server (${nameIdx.length})`);

const rows = SERVERS.map((server, i) => {
  const start = nameIdx[i];
  const end = nameIdx[i + 1] ?? nodes.length;
  const slice = nodes.slice(start, end);
  const purposeIndex = slice.findIndex((n) => n.props?.key === 'about');
  const metaIndex = slice.findIndex((n) => n.props?.key === 'meta');
  assert.equal(server.name, directText(slice[0]),
    `row ${i} belongs to ${server.name} (found ${JSON.stringify(directText(slice[0]))})`);
  return {
    name: server.name,
    slice,
    purposeIndex,
    metaIndex,
    purpose: purposeIndex >= 0 ? slice[purposeIndex] : null,
    meta: metaIndex >= 0 ? slice[metaIndex] : null,
  };
});
const rowFor = new Map(rows.map((row) => [row.name, row]));

// 1. the server-derived sentence: above the facts, clamped, with a tooltip
{
  const { purpose, meta, purposeIndex, metaIndex } = rowFor.get('codegraph');
  assert.ok(purpose, 'the purpose line is rendered');
  assert.equal(textOf(purpose), LONG_PURPOSE, 'the sentence is shown as the server wrote it');
  assert.equal(purpose.props.style.overflow, 'hidden', 'the purpose line clips instead of growing the row');
  assert.equal(purpose.props.title, '来自服务器自身的说明（MCP initialize）',
    'the tooltip names the evidence behind the sentence');

  assert.ok(meta, 'the transport/prefix facts are still rendered');
  assert.ok(purposeIndex < metaIndex,
    'the purpose comes BEFORE the transport facts — that is the whole request');
}

// 2. a tools-derived line reports the tool count in the facts line
{
  const { purpose, meta } = rowFor.get('tayily-mcp');
  assert.equal(textOf(purpose), '工具：search、fetch、describe 等 4 个');
  assert.equal(purpose.props.title, '根据该服务器已注册的工具推断');
  assert.match(textOf(meta), /4 个工具/, 'the facts line carries the tool count too');
}

// 3. a server with nothing to say renders no empty purpose line
{
  const { purpose, meta } = rowFor.get('cold-server');
  assert.equal(purpose, null, 'no about evidence ⇒ no empty element');
  assert.match(textOf(meta), /stdio/);
  assert.match(textOf(meta), /已停用/);
}

// 4. exactly one purpose line per row that has one — the old facts-only line
//    must not have survived somewhere else in the row
{
  for (const row of rows) {
    const dupes = row.slice.filter((n) => n.props?.style?.WebkitLineClamp === 2);
    assert.ok(dupes.length <= 1, `${row.name}: at most one purpose line`);
  }
}

console.log(`ok — ${SERVERS.length} registered rows: purpose line above the facts, clamped, sourced`);
