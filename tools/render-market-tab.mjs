// tools/render-market-tab.mjs — render the market tab against a fake React.
//
// MarketCard/MarketDetail have their own render tests, but the tab chrome
// around them (stat line, filters, the masonry wrapper, the favourite wiring
// between Section and both cards) exists only in Section, and Section is what
// throws when a state name or a prop is wrong. This renders the real Section
// with stubbed hooks + fetch and walks the tree it produces.
//
// The stub runs effects and honours setState, so the tab is driven the way a
// user drives it: render, click 市场, let the fetch settle, render again. An
// earlier version seeded state by hook INDEX, which silently broke every time
// Section gained a useState — the market payload landed in the wrong slot and
// the assertions passed against a half-loaded tab. Interactions do not rot.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'client', 'client.js');

// --- fake React ------------------------------------------------------------
// Function components are invoked here, each with its OWN hook frame — a
// shared frame would let a child component's useState steal a slot from the
// parent that renders it, which is exactly the class of bug this file exists
// to catch. Frames are keyed per component INSTANCE (name + ordinal within a
// render) and kept across renders, so a setState in one pass is still visible
// in the next — otherwise nothing an effect loads would ever stick.
const frames = [];
const effects = [];
const frameStore = new Map();
const ordinals = new Map();
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
    if (!(i in frame.hooks)) frame.hooks[i] = typeof initial === 'function' ? initial() : initial;
    const write = (next) => {
      frame.hooks[i] = typeof next === 'function' ? next(frame.hooks[i]) : next;
    };
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

const MARKET = {
  items: [
    {
      id: 'official:ac.snag/snag', title: 'snag', source: 'official-registry', author: 'ac.snag',
      description: 'Evidence capture for agents.', transport: 'stdio',
      install: { transport: 'stdio', command: 'npx', args: ['-y', '@snag/mcp'] },
      repository: 'https://github.com/snag/mcp', version: '1.0.0', group: '开发工具',
      installable: true, installed: true, favorite: true,
    },
    {
      id: 'awesome:Gatyh/3dtexel-mcp', title: '3dtexel-mcp', source: 'awesome-list', author: 'Gatyh',
      description: '3D texture search over MCP.', transport: 'stdio',
      install: { transport: 'stdio', command: 'npx', args: ['-y', '3dtexel-mcp'] },
      repository: 'https://github.com/Gatyh/3dtexel-mcp', version: null, group: '搜索与知识',
      installable: true, installed: false, favorite: false,
    },
    {
      id: 'remote:example.com/mcp', title: 'example-mcp', source: 'awesome-remote', author: 'example.com',
      description: 'A hosted endpoint.', transport: 'unknown', install: null,
      installable: false, installed: false, favorite: false,
    },
  ],
  counts: { 'official-registry': 1, 'awesome-list': 1, 'awesome-remote': 1 },
  total: 3, cached: true, fetchedAt: Date.now(),
};

let captured = null;
const styleElements = [];
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
globalThis.document = {
  head: { appendChild: (el) => styleElements.push(el) },
  createElement: () => ({ setAttribute() {}, appendChild() {} }),
  getElementById: () => null,
};
globalThis.fetch = async (url) => {
  const ok = (value) => ({ ok: true, status: 200, json: async () => value });
  const path = String(url).replace('/api/overall-mcp', '');
  if (path.startsWith('/catalog')) return ok(MARKET);
  if (path.startsWith('/servers')) return ok({ servers: [{ name: 'codegraph', source: 'claude-code', enabled: true }] });
  if (path.startsWith('/repo-stats')) return ok({ stats: {} });
  if (path.startsWith('/repo-media')) return ok({ media: {} });
  return ok({});
};

