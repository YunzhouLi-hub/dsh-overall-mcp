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
      // No upstream installs figure (the official registry publishes none) but
      // installed from this panel five thousand times ⇒ it must outrank the
      // entry whose *source* reports 1200.
      official: true, group: '开发工具', groupSource: 'upstream',
      localInstalls: 5000, localInstallLastAt: '2026-10-14T08:00:00.000Z',
    },
    {
      id: 'awesome:Gatyh/3dtexel-mcp', title: '3dtexel-mcp', source: 'awesome-list', author: 'Gatyh',
      description: '3D texture search over MCP.', transport: 'stdio',
      install: { transport: 'stdio', command: 'npx', args: ['-y', '3dtexel-mcp'] },
      repository: 'https://github.com/Gatyh/3dtexel-mcp', version: null, group: '搜索与知识',
      installable: true, installed: false, favorite: false,
      installs: 1200, installsLabel: '次启动',
    },
    {
      id: 'remote:example.com/mcp', title: 'example-mcp', source: 'awesome-remote', author: 'example.com',
      description: 'A hosted endpoint.', transport: 'unknown', install: null,
      installable: false, installed: false, favorite: false,
      installs: 90000, installsLabel: '次启动',
    },
  ],
  counts: { 'official-registry': 1, 'awesome-list': 1, 'awesome-remote': 1, 'github-mcp': 2 },
  total: 3, cached: true, fetchedAt: Date.now(),
  // Two of the sources answered 304 on the last walk, so the freshness line has
  // something honest to say beyond the timestamp.
  notModified: 2,
  sources: {
    'official-registry': { at: new Date().toISOString(), cached: true, stale: false, notModified: 1, items: 1 },
    'awesome-list': { at: new Date().toISOString(), cached: true, stale: false, notModified: 1, items: 1 },
    'awesome-remote': { at: new Date().toISOString(), cached: false, stale: false, notModified: 0, items: 1 },
    // The GitHub census contributed rows, and Docker answered nothing: a rate
    // limit has to be visible as a reason, not as a bare zero.
    // GitHub also carries a coverage note here, so the panel's "部分" marker and
    // the reason behind it — how big the census is, how old, and how much of it
    // this listing took — are all exercised by this probe.
    'github-mcp': {
      at: new Date().toISOString(), cached: false, stale: false, notModified: 0, items: 2,
      note: '本地索引 1758 行・3 小时前；本次列出 2 条',
      index: { rows: 1758, matched: 2, at: new Date().toISOString(), ageMs: 3 * 3600_000, stale: false, complete: true, partial: null },
    },
    'docker-catalog': { error: 'HTTP 403' },
  },
};

// The custom catalogue sources the host reports. One is configured, and it is
// deliberately NOT part of the listing below: a source that is pointed at but
// did not contribute rows must still appear in the manager, with its own zero,
// instead of looking like it was never added.
const CUSTOM_SOURCE = {
  id: 'custom:raw-githubusercontent-com-acme-mcp-registry-main-registry-json',
  label: 'acme/mcp-registry',
  url: 'https://raw.githubusercontent.com/acme/mcp-registry/main/registry.json',
  // The host derives this from the address (a GitHub-hosted list can take
  // submissions through an issue); a source hosted anywhere else reports null.
  submission: {
    repo: 'acme/mcp-registry',
    url: 'https://github.com/acme/mcp-registry/issues/new?title=%5BMCP%20%E6%94%B6%E5%BD%95%5D&body=%23%23%23%20%E5%90%8D%E7%A7%B0%0A%0A_No%20response_',
  },
};
// The stub host keeps its own copy of the configured sources and answers the
// page from it: the effect that lists them re-runs on every pass here (the
// shim has no dependency arrays), so a GET that ignored the page's own removal
// would put the row back and hide the empty state the page really shows.
let liveSources = [CUSTOM_SOURCE];

// What the host answers when the entry was written and nothing mounted: its own
// error, the explanation the user's model produced, and the note about the
// install counter. All three are rendered together (the panel used to answer
// 「已安装并连接」 for exactly this reply).
const INSTALL_FAILURE = {
  installed: '3dtexel-mcp',
  connect: { ok: false, error: 'spawn npx ENOENT' },
  counted: false,
  note: '3dtexel-mcp 已写入注册表，但挂载没有成功，因此没有计入本市场安装数；修好后可用「更新」或重新启用来重试。',
  diagnosis: {
    text: 'npx 不在 PATH 里。\n先运行 where npx（Windows）确认 Node 已安装并在 PATH 中。',
    route: 'deepseek/deepseek-chat',
  },
};

