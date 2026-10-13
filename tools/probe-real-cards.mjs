// tools/_real-cards.mjs — render the market card + detail panel for every
// source using the LIVE host payload, to catch fields that only appear in
// real upstream records (raw, installsLabel, enriched stats, …).
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.argv[2];
const token = process.argv[3];
const root = `${base}/api/overall-mcp`;

const boot = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (boot.headers.getSetCookie?.() ?? [])[0]?.split(';')[0];
if (!cookie) throw new Error(`no session cookie (status ${boot.status})`);

const res = await fetch(root + '/catalog', {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ limit: 200 }),
});
const payload = await res.json();
await writeFile('tools/_live-items.json', JSON.stringify(payload.items, null, 1), 'utf8');
console.log('items', payload.items.length, 'counts', JSON.stringify(payload.counts));

// --- render ---------------------------------------------------------------
const frames = [];
let SEED = null;
let rootFrame = null;
const reactStub = {
  createElement: (type, props, ...children) => {
    const p = props ?? {};
    // Expand function components: a stub that only records the element type
    // hides everything the component renders (MarketCard's preview strip).
    if (typeof type === 'function') return type({ ...p, children });
    return { type, props: p, children };
  },
  useState(initial) {
    const frame = frames[frames.length - 1];
    const i = frame.cursor++;
    if (frame.seed && i in frame.seed) return [frame.seed[i], (n) => { frame.hooks[i] = typeof n === 'function' ? n(frame.seed[i]) : n; }];
    if (!(i in frame.hooks)) frame.hooks[i] = typeof initial === 'function' ? initial() : initial;
    return [frame.hooks[i], (n) => { frame.hooks[i] = typeof n === 'function' ? n(frame.hooks[i]) : n; }];
  },
  useEffect() {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
};
const requireShim = (id) => (id === 'react' ? reactStub : null);
function renderNode(node) {
  if (node == null || node === false || node === true) return null;
  if (Array.isArray(node)) return node.map(renderNode);
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (typeof node.type === 'function') {
    const isRoot = rootFrame === null;
    const frame = { hooks: [], cursor: 0, seed: isRoot ? SEED : null };
    if (isRoot) rootFrame = frame;
    frames.push(frame);
    let out;
    try { out = node.type(node.props ?? {}); } finally { frames.pop(); }
    return renderNode(out);
  }
  const props = { ...(node.props ?? {}) };
  if ('children' in props) props.children = renderNode(props.children);
  return { type: node.type, props, children: (node.children ?? []).map(renderNode) };
}
let captured = null;
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
globalThis.document = { head: { appendChild() {} }, createElement: () => ({}), getElementById: () => null };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ stats: {} }) });
const code = await readFile(path.join(process.cwd(), 'client', 'client.js'), 'utf8');
new Function('window', 'require', code)(globalThis.window, requireShim);
const { __test } = captured.factory(requireShim);

let failed = 0;
for (const item of payload.items) {
  try {
    const card = renderNode({ type: __test.MarketCard, props: { item, stats: {}, busy: false, onInstall: () => {}, onOpen: () => {}, onToggleFavorite: () => {} } });
    if (!card || card.type !== 'article') throw new Error('card did not render an article');
    // The detail panel needs the enriched stats object for some rows.
    rootFrame = null;
    SEED = { 0: item, 1: 'installing', 2: null };
    const detail = renderNode({ type: __test.MarketDetail, props: { item, stats: {}, busy: false, onInstall: () => {}, onClose: () => {}, onToggleFavorite: () => {} } });
    if (!detail) throw new Error('detail panel returned nothing');
  } catch (err) {
    failed++;
    console.log('FAIL', item.source, item.id ?? item.title, '—', err.message);
  }
}
console.log(failed === 0 ? `all ${payload.items.length} real items render as cards + detail ✓` : `${failed} failures`);