const code = await readFile(bundlePath, 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', 'require', code)(globalThis.window, requireShim);
const mod = captured.factory(requireShim);
assert.ok(mod.__test?.MarketCard, 'client exports __test.MarketCard');
assert.equal(typeof mod.Section, 'function', 'client exports Section');

/** Render a descriptor tree, invoking function components bottom-up. */
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

/** Let the promise chains the effects started settle. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Render Section, run the effects it registered, and keep rendering until the
 * tree stops changing — the same loop a real commit + async state update does.
 */
/** A single pass with no effects run: what the first paint looks like. */
function renderOnce() {
  ordinals.clear();
  return renderNode({ type: mod.Section, props: {} });
}

/**
 * Render Section, run the effects it registered, and keep rendering until the
 * tree stops changing — the same loop a real commit + async state update does.
 */
async function render() {
  for (let pass = 0; pass < 6; pass += 1) {
    ordinals.clear();
    renderNode({ type: mod.Section, props: {} });
    const pending = effects.splice(0, effects.length);
    for (const fn of pending) {
      try { fn(); } catch (err) { throw new Error(`effect threw: ${err.message}`); }
    }
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
function findByKey(nodes, key) { return nodes.filter((n) => n.props?.key === key); }
function buttonByText(nodes, label) {
  return nodes.find((n) => n.type === 'button' && textOf(n) === label);
}

// --- 1. first paint: the host has not answered yet -------------------------
const nodes = walk(renderOnce());
const tabs = findByKey(nodes, 'tabs');
assert.equal(tabs.length, 1, 'tab bar present');
let tabButtons = walk(tabs[0]).filter((n) => n.type === 'button');
assert.deepEqual(tabButtons.map(textOf), ['已注册', 'MCP 市场'], 'tab labels before the host answers');

// --- 2. loaded: the registry tab counts its servers ------------------------
let loadedNodes = walk(await render());
tabButtons = walk(findByKey(loadedNodes, 'tabs')[0]).filter((n) => n.type === 'button');
assert.deepEqual(tabButtons.map(textOf), ['已注册 (1)', 'MCP 市场'], 'tab labels carry live counts');

// --- 3. clicking into the market loads the listings ------------------------
tabButtons = walk(findByKey(loadedNodes, 'tabs')[0]).filter((n) => n.type === 'button');

const openMarket = buttonByText(tabButtons, 'MCP 市场');
assert.ok(openMarket, 'the market tab is clickable');
openMarket.props.onClick();
loadedNodes = walk(await render());
tabButtons = walk(findByKey(loadedNodes, 'tabs')[0]).filter((n) => n.type === 'button');
assert.deepEqual(tabButtons.map(textOf), ['已注册 (1)', 'MCP 市场 (3)'], 'market tab counts the listings');

// v4 splits the market chrome into three rows with one job each: the search
// pill, then chips + compact filters, then a meta line of bold numbers. The
// counts that are facts about the catalogue rather than controls moved to a
// quiet line of their own, so assert each row where it now lives.
function directChildren(node) {
  const out = [];
  const push = (c) => {
    if (Array.isArray(c)) c.forEach(push);
    else if (c != null && c !== false && c !== true) out.push(c);
  };
  (node.children ?? []).forEach(push);
  if (node.props?.children) push(node.props.children);
  return out;
}
const marketPage = findByKey(loadedNodes, 'mkt')[0];
assert.ok(marketPage, 'market page container present');
const marketOwn = directChildren(marketPage);

const searchRow = marketOwn.filter((n) => n.props?.key === 'search');
assert.equal(searchRow.length, 1, 'search row present');
const searchText = textOf(searchRow[0]);
assert.ok(searchText.includes('🔍'), `search row carries its icon — got: ${searchText}`);
assert.ok(searchText.includes('搜索'), 'search row keeps an explicit trigger');

const metaRow = marketOwn.filter((n) => n.props?.key === 'meta');
assert.equal(metaRow.length, 1, 'meta line present');
const metaText = textOf(metaRow[0]);
assert.ok(metaText.includes('3 个可用 MCP'), `meta line names the total — got: ${metaText}`);
assert.ok(metaText.includes('第 1 / 1 页'), 'meta line names the page');
assert.ok(metaText.includes('每页 20 条'), 'meta line names the page size');

// The controls live inside the chip row's line, and the chips scroll there.
const filters = marketOwn.filter((n) => n.props?.key === 'filters');
assert.equal(filters.length, 1, 'filter row present');
const chipRow = findByKey(walk(filters[0]), 'groups');
assert.equal(chipRow.length, 1, 'chip row sits inside the filter line');
assert.ok(walk(filters[0]).some((n) => n.type === 'select'), 'filter line carries the source/sort selects');
assert.ok(walk(filters[0]).some((n) => n.type === 'button' && textOf(n) === '刷新'), 'filter line carries refresh');

const sourceLine = marketOwn.filter((n) => n.props?.key === 'srcline');
assert.equal(sourceLine.length, 1, 'per-source line present');
const sourceText = textOf(sourceLine[0]);
assert.ok(sourceText.includes('官方 1'), 'per-source line names the sources');
assert.ok(sourceText.includes('其中 1 个已安装'), 'per-source line names the installed count');

const search = loadedNodes.find((n) => n.type === 'input'
  && String(n.props?.placeholder ?? '').includes('搜索'));
assert.ok(search, 'market search input present');

// --- 4. the masonry wrapper holds one rendered card per entry --------------
const grids = findByKey(loadedNodes, 'grid');
assert.equal(grids.length, 1, 'card grid present');
// The column count is a media query in the injected sheet (inline styles
// cannot express one), so the class is the hook that makes it bite. Without
// it the grid falls back to two columns on a wide pane.
assert.equal(grids[0].props?.className, 'omkt-grid', 'grid carries the breakpoint class');
const cards = walk(grids[0]).filter((n) => n.type === 'article');
assert.equal(cards.length, 3, `one card per listing (got ${cards.length})`);
const ctaButtonsAll = [];
const ctaTexts = [];
for (const card of cards) {
  const inner = walk(card);
  const cta = findByKey(inner, 'cta');
  assert.equal(cta.length, 1, 'card has a CTA column');
  const ctaButtons = walk(cta[0]).filter((n) => n.type === 'button');
  // Every card offers 详情; only installable ones offer a button, and a
  // manual-only entry must say so instead of showing a dead 安装.
  assert.ok(ctaButtons.map(textOf).includes('详情'), 'CTA offers detail');
  ctaButtonsAll.push(...ctaButtons.map(textOf));
  ctaTexts.push(textOf(cta[0]));
  // The favourite control must sit outside the clickable body, or a star
  // would also open the detail panel.
  const body = findByKey(inner, 'body')[0];
  assert.ok(body, 'card has a body surface');
  const fav = findByKey(inner, 'fav')[0];
  assert.ok(fav, 'card has a favourite control');
  assert.equal(containsNode(body, fav), false, 'favourite control is outside the body surface');
}
assert.deepEqual(ctaButtonsAll.sort(), ['安装', '详情', '详情', '详情'], 'CTA set across cards: one install, a detail on each');
assert.ok(ctaTexts.some((t) => t.includes('需手动配置')), 'manual-only entry says so in place of a button');
assert.ok(ctaTexts.some((t) => t.includes('已安装')), 'installed entry is marked instead of installable');
function containsNode(root, target) {
  let found = false;
  const visit = (n) => {
    if (found || n === target) { found = true; return; }
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (n && typeof n === 'object') { visit(n.children); visit(n.props?.children); }
  };
  visit(root.children);
  visit(root.props?.children);
  return found;
}

// --- 5. the registry tab still renders (no regression) ---------------------
const backToRegistry = buttonByText(tabButtons, '已注册 (1)');
assert.ok(backToRegistry, 'the registry tab is clickable');
backToRegistry.props.onClick();
const registryNodes = walk(await render());
assert.ok(registryNodes.some((n) => n.type === 'button' && textOf(n) === '重新扫描宿主机'),
  'registry tab keeps its scan button');

// --- 6. the page head, ported from the v4 prototype ------------------------
// Identity (brand mark + title + version) and the sub-line exist on BOTH tabs,
// and the primary action follows the tab — two primary buttons is none.
{
  // We are on the registry tab here (section 5 clicked back to it).
  const registry = walk(await render());
  const regHead = findByKey(registry, 'head')[0];
  assert.ok(regHead, 'page head missing');
  const regText = textOf(regHead);
  assert.ok(regText.includes('总体 MCP'), `head names the page — got: ${regText}`);
  assert.match(regText, /v\d+\.\d+\.\d+/, 'version chip missing from the head');
  assert.ok(regText.includes('宿主机扫描 · 市场发现 · 一键接入'), 'sub-line missing');
  assert.ok(regText.includes('申请收录插件'), 'contribution link missing');
  assert.ok(walk(regHead).some((n) => n.type === 'svg'), 'brand mark is not drawn');
  // `findByKey` walks the flattened tree, so the keyed button itself is a hit.
  assert.equal(textOf(findByKey(registry, 'hd-primary')[0]), '重新扫描宿主机',
    'registry tab primary action is wrong');
  assert.equal(textOf(findByKey(registry, 'hd-secondary')[0]), '打开 MCP 市场',
    'registry tab loses the market door');
  assert.equal(textOf(findByKey(registry, 'hd-log')[0]), '⤓ 导出日志', 'export button missing');

  // No return-to-top before there is anything to scroll back from.
  assert.equal(findByKey(registry, 'top').length, 0, 'return-to-top shown on an unscrolled page');

  // The market tab's own primary is the catalog refresh, not a rescan.
  const regTabs = walk(findByKey(registry, 'tabs')[0]).filter((n) => n.type === 'button');
  regTabs.find((n) => textOf(n).startsWith('MCP 市场')).props.onClick();
  const market = walk(await render());
  assert.equal(textOf(findByKey(market, 'hd-primary')[0]), '更新插件市场',
    'market tab primary action is wrong');
  assert.equal(textOf(findByKey(market, 'hd-secondary')[0]), '重新扫描宿主机',
    'market tab loses the rescan door');
  console.log('page head renders: brand mark, title + version, sub-line, tab-aware primary ✓');
}

// --- 7. the stylesheet was injected once -----------------------------------
assert.ok(styleElements.length >= 1, 'ensureStyles injects the hover/animation sheet');

console.log('market tab renders: tabs, stat line, search, 3 cards, CTA + footer split ✓');
console.log('registry tab renders: scan button present ✓');