let captured = null;
const calls = [];
const styleElements = [];
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
globalThis.document = {
  head: { appendChild: (el) => styleElements.push(el) },
  createElement: () => ({ setAttribute() {}, appendChild() {} }),
  getElementById: () => null,
};
globalThis.fetch = async (url, init) => {
  const ok = (value) => ({ ok: true, status: 200, json: async () => value });
  const path = String(url).replace('/api/overall-mcp', '');
  if (path.startsWith('/catalog')) {
    // The source filter travels in the POST body, not the query string.
    let source = '';
    let refresh = false;
    try {
      const body = JSON.parse(init?.body ?? '{}');
      source = body.source ?? '';
      refresh = body.refresh === true;
    } catch { source = ''; }
    calls.push(`POST /catalog${source ? ` source=${source}` : ''}${refresh ? ' refresh' : ''}`);
    return ok(MARKET);
  }
  // The user's own sources: GET lists them, POST adds one, /remove drops one.
  // Adding is answered with the list the host would send back afterwards.
  if (path.startsWith('/sources/remove')) {
    const body = JSON.parse(init?.body ?? '{}');
    calls.push(`POST /sources/remove id=${body.id}`);
    liveSources = liveSources.filter((s) => s.id !== body.id);
    return ok({ removed: CUSTOM_SOURCE, dropped: 1, sources: liveSources, max: 8, error: '' });
  }
  if (path.startsWith('/sources')) {
    if (init?.method === 'POST') {
      const body = JSON.parse(init?.body ?? '{}');
      calls.push(`POST /sources url=${body.url}`);
      return ok({ source: CUSTOM_SOURCE, sources: liveSources, max: 8, error: '' });
    }
    calls.push('GET /sources');
    return ok({ sources: liveSources, max: 8, error: '' });
  }
  // The install that reached the registry and did not mount — the reply the
  // panel must not summarise as success.
  if (path.startsWith('/install')) {
    calls.push('POST /install');
    return ok(INSTALL_FAILURE);
  }
  if (path.startsWith('/servers')) return ok({ servers: [{ name: 'codegraph', source: 'claude-code', enabled: true }] });
  if (path.startsWith('/repo-stats')) return ok({ stats: {} });
  if (path.startsWith('/repo-media')) return ok({ media: {} });
  // The favourites filter asks the host for the whole set, because /catalog
  // only marks the entries the current query returned.
  if (path.startsWith('/favorites')) {
    calls.push('GET /favorites');
    return ok({ favorites: ['official-registry:official:ac.snag/snag', 'smithery:brave-search'], count: 2 });
  }
  // 「检查更新」 answers for both the mounted servers and this plugin: the head
  // only grows an update button when `self.updateAvailable` is true.
  if (path.startsWith('/updates')) {
    calls.push('POST /updates');
    assert.equal(init?.method, 'POST', 'the update check is a POST');
    return ok({
      checked: 1,
      updatable: 0,
      entries: [],
      servers: [],
      self: {
        name: 'dsh-overall-mcp',
        version: '0.1.0',
        latest: '0.2.0',
        install: 'registry',
        profileName: 'desktop',
        checked: true,
        updateAvailable: true,
        reason: 'newer-published',
      },
    });
  }
  if (path.startsWith('/self-update')) {
    calls.push('POST /self-update');
    return ok({ ok: true, updated: true, from: '0.1.0', to: '0.2.0', command: 'dsh plugin --profile desktop add dsh-overall-mcp@0.2.0', restartRequired: true });
  }
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

// The taxonomy and the compact filters share one line, but they are two
// groups: the taxonomy is a *dropdown* (a scrolling chip row hid half the
// categories), and the source/sort/refresh controls are pushed to the far end
// with `margin-left: auto`, so the gap between the two groups is the row's own
// free space instead of a fixed 8px.
const filters = marketOwn.filter((n) => n.props?.key === 'filters');
assert.equal(filters.length, 1, 'filter row present');
const filterRow = walk(filters[0]);
const groupWrap = filterRow.filter((n) => n.props?.key === 'group');
assert.equal(groupWrap.length, 1, 'taxonomy group sits inside the filter line');
const groupSelect = walk(groupWrap[0]).find((n) => n.type === 'select');
assert.ok(groupSelect, 'the taxonomy is a select, not a chip row');
const groupOptions = walk(groupWrap[0]).filter((n) => n.type === 'option');
assert.equal(groupOptions.length, 4, 'the dropdown lists 全部分类 plus one option per group');
assert.equal(textOf(groupOptions[0]), '全部分类 (3)', 'the dropdown total lives on 全部分类 alone');
assert.deepEqual(groupOptions.slice(1).map(textOf), ['开发工具', '搜索与知识', '未分类'],
  'every functional group is reachable from the dropdown, biggest first');
assert.equal(filterRow.filter((n) => n.type === 'button' && /chip|分类/.test(String(n.props?.className))).length,
  0, 'no chip buttons remain in the filter line');
const rightWrap = filterRow.filter((n) => n.props?.key === 'right');
assert.equal(rightWrap.length, 1, 'the compact controls live in their own right-hand group');
assert.equal(rightWrap[0].props.style.marginLeft, 'auto', 'and that group is pushed to the far end');
assert.ok(walk(rightWrap[0]).some((n) => n.type === 'select'), 'filter line carries the source/sort selects');
assert.ok(walk(rightWrap[0]).some((n) => n.type === 'button' && textOf(n) === '刷新'), 'filter line carries refresh');

const sourceLine = marketOwn.filter((n) => n.props?.key === 'srcline');
assert.equal(sourceLine.length, 1, 'per-source line present');
const sourceText = textOf(sourceLine[0]);
assert.ok(sourceText.includes('官方 1'), 'per-source line names the sources');
// A source carrying a coverage note is marked "部分" on this line, and the
// reason itself is spelled out in the manager box below.
assert.ok(sourceText.includes('GitHub 2（部分'), `a partially-read source is marked (got ${sourceText})`);
assert.ok(sourceText.includes('其中 1 个已安装'), 'per-source line names the installed count');

// --- 3d. the user's own catalogue sources -----------------------------------
// A source the user pointed at is a first-class source: it must be reachable
// from the filter, listed with its own numbers in the manager, and removable
// from there. The host reports it as contributing nothing to this listing,
// which is exactly the state that used to be invisible — 「我加了但它好像没生效」.
{
  const srcSelect = loadedNodes.find((n) => n.type === 'select'
    && directChildren(n).some((o) => o.type === 'option' && o.props?.value === 'smithery'));
  const customOption = directChildren(srcSelect).find((o) => o.props?.value === CUSTOM_SOURCE.id);
  assert.ok(customOption, 'the source filter lists a user-added source');
  assert.equal(textOf(customOption), 'acme/mcp-registry', 'and names it by its label, not its machine id');

  const box = findByKey(loadedNodes, 'srcedit');
  assert.equal(box.length, 1, 'the source manager is present');
  assert.ok(textOf(box[0]).includes('自定义 1 / 8'), 'the manager states how many are configured');

  const manage = buttonByText(walk(box[0]), '管理');
  assert.ok(manage, 'the manager has a toggle instead of always taking space');
  manage.props.onClick();
  const opened = walk(await render());
  const openBox = findByKey(opened, 'srcedit')[0];
  const rowText = textOf(openBox);
  assert.ok(rowText.includes('acme/mcp-registry'), 'the row names the source');
  assert.ok(rowText.includes(CUSTOM_SOURCE.url), 'and shows the address it reads');
  assert.ok(/0 条/.test(rowText), `a source that contributed nothing says so instead of vanishing (got ${rowText})`);
  assert.ok(rowText.includes('内置：'), 'the built-in sources are listed beside the user\'s own');
  // The GitHub search source is one of them now, and a source that answered
  // nothing shows the reason — a bare `0` would read as "this catalog is empty".
  assert.ok(rowText.includes('GitHub MCP 2'), `the GitHub source and its row count are on the line (got ${rowText})`);
  // A source that only read part of its list says so beside the count: the
  // number alone would overstate what the market actually holds. For the GitHub
  // census that means the size of the census and its age, not just the slice.
  assert.ok(rowText.includes('本地索引 1758 行'), `the census size is on the line, not only the slice (got ${rowText})`);
  assert.ok(rowText.includes('3 小时前'), 'and how old it is');
  assert.ok(rowText.includes('本次列出 2 条'), 'and how much of it this listing took');
  assert.ok(rowText.includes('Docker MCP Catalog 不可用：HTTP 403'), `a failed source shows why (got ${rowText})`);
  assert.ok(textOf(srcSelect).includes('GitHub MCP'), 'and the new source is offered as a filter');
  assert.ok(rowText.includes('最多 8 个'), 'the cap and the https rule are stated where the URL is typed');

  // Where the list accepts entries, the row offers the uplink — and it opens the
  // prefilled issue, not the repository (the point is that nobody has to know
  // how the list is fed).
  const submitLink = walk(openBox).find((n) => n.type === 'a' && String(n.props?.href ?? '').includes('/issues/new'));
  assert.ok(submitLink, 'a GitHub-hosted list offers a 投稿 link');
  assert.equal(textOf(submitLink), '投稿 ↗', 'and says what it does');
  assert.equal(submitLink.props.href, CUSTOM_SOURCE.submission.url, 'opening the prefilled issue the host derived');
  assert.equal(submitLink.props.target, '_blank', 'outside the panel, in a browser tab');

  // Typing an address and adding it must reach the host, and the page must then
  // re-read the listing: the rows of a source added a moment ago are not in the
  // listing the page is holding.
  const input = walk(openBox).find((n) => n.type === 'input' && String(n.props?.placeholder ?? '').includes('raw.githubusercontent'));
  assert.ok(input, 'the manager has a URL field');
  input.props.onChange({ target: { value: 'https://example.com/other.json' } });
  const withDraft = walk(await render());
  const addBtn = buttonByText(findByKey(withDraft, 'srcedit').length ? walk(findByKey(withDraft, 'srcedit')[0]) : [], '添加');
  assert.ok(addBtn, 'the add button appears beside the field');
  assert.equal(addBtn.props.disabled, false, 'a typed address can be submitted');
  const beforeAdd = calls.length;
  addBtn.props.onClick();
  await render();
  const addCalls = calls.slice(beforeAdd).join(' ');
  assert.ok(addCalls.includes('POST /sources url=https://example.com/other.json'),
    `adding must post the address (got: ${addCalls || 'nothing'})`);
  assert.ok(addCalls.includes('POST /catalog') && addCalls.includes('refresh'),
    `and re-read the listing, or the new source looks empty (got: ${addCalls || 'nothing'})`);

  // Removing must name the source by its id, and the row must go.
  const removed = walk(await render());
  const body = findByKey(removed, 'srcedit')[0];
  const del = buttonByText(walk(body), '移除');
  assert.ok(del, 'each user-added row has a remove control');
  const beforeRemove = calls.length;
  del.props.onClick();
  // Removing ends in two awaits (the host's answer, then the re-read listing),
  // so give the page a tick before reading the tree again.
  await settle();
  const afterRemove = walk(await render());
  assert.ok(calls.slice(beforeRemove).join(' ').includes(`POST /sources/remove id=${CUSTOM_SOURCE.id}`),
    'removing posts the id the host issued, not the label');
  assert.ok(textOf(findByKey(afterRemove, 'srcedit')[0]).includes('还没有自定义源'),
    'and the manager falls back to its empty copy');
  console.log('custom sources: filter option, manager rows, add/remove and the 投稿 uplink ✓');
}

// Conditional requests are invisible unless the page says so: "refreshed" and
// "asked and told nothing changed" look identical without this. The span lives
// inside the meta line, so read the line's own text.
const freshnessLine = marketOwn.filter((n) => n.props?.key === 'meta');
assert.equal(freshnessLine.length, 1, 'freshness meta line present');
const freshnessText = textOf(freshnessLine[0]);
assert.ok(freshnessText.includes('更新于 '), 'freshness line leads with the timestamp');
assert.ok(freshnessText.includes('（缓存）'), 'freshness line marks a cached listing');
assert.ok(freshnessText.includes('2 源未变'), 'freshness line reports how many sources answered 304');

const search = loadedNodes.find((n) => n.type === 'input'
  && String(n.props?.placeholder ?? '').includes('搜索'));
assert.ok(search, 'market search input present');
// The placeholder names the thing being searched (MCP), not the catalogue's
// provenance: 「搜索 MCP 来源」 reads as a filter over sources.
assert.equal(search.props.placeholder, '搜索 MCP', 'market search placeholder must be 搜索 MCP');
assert.ok(String(search.props.title ?? '').length > 0, 'the long hint survives as a title');

// --- 3e. an install that did not mount says so, and adds what it can -------
// The reply carries `connect.ok === false` plus whatever the host could add.
// Rendering it as a success was the panel's own lie about its own work; the
// interesting part now is that all three layers survive to the screen.
{
  const tree = walk(await render());
  const install = buttonByText(tree, '安装');
  assert.ok(install, 'the installable card offers 安装');
  const beforeInstall = calls.length;
  // The CTA stops the click from reaching the card body (which opens 详情), so
  // the handler expects the event it always gets in a browser.
  install.props.onClick({ stopPropagation() {} });
  // Two awaits before the message appears (the host's answer, then the refresh
  // of both the registry and the listing).
  await settle();
  await settle();
  const after = walk(await render());
  assert.ok(calls.slice(beforeInstall).join(' ').includes('POST /install'), 'the click posts an install');

  const block = findByKey(after, 'installfail');
  assert.equal(block.length, 1, 'the failed install gets its own block, not a success line');
  assert.equal(block[0].props.style?.whiteSpace, 'pre-wrap', 'three facts on three lines need pre-wrap');
  const failureText = textOf(block[0]);
  assert.ok(failureText.includes('3dtexel-mcp 已写入注册表，但挂载没有成功：spawn npx ENOENT'),
    `the host's own error leads and is quoted verbatim (got: ${failureText})`);
  assert.ok(failureText.includes('npx 不在 PATH 里。'), 'the model explanation is shown');
  assert.ok(failureText.includes('先运行 where npx'), 'and its next step too');
  assert.ok(failureText.includes('（由 deepseek/deepseek-chat 诊断）'), 'the explanation names the route that made it');
  assert.ok(failureText.includes('没有计入本市场安装数'), 'and the note about the install counter survives');
  assert.equal(textOf(after).includes('已安装并连接'), false, 'a failed mount is never reported as a success');
  console.log('failed install: raw error + model explanation + retry note ✓');
}

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
// Every card states a category — including the entries whose source publishes
// none, which must read 未分类 rather than silently dropping the chip. (The
// fixture used to give all three cards a `group`, so this gap shipped.)
for (const card of cards) {
  const kinds = walk(card).filter((n) => n.type === 'span'
    && typeof n.props?.title === 'string' && /^分类：/.test(n.props.title));
  assert.equal(kinds.length, 1, 'every card carries exactly one 分类 chip');
}
{
  const remoteCard = cards.find((c) => String(c.props.title ?? '').startsWith('example-mcp'));
  assert.ok(remoteCard, 'the uncategorized entry renders');
  const chip = walk(remoteCard).find((n) => n.type === 'span'
    && typeof n.props?.title === 'string' && /^分类：/.test(n.props.title));
  assert.equal(textOf(chip), '未分类', 'an entry with no upstream category says 未分类');
}
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

// --- 4c. choosing an order actually reorders, and says so -------------------
// 「我选择了使用量最多，没有按我选择的筛选」: the comparator was right, but the
// wall is CSS multi-column, so a ranked list reads DOWN each column and looked
// unsorted; and a select looked the same whether or not it was filtering. This
// drives the real select and checks the document order, the rank chips, the
// active style and the meta line.
{
  const isSortSelect = (n) => n.type === 'select'
    && directChildren(n).some((o) => o.type === 'option' && o.props?.value === 'installs');
  // `loadedNodes` is already the flat list (re-walking it would duplicate every
  // ancestor once per descendant path).
  const selects = loadedNodes.filter(isSortSelect);
  assert.equal(selects.length, 1, 'the sort select is present exactly once');
  const sortSelect = selects[0];
  assert.ok(!String(sortSelect.props.className).includes('omkt-select-on'),
    'the default order must not be marked as an active filter');
  assert.equal(findByKey(loadedNodes, 'rank').length, 0,
    'no rank chips before a ranking order is chosen');

  sortSelect.props.onChange({ target: { value: 'installs' } });
  const sorted = walk(await render());
  const sortedSelect = sorted.filter(isSortSelect)[0];
  assert.ok(String(sortedSelect.props.className).includes('omkt-select-on'),
    'an active order carries the marker class');
  assert.ok(sortedSelect.props.style.borderColor, 'and paints its own border');

  const grid = findByKey(sorted, 'grid')[0];
  // Read the cards themselves (the article's title attribute), not the title
  // anchors: an entry with no repository renders its title as plain text.
  const titleOrder = walk(grid).filter((n) => n.type === 'article')
    .map((n) => String(n.props.title ?? '').split(' · ')[0])
    .filter((t) => ['snag', '3dtexel-mcp', 'example-mcp'].includes(t));
  // 使用量最多 = upstream figure + installs made from this panel: example-mcp
  // (90 000 upstream), snag (0 upstream + 5000 local) and 3dtexel (1200).
  assert.deepEqual(titleOrder, ['example-mcp', 'snag', '3dtexel-mcp'],
    `使用量最多 must add our own installs in (got ${JSON.stringify(titleOrder)})`);
  const snagCard = walk(grid).filter((n) => n.type === 'article')
    .find((n) => String(n.props.title ?? '').startsWith('snag'));
  assert.ok(textOf(snagCard).includes('本市场'),
    'the local install count is shown as its own series on the card');

  const ranks = findByKey(sorted, 'rank');
  assert.deepEqual(ranks.map((n) => textOf(n)), ['#1', '#2', '#3'],
    'each card states its place in the ranking');
  const meta = textOf(findByKey(sorted, 'meta')[0] ?? { props: {} });
  assert.ok(meta.includes('按使用量最多排序'), `the meta line names the order (got ${meta})`);
  console.log('sorting: 使用量最多 reorders the wall, ranks it, and marks the control ✓');

  // Back to the default so the later sections see the page as first painted.
  sortedSelect.props.onChange({ target: { value: 'default' } });
  await render();
}

// --- 4d. the other two filters narrow the list too --------------------------
// The user's follow-up: "其他的筛选条件应该也有同样的问题". 分类 filters in place;
// 全部市场 re-asks the host with the chosen source.
{
  const groupSelect = loadedNodes.find((n) => n.type === 'select'
    && directChildren(n).some((o) => o.type === 'option' && o.props?.value === '开发工具'));
  assert.ok(groupSelect, 'the 分类 select exists');
  groupSelect.props.onChange({ target: { value: '开发工具' } });
  const filtered = walk(await render());
  const cards = walk(findByKey(filtered, 'grid')[0]).filter((n) => n.type === 'article');
  assert.equal(cards.length, 1, `分类清单一开就该只剩该组（got ${cards.length} cards）`);
  assert.ok(textOf(findByKey(filtered, 'srcline')[0]).includes('筛选后 1 条'),
    'the provenance line states how many entries survived the filter');

  const srcSelect = loadedNodes.find((n) => n.type === 'select'
    && directChildren(n).some((o) => o.type === 'option' && o.props?.value === 'smithery'));
  assert.ok(srcSelect, 'the source select exists');
  const before = calls.length;
  srcSelect.props.onChange({ target: { value: 'smithery' } });
  await render();
  const asked = calls.slice(before).join(' ');
  assert.ok(asked.includes('source=smithery'),
    `choosing a source must re-query the host for it (asked: ${asked || 'nothing'})`);
  console.log('filters: 分类 narrows in place, 全部市场 re-queries the host ✓');

  groupSelect.props.onChange({ target: { value: '' } });
  srcSelect.props.onChange({ target: { value: '' } });
  await render();
}

// --- 4e. 仅看收藏 narrows in place and admits what it is hiding -------------
// The whole point of asking the host for a count is that the filter is a view
// over the loaded listing: a bookmark kept under another source (or hidden by
// the search box) must not look like an empty set, and an active control must
// not look like the inactive one — that was true of the two selects above.
{
  const market = walk(await render());
  const off = buttonByText(market, '仅看收藏 (1)');
  assert.ok(off, 'the favourites filter is in the filter row');
  assert.ok(!String(off.props.className).includes('omkt-icon-on'),
    'it must not look active before it is chosen');

  off.props.onClick();
  const filtered = walk(await render());
  assert.ok(calls.includes('GET /favorites'), 'turning it on asks the host for the total');
  const on = buttonByText(filtered, '仅看收藏 (1)');
  assert.ok(String(on.props.className).includes('omkt-icon-on'), 'the active filter is marked');
  const cards = walk(findByKey(filtered, 'grid')[0]).filter((n) => n.type === 'article');
  assert.deepEqual(cards.map((n) => String(n.props.title ?? '').split(' · ')[0]), ['snag'],
    `only the starred entry survives the filter (got ${cards.length} cards)`);
  const note = textOf(findByKey(filtered, 'favnote')[0] ?? { props: {} });
  assert.ok(note.includes('共 2 条收藏'),
    `the filter states how many favourites it is hiding (got ${note})`);

  buttonByText(filtered, '仅看收藏 (1)').props.onClick();
  const restored = walk(await render());
  assert.equal(findByKey(restored, 'favnote').length, 0, 'turning it off drops the note');
  assert.equal(walk(findByKey(restored, 'grid')[0]).filter((n) => n.type === 'article').length, 3,
    'and the whole listing is back');
  console.log('favourites: 仅看收藏 filters the listing and admits the hidden ones ✓');
}

// The page is a fixed shell now: scrolling belongs to the card box alone, so
// the search pill, the 分类 dropdown, the filter row and the meta lines must
// all live OUTSIDE it — otherwise dragging the wall carries the controls away.
{
  const scroller = findByKey(loadedNodes, 'scroll');
  assert.equal(scroller.length, 1, 'the market tab has exactly one card scroller');
  const scrollerStyle = scroller[0].props.style;
  assert.equal(scrollerStyle.overflowY, 'auto', 'the card region is the scrolling box');
  assert.match(String(scrollerStyle.flex), /^1 1 /, 'and it is the box that gives height back');
  assert.equal(containsNode(scroller[0], searchRow[0]), false, 'search row is pinned above the scroller');
  assert.equal(containsNode(scroller[0], filters[0]), false, 'filter row is pinned above the scroller');
  assert.equal(containsNode(scroller[0], metaRow[0]), false, 'meta line is pinned above the scroller');
  assert.equal(containsNode(scroller[0], grids[0]), true, 'the card grid is what scrolls');
  assert.equal(marketPage.props.style.overflow, 'hidden', 'the market body itself must not scroll');
  assert.match(String(marketPage.props.style.flex), /^1 1 /, 'the market body takes the leftover height');
  // The page is the shell: it never scrolls itself, which is what keeps the
  // head and the tab bar from sliding under the top edge.
  const pageNode = loadedNodes.find((n) => n.props?.className === 'omkt-page');
  assert.ok(pageNode, 'page shell present');
  assert.equal(pageNode.props.style.overflow, 'hidden', 'the page shell must not scroll');
  console.log('market scrolling: only the card box scrolls, the chrome is pinned ✓');
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
  assert.ok(regText.includes('全局 MCP'), `head names the page — got: ${regText}`);
  assert.match(regText, /v\d+\.\d+\.\d+/, 'version chip missing from the head');
  assert.ok(regText.includes('宿主机扫描 · 市场发现 · 一键接入'), 'sub-line missing');
  assert.ok(!regText.includes('申请收录'), 'no contribution flow is advertised from the page head');
  assert.ok(walk(regHead).some((n) => n.type === 'svg'), 'brand mark is not drawn');
  // `findByKey` walks the flattened tree, so the keyed button itself is a hit.
  assert.equal(textOf(findByKey(registry, 'hd-primary')[0]), '重新扫描宿主机',
    'registry tab primary action is wrong');
  assert.equal(textOf(findByKey(registry, 'hd-secondary')[0]), '打开 MCP 市场',
    'registry tab loses the market door');
  assert.equal(textOf(findByKey(registry, 'hd-log')[0]), '⤓ 导出日志', 'export button missing');

  // No return-to-top before there is anything to scroll back from.
  assert.equal(findByKey(registry, 'top').length, 0, 'return-to-top shown on an unscrolled page');

  // The market tab has NO always-on primary button: refreshing the catalogue is
  // what 刷新 in the 分类 row already does, and a filled button that duplicates
  // a small one is noise. It appears only when 检查更新 reports that this plugin
  // itself has a newer release, and then it installs that release.
  const regTabs = walk(findByKey(registry, 'tabs')[0]).filter((n) => n.type === 'button');
  regTabs.find((n) => textOf(n).startsWith('MCP 市场')).props.onClick();
  const market = walk(await render());
  assert.equal(findByKey(market, 'hd-primary').length, 0,
    'the market tab shows no primary button before an update is known');
  assert.equal(textOf(findByKey(market, 'hd-secondary')[0]), '重新扫描宿主机',
    'market tab loses the rescan door');
  assert.equal(findByKey(market, 'hd-updates').length, 1, 'market tab keeps 检查更新');

  const check = buttonByText(market, '检查更新');
  assert.ok(check, '检查更新 is clickable');
  check.props.onClick();
  const afterCheck = walk(await render());
  assert.ok(calls.includes('POST /updates'), '检查更新 asked the host');
  const updateBtn = findByKey(afterCheck, 'hd-self')[0];
  assert.ok(updateBtn, 'an available plugin update surfaces a button beside the version chip');
  assert.equal(textOf(updateBtn), '更新到 v0.2.0', 'and it names the version it installs');
  assert.match(String(updateBtn.props.title ?? ''), /0\.2\.0/, 'the target version is in the title');
  // One action, one place: the chip carries the self-update on both tabs, so
  // the market tab must not grow a second filled button for the same click.
  assert.equal(findByKey(afterCheck, 'hd-primary').length, 0,
    'the market tab does not duplicate the self-update as a primary button');
  console.log('page head renders: brand mark, title + version, sub-line, chip self-update ✓');
}

// --- 6b. clicking that button installs the plugin and says a restart is due --
{
  const market = walk(await render());
  const updateBtn = findByKey(market, 'hd-self')[0];
  assert.ok(updateBtn, 'the update button is still there to click');
  updateBtn.props.onClick();
  const afterUpdate = walk(await render());
  assert.ok(calls.includes('POST /self-update'), 'the button ran the self-update route');
  assert.equal(findByKey(afterUpdate, 'hd-self').length, 0, 'the button clears once installed');
  const message = findByKey(afterUpdate, 'message')[0];
  assert.ok(message, 'an outcome message is shown');
  assert.match(textOf(message), /重启 DSH/, 'and it says the change lands after a restart');
  console.log('plugin update: button runs /self-update, reports the restart ✓');
}

// --- 7. the rail row: page owns its head, glyph stays decorative -----------
// This page is the centre column itself, so its identity row and sub-line must
// be there (the frame draws no page title). The rail, on the other hand, labels
// the button and wraps the glyph in an `aria-hidden` span — so the glyph must
// not carry a second accessible name. Neither fact is visible to a smoke test
// of the registration shape, and both regress silently.
{
  const standalone = walk(await render());
  assert.equal(findByKey(standalone, 'hd-title').length, 1, 'page lost its own identity row');
  assert.equal(findByKey(standalone, 'hd-row2').length, 1, 'page lost its own sub-line row');
  assert.equal(containsNode(findByKey(standalone, 'hd-title')[0], findByKey(standalone, 'hd-log')[0]), false,
    'export button must not live in the identity row');
  assert.equal(containsNode(findByKey(standalone, 'hd-row2')[0], findByKey(standalone, 'hd-log')[0]), true,
    'export button belongs beside the sub-line');

  assert.equal(typeof mod.__test?.PanelGlyph, 'function', 'client exports __test.PanelGlyph');
  const glyph = mod.__test.PanelGlyph({ size: 16 });
  assert.equal(glyph.type, 'svg', 'rail glyph is not an svg');
  assert.equal(glyph.props.width, 16, 'rail glyph ignores the size the sidebar asks for');
  assert.equal(glyph.props.height, 16, 'rail glyph is not square');
  assert.equal(glyph.props.role, 'presentation', 'rail glyph announces itself as an image');
  assert.equal(glyph.props['aria-label'], null, 'rail glyph carries a second accessible name');
  assert.equal(glyph.props['aria-hidden'], 'true', 'rail glyph is not hidden from assistive tech');
  assert.equal(walk(glyph).filter((n) => n.type === 'circle').length, 6,
    'rail glyph lost the constellation (hub + five satellites)');

  // Collapsed rail: the sidebar asks for 18 instead of 16.
  const collapsed = mod.__test.PanelGlyph({ size: 18 });
  assert.equal(collapsed.props.width, 18, 'collapsed rail glyph ignores its size');
  // No size at all (a host that renders the entry outside the rail) still has
  // to produce a drawable icon rather than width=undefined.
  assert.equal(mod.__test.PanelGlyph({}).props.width, 18, 'rail glyph has no fallback size');

  // The page's head mark keeps its accessible name: it is the only heading
  // this page has.
  const headMark = walk(findByKey(standalone, 'hd-title')[0]).find((n) => n.type === 'svg');
  assert.equal(headMark.props.role, 'img', 'the page head mark lost its accessible name');
  assert.equal(headMark.props['aria-label'], 'Overall MCP', 'the page head mark is unlabelled');
  console.log('rail row renders: page head kept, decorative glyph at both rail sizes ✓');
}

// --- 8. the stylesheet was injected once -----------------------------------
assert.ok(styleElements.length >= 1, 'ensureStyles injects the hover/animation sheet');

console.log('market tab renders: tabs, stat line, search, 3 cards, CTA + footer split ✓');
console.log('registry tab renders: scan button present ✓');
