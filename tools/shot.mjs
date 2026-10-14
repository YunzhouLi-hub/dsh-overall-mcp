// tools/shot.mjs — photograph the real page next to the v4 prototype.
//
// "拿原型对照" is a visual question, and the last two rounds of it were
// answered by reading CSS side by side — which is how a card that renders at
// 268px next to a prototype that means 370px still looked "aligned on paper".
// This renders the actual Section (market tab, real cards, real detail panel)
// into a page, screenshots it with headless Chrome, and does the same for the
// prototype, so the diff is looked at instead of argued about.
//
// The stub runs effects and honours setState, exactly like render-market-tab:
// the market tab has to actually load before there is a market to photograph.
//
// Usage: node tools/shot.mjs [--keep]   (CHROME_PATH overrides the binary)
// Writes tools/out/*.png and prints their paths.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'client', 'client.js');
const protoPath = path.join(here, '..', 'prototype', 'frontend-card-style-v4.html');
const outDir = path.join(here, 'out');
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// --- fake React (frames per component instance, effects honoured) ----------
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
    frame.hooks[i] = frame.hooks[i];
    return [frame.hooks[i], (next) => { frame.hooks[i] = typeof next === 'function' ? next(frame.hooks[i]) : next; }];
  },
  useEffect(fn) { effects.push(fn); },
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
};
const requireShim = (id) => {
  if (id === 'react') return reactStub;
  throw new Error(`unexpected module request: ${id}`);
};

/** Six entries shaped like the prototype's own six cards. */
const repo = (n) => `https://github.com/${n}`;
const MARKET = {
  items: [
    {
      id: 'official:modelcontextprotocol/github', title: 'github', source: 'official-registry',
      author: 'modelcontextprotocol', description: 'MCP server for using the GitHub API, enabling file operations, repository management, search functionality, and more.',
      transport: 'stdio', install: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      repository: repo('modelcontextprotocol/servers'), version: '1.0.3', group: '开发工具',
      verified: true, official: true, installable: true, installed: false, installs: 22400, installsLabel: '次启动',
      tags: ['官方', 'TypeScript', 'npm'],
    },
    {
      id: 'awesome:punkpeye/awesome-mcp-servers', title: 'awesome-mcp-servers', source: 'awesome-list',
      author: 'punkpeye', description: 'A collection of MCP servers. 社区维护的最大 MCP 服务器清单，按功能分类。',
      transport: 'unknown', install: null, repository: repo('punkpeye/awesome-mcp-servers'),
      group: '搜索与知识', installable: false, installed: false, installs: 96300, installsLabel: '次启动',
      tags: ['搜索与知识', '清单'],
    },
    {
      id: 'remote:neon/mcp', title: 'Neon', source: 'awesome-remote', author: 'mcp.neon.com',
      description: 'Serverless Postgres. 托管端点，任何 MCP 客户端都可以直接指向同一地址。',
      transport: 'http', install: { transport: 'http', url: 'https://mcp.neon.com/mcp' },
      url: 'https://mcp.neon.com/mcp', homepage: 'https://neon.com', version: null, group: '数据与存储',
      verified: true, installable: true, installed: false, tags: ['数据与存储', '远程', '免登录'],
    },
    {
      id: 'smithery:brave', title: 'Brave Search', source: 'smithery', author: 'brave',
      description: 'Web search. 通过 Brave Search API 进行网页与新闻检索。', transport: 'stdio',
      install: { transport: 'stdio', command: 'npx', args: ['-y', '@brave/search-mcp'] },
      repository: repo('brave/brave-search-mcp-server'), version: '2.0.1', group: '搜索与知识',
      installable: true, installed: true, installs: 88000, installsLabel: '次启动', tags: ['搜索与知识', 'npm'],
    },
    {
      id: 'official:modelcontextprotocol/postgres', title: 'postgres', source: 'official-registry',
      author: 'modelcontextprotocol', description: 'Read-only access to PostgreSQL databases. 上游说明：请改用 sqlite 官方实现。',
      transport: 'stdio', install: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'] },
      repository: repo('modelcontextprotocol/servers'), version: '0.2.0', group: '数据与存储',
      official: true, deprecated: true, statusMessage: '上游已归档，不再维护。',
      installable: true, installed: false, tags: ['数据与存储', 'Python'],
    },
    {
      id: 'awesome:makenotion/notion-mcp-server', title: 'AFG: agents hire agents (test money) — sandbox marketplace where AI agents hire other agents',
      source: 'awesome-list', author: 'makenotion',
      description: 'Official Notion MCP server. 读写 Notion 页面、数据库与评论。', transport: 'unknown',
      install: null, repository: repo('makenotion/notion-mcp-server'), group: '办公协作',
      installable: false, installed: false, installs: 4200, installsLabel: '次启动',
      tags: ['办公协作', 'TypeScript', '需 API Key'],
    },
  ],
  counts: { 'official-registry': 2, 'awesome-list': 2, 'awesome-remote': 1, smithery: 1 },
  total: 5362, cached: true, fetchedAt: Date.now(),
};
const STATS = {
  'modelcontextprotocol/servers': {
    stars: 22400, forks: 1900, issues: 117, license: 'MIT', language: 'TypeScript',
    pushedAt: '2026-10-09T00:00:00Z', homepage: 'https://modelcontextprotocol.io',
    description: 'MCP server for using the GitHub API.', avatar: 'https://github.com/modelcontextprotocol.png',
  },
  'punkpeye/awesome-mcp-servers': { stars: 96300, author: 'punkpeye', avatar: 'https://github.com/punkpeye.png' },
  'brave/brave-search-mcp-server': { stars: 21900, author: 'brave', avatar: 'https://github.com/smithery-ai.png' },
  'makenotion/notion-mcp-server': { stars: 4200, author: 'makenotion', avatar: 'https://github.com/makenotion.png' },
};
// Real README pictures so the carousel slot renders. The host only returns
// media for repositories that actually have some — a card with a picture is
// the common case, so the fixture must not be the exception, or the shot
// would understate what a loaded page looks like.
const MEDIA = {
  'modelcontextprotocol/servers': {
    images: [
      { url: 'https://raw.githubusercontent.com/modelcontextprotocol/servers/HEAD/docs/github.png', alt: 'GitHub MCP 服务器' },
      { url: 'https://raw.githubusercontent.com/modelcontextprotocol/servers/HEAD/docs/architecture.png', alt: '架构图' },
    ],
  },
  'punkpeye/awesome-mcp-servers': {
    images: [{ url: 'https://raw.githubusercontent.com/punkpeye/awesome-mcp-servers/HEAD/assets/banner.png', alt: 'Awesome MCP Servers' }],
  },
  'brave/brave-search-mcp-server': {
    images: [{ url: 'https://raw.githubusercontent.com/brave/brave-search-mcp-server/HEAD/docs/search.png', alt: '搜索结果' }],
  },
  'makenotion/notion-mcp-server': {
    images: [{ url: 'https://raw.githubusercontent.com/makenotion/notion-mcp-server/HEAD/docs/notion.png', alt: 'Notion 页面' }],
  },
};

let captured = null;
// The client injects its own stylesheet at runtime (`ensureStyles`). The real
// pane gets it; a naive DOM stub would silently drop it, and the shots would
// show a page with no hover rules, no width breakpoints and a visible
// scrollbar — i.e. a worse page than ships. Capture it and inline it.
const sheetTexts = [];
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
globalThis.document = {
  head: { appendChild(el) { if (el && typeof el.textContent === 'string') sheetTexts.push(el.textContent); } },
  createElement: () => ({ setAttribute() {}, appendChild() {} }),
  getElementById: () => null,
};
globalThis.fetch = async (url) => {
  const ok = (value) => ({ ok: true, status: 200, json: async () => value });
  const p = String(url).replace('/api/overall-mcp', '');
  if (p.startsWith('/catalog')) return ok(MARKET);
  if (p.startsWith('/servers')) return ok({ servers: [] });
  if (p.startsWith('/repo-stats')) return ok({ stats: STATS });
  if (p.startsWith('/repo-media')) return ok({ media: MEDIA });
  return ok({});
};

const code = await readFile(bundlePath, 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', 'require', code)(globalThis.window, requireShim);
const mod = captured.factory(requireShim);

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
const settle = () => new Promise((r) => { setTimeout(r, 0); });
async function render() {
  let tree = null;
  for (let pass = 0; pass < 6; pass += 1) {
    ordinals.clear();
    tree = renderNode({ type: mod.Section, props: {} });
    for (const fn of effects.splice(0, effects.length)) {
      try { fn(); } catch (err) { throw new Error(`effect threw: ${err.message}`); }
    }
    await settle(); await settle();
  }
  ordinals.clear();
  return renderNode({ type: mod.Section, props: {} });
}
function walk(node, out = []) {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if ('type' in node) { out.push(node); walk(node.children, out); walk(node.props?.children, out); }
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

// --- descriptor → HTML -----------------------------------------------------
const UNITLESS = new Set([
  'lineHeight', 'fontWeight', 'flexGrow', 'flexShrink', 'opacity', 'zIndex',
  'WebkitLineClamp', 'order', 'zoom', 'columns', 'columnCount', 'flex',
]);
// `WebkitLineClamp` is the vendor-prefixed CSS property, so the prefix has to
// come off the *name*, not out of the middle of it: `k[7]`/`slice(8)` ate the
// `l` and produced `-webkit-ineClamp`, which the browser drops — every fixture
// was silently missing its 3-line clamp and its multicol break rules.
const kebab = (k) => (k.startsWith('Webkit')
  ? `-webkit-${k[6].toLowerCase()}${k.slice(7).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
  : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
const cssText = (style) => Object.entries(style)
  .filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => `${kebab(k)}:${typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : v}`)
  .join(';');
const ATTR_SKIP = new Set(['key', 'children', 'onClick', 'onKeyDown', 'onLoad', 'onError', 'onChange', 'onInput', 'ref', 'role', 'tabIndex']);
const IMG_PLACEHOLDER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='100'><rect width='160' height='100' fill='%23dfe3ee'/><rect x='14' y='12' width='132' height='8' rx='4' fill='%23b9c0d4'/><rect x='14' y='30' width='96' height='8' rx='4' fill='%23c8cede'/><rect x='14' y='64' width='60' height='24' rx='6' fill='%234d6bfe' opacity='.55'/></svg>";
function toHtml(node) {
  if (node == null || node === false) return '';
  if (Array.isArray(node)) return node.map(toHtml).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node !== 'object' || !('type' in node)) return '';
  const { type, props } = node;
  const attrs = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false || ATTR_SKIP.has(k)) continue;
    if (typeof v === 'function') continue;
    if (k === 'className') { attrs.push(`class="${v}"`); continue; }
    if (k === 'style') { attrs.push(`style="${cssText(v)}"`); continue; }
    attrs.push(`${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`);
  }
  const open = `<${type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  if (['img', 'input', 'br', 'hr'].includes(type)) return open;
  return `${open}${toHtml(node.children)}${toHtml(props?.children)}</${type}>`;
}

/** The prototype's own page shell, so both sides sit in the same box. */
const SHELL = `
  *{box-sizing:border-box}
  body{margin:0;background:#f5f5f5;color:#111;font:13.5px/1.55 "Inter",ui-sans-serif,-apple-system,system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
  button,input,select{font:inherit}
  .wrap{max-width:1180px;margin:0 auto;padding:20px 20px 60px}
  img{max-width:none}
`;

await mkdir(outDir, { recursive: true });

// --- 1. the plugin: market tab as it renders today -------------------------
let tree = await render();
const tabs = walk(tree).filter((n) => n.type === 'button' && textOf(n).startsWith('MCP 市场'));
if (!tabs.length) throw new Error('market tab button not found');
tabs[0].props.onClick();
tree = await render();
// Section 6 measures this same market list inside a DSH-shaped frame. The
// detail click below re-renders `tree`, so keep the list's own snapshot.
const marketTree = tree;

const marketHtml = `<!doctype html><meta charset="utf-8"><title>plugin-market</title>
<style>${SHELL}</style><style>${sheetTexts.join('\n')}</style><div class="wrap">${toHtml(tree)}</div>`;

// --- 2. the plugin: detail panel open -------------------------------------
const detailBtn = walk(tree).find((n) => n.type === 'button' && textOf(n) === '详情'
  && (n.props?.className ?? '').includes('omkt-btn'));
if (!detailBtn) throw new Error('detail button not found');
// Card handlers stop propagation before acting, so they need an event.
detailBtn.props.onClick({ stopPropagation() {} });
tree = await render();
const detailHtml = `<!doctype html><meta charset="utf-8"><title>plugin-detail</title>
<style>${SHELL}</style><style>${sheetTexts.join('\n')}</style><div class="wrap">${toHtml(tree)}</div>`;

// --- 3/4. the prototype, cards-only and detail-only ------------------------
const proto = await readFile(protoPath, 'utf8');
const avatar = (label) => `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><rect width='40' height='40' fill='%23d8dbe6'/><text x='20' y='26' font-size='18' text-anchor='middle' fill='%23888'>${label}</text></svg>`;
const protoCards = proto
  .replace(/src="https:\/\/github\.com\/([^."]+)\.png[^"]*"/g, (_, n) => `src="${avatar(n[0].toUpperCase())}"`)
  .replace('</body>', '<style>.overlay{display:none}</style></body>');
const protoDetail = proto
  .replace(/src="https:\/\/github\.com\/([^."]+)\.png[^"]*"/g, (_, n) => `src="${avatar(n[0].toUpperCase())}"`)
  .replace('</body>', '<style>.wrap{display:none}</style></body>');

const shot = async (name, html, width, height) => {
  const file = path.join(outDir, `${name}.html`);
  const png = path.join(outDir, `${name}.png`);
  // Offline: the resize proxy cannot answer, so every <img> in the fixture
  // stands in for a decoded screenshot.
  const offline = html.replace(/src="https:\/\/images\.weserv\.nl[^"]*"/g, `src="${IMG_PLACEHOLDER}"`);
  await writeFile(file, offline, 'utf8');
  await execFileP(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${width},${height}`,
    '--virtual-time-budget=2500', `--screenshot=${png}`,
    `file:///${file.replace(/\\/g, '/')}`,
  ], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (!process.argv.includes('--keep')) await rm(file, { force: true });
  return png;
};

const shots = [
  await shot('plugin-market', marketHtml, 1180, 2000),
  await shot('plugin-detail', detailHtml, 1180, 1100),
  await shot('proto-cards', protoCards, 1180, 2000),
  await shot('proto-detail', protoDetail, 1180, 1100),
];
console.log(shots.join('\n'));

// --- 5. the same page in two boxes, in one wide window ---------------------
// The grid's column count must follow the box it was given, never the window:
// the settings pane is a slice of the app, and a 1600px window with an 800px
// pane must still lay out two columns. Chrome is asked for the *used* value
// (the one the engine actually resolved), not the declared one, so a rule that
// loses the cascade cannot pass this.
{
  const gridVerdict = `
<div class="wrap" id="host-wide">${toHtml(tree)}</div>
<div id="box-narrow"><div class="wrap">${toHtml(tree)}</div></div>
<script>
  // chain() records the width of every box between the grid and body, plus any
  // horizontal padding on it: when a column count surprises us, the gutter that
  // ate the missing pixels is visible in the failure message instead of having
  // to be bisected by hand. (No backticks here: this whole block is itself a
  // template literal.)
  const read = (host) => Array.from(host.querySelectorAll('.omkt-grid')).map((g) => {
    const chain = [];
    for (let el = g; el && el !== document.body; el = el.parentElement) {
      const pad = getComputedStyle(el).paddingLeft;
      chain.push((el.className || el.id) + ':' + Math.round(el.getBoundingClientRect().width)
        + (pad === '0px' ? '' : '-pad' + parseFloat(pad)));
    }
    return {
      columns: String(getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean).length),
      cardWidth: Math.round(g.querySelector('article').getBoundingClientRect().width),
      boxWidth: Math.round(g.getBoundingClientRect().width),
      chain: chain,
    };
  });
  const verdict = {
    wide: read(document.getElementById('host-wide'))[0],
    narrow: read(document.getElementById('box-narrow'))[0],
    viewport: window.innerWidth,
  };
  const tag = document.createElement('div');
  tag.id = 'verdict';
  tag.textContent = 'GRIDVERDICT' + JSON.stringify(verdict) + 'ENDGRIDVERDICT';
  document.body.appendChild(tag);
</script>`;
  const probeHtml = `<!doctype html><meta charset="utf-8"><title>grid-probe</title>
<style>${SHELL}</style><style>${sheetTexts.join('\n')}</style>
<style>#box-narrow{width:820px;margin:0 auto}#box-narrow .wrap{max-width:none}</style>
${gridVerdict}`;
  const probeFile = path.join(outDir, '_grid-probe.html');
  await writeFile(probeFile, probeHtml.replace(/src="https:\/\/images\.weserv\.nl[^"]*"/g, `src="${IMG_PLACEHOLDER}"`), 'utf8');
  const { stdout } = await execFileP(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--window-size=1600,1400',
    '--virtual-time-budget=2500', '--dump-dom',
    `file:///${probeFile.replace(/\\/g, '/')}`,
  ], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (!process.argv.includes('--keep')) await rm(probeFile, { force: true });

  const found = /GRIDVERDICT(\{.*?\})ENDGRIDVERDICT/.exec(stdout);
  if (!found) throw new Error('grid probe produced no verdict');
  const v = JSON.parse(found[1]);
  const wideOk = v.wide && v.wide.columns === '3';
  const narrowOk = v.narrow && v.narrow.columns === '2';
  console.log(`\ngrid in a ${v.viewport}px window:`
    + ` 1140px box -> ${v.wide?.columns} columns of ${v.wide?.cardWidth}px`
    + ` | 820px box -> ${v.narrow?.columns} columns of ${v.narrow?.cardWidth}px`);
  if (!wideOk || !narrowOk) {
    console.error('FAIL: the column count did not follow its box'
      + ` (wide=${v.wide?.columns}, narrow=${v.narrow?.columns})`);
    console.error(`  wide  chain: ${v.wide?.chain?.join(' > ')}`);
    console.error(`  narrow chain: ${v.narrow?.chain?.join(' > ')}`);
    process.exitCode = 1;
  } else {
    console.log('ok  column count follows the container, not the window');
  }
}

// The DSH frame, copied from the layout bundle in app.asar
// (@deepseek-ai/dsh-client-ui-layout): a grid whose centre track is
// `minmax(0, 1fr)`, and a centre column that is a flex box with
// `min-width:0; overflow:hidden`. Every panel-shaped probe below renders the
// page into this, because a panel is one column of someone else's grid, not a
// window of its own.
const frameCss = `
  html,body{height:100%}
  .frame{grid-template-rows:100%;height:100%;display:grid;position:relative;overflow:hidden}
  .sidebarCol{min-width:0;overflow:hidden;background:#fafafa}
  .centerCol{flex-direction:column;min-width:0;display:flex;overflow:hidden;background:#fff}
`;
const frameOf = (inner) => `
<div class="frame" style="grid-template-columns:240px minmax(0px, 1fr) minmax(0px, 0px)">
  <div class="sidebarCol"></div>
  <div class="centerCol" id="center">${inner}</div>
  <div></div>
</div>`;

// --- 6. the page inside a DSH-shaped frame ---------------------------------
// The settings dialog used to be this page's home; it now lives in a sidebar
// panel, where it is one column of the app's own grid and that column can be
// far narrower than the window. Two things are asserted at every window width:
// the page never scrolls sideways, and the column count follows the grid's own
// box rather than the window — a 1600px window with a 1000px pane is exactly
// the case that used to lay out three columns behind a scrollbar.
//
// The hostile input is real: catalogues publish descriptions carrying markdown
// links, a URL is one unbreakable token, README banners are wider than a
// column, and catalogue names are arbitrary text in a nowrap title.
{
  const frameVerdict = `${frameOf(toHtml(marketTree))}
<script>
  const hostile = 'https://github.com/' + 'a-very-long-owner-name/'.repeat(6) + 'repository';
  const desc = document.querySelector('[data-omkt="desc"]');
  if (desc) desc.textContent = desc.textContent + ' ' + hostile;
  const page = document.getElementById('center').firstElementChild;
  const grid = document.querySelector('.omkt-grid');
  const card = grid.querySelector('article');
  // A README banner is as wide as it is: the strip gives every slide an
  // explicit width (height x natural aspect), so a 4:1 picture is 660px of a
  // 371px column. This is the input that used to inflate the wall, and it is
  // applied here so the probe keeps failing if the sizing chain ever loses its
  // min-width: 0 again.
  const slides = Array.from(grid.querySelectorAll('.omkt-media-slide'));
  for (const s of slides) s.style.width = '660px';
  // A catalogue name is arbitrary text in a nowrap title, so it is the other
  // unbreakable run in a card.
  const nameEl = grid.querySelector('article a');
  if (nameEl) nameEl.textContent = 'a-very-long-catalog-entry-name-that-keeps-going-'.repeat(2);
  // The condition that actually broke the real panel: a card whose own content
  // cannot fit any column. In the app it measured 608px (whatever child it was,
  // it pulled the wall open to 3 x 621px inside a 1180px page). 6000px of
  // unbreakable width inside the last card reproduces that with no ambiguity,
  // and the card clips it so this fixture's own scroll width stays honest. The
  // card is marked so the bleed check below can skip the deliberate offender.
  const allCards = Array.from(grid.querySelectorAll('article'));
  const wideCard = allCards[allCards.length - 1];
  if (wideCard) {
    wideCard.setAttribute('data-omkt', 'wide');
    wideCard.style.overflow = 'hidden';
    const wide = document.createElement('div');
    wide.setAttribute('style', 'width:6000px;height:1px');
    wideCard.appendChild(wide);
  }
  let container = grid.parentElement;
  for (let el = grid; el; el = el.parentElement) {
    if (getComputedStyle(el).containerType !== 'normal') { container = el; break; }
  }
  const chain = [];
  for (let el = grid; el && el !== document.body; el = el.parentElement) {
    chain.push((el.className || el.id || el.tagName) + ':' + Math.round(el.getBoundingClientRect().width));
  }
  // The wall's min-content is the size a min-width:auto ancestor grows to: one
  // column per column-count, each as wide as its widest card. It is reported
  // for the failure message but is not itself asserted - a card may hold a
  // picture wider than its column (the strip scrolls). What must hold is that
  // the wall was laid out in the space the page actually has: with the app's
  // chain, 1891px of min-content inside a 1140px box is exactly the bug (3 x
  // 621px columns, page scrollbar, third column off screen). The clone is
  // measured and removed first so it cannot perturb the reads below.
  // (No backticks in this block: it is a template literal.)
  const clone = grid.cloneNode(true);
  clone.style.width = 'min-content';
  const holder = document.createElement('div');
  holder.setAttribute('style',
    'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden');
  holder.appendChild(clone);
  document.body.appendChild(holder);
  const gridMin = Math.round(clone.getBoundingClientRect().width);
  holder.remove();
  // One card, on its own, at min-content: which child is the widest is the
  // answer to "what is holding the wall open", and it is printed when the
  // sizing check fails.
  const cardClone = card.cloneNode(true);
  cardClone.style.width = 'min-content';
  const holder2 = document.createElement('div');
  holder2.setAttribute('style',
    'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;visibility:hidden');
  holder2.appendChild(cardClone);
  document.body.appendChild(holder2);
  const cardMin = Math.round(cardClone.getBoundingClientRect().width);
  const kids = Array.from(cardClone.children)
    .map((el) => (el.className || el.tagName) + ':' + Math.round(el.getBoundingClientRect().width));
  holder2.remove();
  const pageStyle = getComputedStyle(page);
  const avail = Math.round(page.clientWidth
    - parseFloat(pageStyle.paddingLeft) - parseFloat(pageStyle.paddingRight));
  // With the wall pinned to its box, the remaining risk is a card whose own
  // content is wider than the column it was given: that would bleed out of the
  // card instead of widening the page. The 660px slides are the input that
  // would do it, so the widest card overflow is asserted rather than eyeballed.
  const cards = Array.from(grid.querySelectorAll('article:not([data-omkt="wide"])'));
  const bleed = cards.reduce((m, c) => Math.max(m, Math.round(c.scrollWidth - c.clientWidth)), 0);
  // A CJK label breaks between characters, so a flex button's automatic minimum
  // width is ONE glyph: when its row is over-constrained the label wraps inside
  // a box too narrow for it and the second line is clipped away. The real app
  // shipped a 38px 搜索 button with its text cut in half. No button in the page
  // may clip or wrap its own label, at any window width.
  const buttons = Array.from(page.querySelectorAll('button'))
    .filter((b) => (b.textContent || '').trim().length > 0);
  const clipped = buttons
    .map((b) => ({
      label: (b.textContent || '').trim().slice(0, 12),
      w: Math.round(b.getBoundingClientRect().width),
      h: Math.round(b.getBoundingClientRect().height),
      clip: Math.round(b.scrollWidth - b.clientWidth),
      wrapped: Math.round(b.scrollHeight - b.clientHeight),
    }))
    .filter((b) => b.clip > 1 || b.wrapped > 1);
  const searchButton = buttons.find((b) => (b.textContent || '').trim() === '搜索');
  const searchButtonWidth = searchButton ? Math.round(searchButton.getBoundingClientRect().width) : null;
  // The second half of the same bug: an element can also be *cut off* by an
  // ancestor's non-visible overflow (the market body clips now) without its own
  // scrollWidth noticing. A row that is width:100% plus padding overflows by
  // exactly its padding unless it is border-box — which is how the app ended up
  // showing a half-visible search button. (No backticks in this block.)
  const marketBody = document.querySelector('[data-omkt="market"]');
  const bodyRight = marketBody
    ? marketBody.getBoundingClientRect().right - parseFloat(getComputedStyle(marketBody).paddingRight)
    : null;
  const pastBody = marketBody
    ? Array.from(marketBody.querySelectorAll('button, input, select'))
      // The hostile card is deliberately wider than the page; only what the
      // chrome rows place matters here.
      .filter((el) => !el.closest('[data-omkt="wide"]'))
      .map((el) => ({
        label: (el.textContent || el.getAttribute('placeholder') || el.tagName).trim().slice(0, 12),
        over: Math.round(el.getBoundingClientRect().right - bodyRight),
      }))
      .filter((x) => x.over > 1)
    : [];
  const marketBodyScroll = marketBody
    ? Math.round(marketBody.scrollWidth - marketBody.clientWidth) : null;
  // Scrolling belongs to the card box alone: the search pill, the 分类 row and
  // the meta lines are chrome and must not move when the wall is dragged. That
  // is measured, not assumed — scroll the inner box and re-read the chrome.
  const scroller = document.querySelector('#center [data-omkt="scroller"]');
  const chromeTop = (sel) => {
    const el = sel ? sel() : null;
    return el ? el.getBoundingClientRect().top : null;
  };
  const tabBarNode = document.querySelector('#center .omkt-tabbar');
  const searchNode = document.querySelector('#center [data-omkt="market"] input');
  const beforeTab = chromeTop(() => tabBarNode);
  const beforeSearch = chromeTop(() => searchNode);
  let innerScrolled = 0;
  if (scroller) {
    const room = scroller.scrollHeight - scroller.clientHeight;
    scroller.scrollTop = Math.max(0, Math.min(240, room));
    innerScrolled = Math.round(scroller.scrollTop);
  }
  // Read the chrome while the wall is scrolled: this is the assertion.
  const afterTab = chromeTop(() => tabBarNode);
  const afterSearch = chromeTop(() => searchNode);
  const chromeShift = (beforeTab === null || afterTab === null) ? null : Math.round(afterTab - beforeTab);
  const searchShift = (beforeSearch === null || afterSearch === null) ? null
    : Math.round(afterSearch - beforeSearch);
  const pageScrolled = Math.round(page.scrollTop);
  const scrollerRoom = scroller ? Math.round(scroller.scrollHeight - scroller.clientHeight) : null;
  if (scroller) scroller.scrollTop = 0; // leave the page as the screenshots expect it
  // A column flex container shrinks its items along the main axis when their
  // content is taller than the box, and this page *is* a definite-height scroll
  // container: with the tall market body the tab bar was the cheapest item to
  // shrink, so it collapsed to its own 1px border and 「已注册」 became
  // unreachable — the market tab turned into a one-way door. Every row of the
  // page must keep its own height.
  const rowHeights = Array.from(page.children)
    .map((el) => Math.round(el.getBoundingClientRect().height));
  const rowMin = rowHeights.reduce((m, h) => Math.min(m, h), 1e9);
  // Only the selected tab may carry the ink underline. It is painted by a
  // pseudo-element rule keyed on aria-selected, so the inactive tab has no
  // visible line at all — the earlier inline 2px transparent border-bottom
  // rendered *black* in the real app (the UA button border colour), which made
  // both tabs look selected at once. (No backticks in this block.)
  const tabBarEl = Array.from(page.children).find((el) => el.querySelectorAll('.omkt-tab').length >= 2
    && el.getBoundingClientRect().height < 60);
  const tabs = tabBarEl ? Array.from(tabBarEl.querySelectorAll('.omkt-tab')) : [];
  const underlines = tabs.map((btn) => {
    const after = getComputedStyle(btn, '::after');
    const ink = after.backgroundColor !== 'rgba(0, 0, 0, 0)' && after.backgroundColor !== 'transparent';
    const border = getComputedStyle(btn);
    const borderVisible = border.borderBottomStyle !== 'none'
      && parseFloat(border.borderBottomWidth) > 0
      && border.borderBottomColor !== 'rgba(0, 0, 0, 0)';
    return (ink ? 'ink' : 'clear') + ':' + after.backgroundColor
      + (borderVisible ? '+border' : '');
  });
  const inkedTabs = underlines.filter((u) => u.startsWith('ink')).length;
  const tabsSelected = tabs.map((btn) => btn.getAttribute('aria-selected')).join(',');
  const descStyle = desc ? getComputedStyle(desc) : null;
  const verdict = {
    viewport: window.innerWidth,
    injected: Boolean(desc),
    slides: slides.length,
    page: Math.round(page.clientWidth),
    avail: avail,
    scroll: Math.round(page.scrollWidth),
    gridBox: Math.round(grid.getBoundingClientRect().width),
    gridMin: gridMin,
    cardMin: cardMin,
    kids: kids,
    named: Boolean(nameEl),
    bleed: bleed,
    rowHeights: rowHeights,
    rowMin: rowMin,
    scrollRoom: scrollerRoom,
    innerScrolled: innerScrolled,
    chromeShift: chromeShift,
    searchShift: searchShift,
    pageScrolled: pageScrolled,
    underlines: underlines,
    inkedTabs: inkedTabs,
    tabsSelected: tabsSelected,
    clippedButtons: clipped,
    searchButtonWidth: searchButtonWidth,
    pastBody: pastBody,
    marketBodyScroll: marketBodyScroll,
    descClamp: descStyle ? descStyle.webkitLineClamp : 'n/a',
    descH: desc ? Math.round(desc.getBoundingClientRect().height) : 0,
    descScroll: desc ? Math.round(desc.scrollHeight) : 0,
    columns: String(getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length),
    cardWidth: Math.round(card.getBoundingClientRect().width),
    container: container.tagName.toLowerCase() + '.' + (container.className || '-') + ':'
      + getComputedStyle(container).containerType,
    body: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
    chain: chain,
  };
  const tag = document.createElement('div');
  tag.textContent = 'FRAMEVERDICT' + JSON.stringify(verdict) + 'ENDFRAMEVERDICT';
  document.body.appendChild(tag);
</script>`;
  const frameFile = path.join(outDir, '_frame-probe.html');
  // OMKT_RED_FRAME restores the old chain (a grid page whose items keep the
  // automatic `min-width: auto`) so the probe can be shown to fail on the
  // design it was written against, rather than only ever passing.
  const redFrame = process.env.OMKT_RED_FRAME
    ? `<style>#center > div{display:grid !important;min-width:auto !important}
       #center > div > *{display:grid !important;min-width:auto !important}
       #center > div > * > *{min-width:auto !important}
       #center .omkt-page > *,#center .omkt-tabbody > *{flex-shrink:1 !important}
       #center .omkt-tab::after{background:#000 !important}
       #center [data-omkt="market"] > div:first-child{min-width:2000px !important}</style>`
    : '';
  await writeFile(frameFile, `<!doctype html><meta charset="utf-8"><title>frame-probe</title>
<style>${SHELL}</style><style>${sheetTexts.join('\n')}</style><style>${frameCss}</style>
${redFrame}
${frameVerdict}`.replace(/src="https:\/\/images\.weserv\.nl[^"]*"/g, `src="${IMG_PLACEHOLDER}"`), 'utf8');

  const expected = (box) => (box >= 1100 ? '3' : box >= 720 ? '2' : '1');
  let bad = 0;
  for (const [width, height] of [[880, 900], [1280, 900], [1600, 1200], [2200, 1200]]) {
    const { stdout } = await execFileP(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--force-device-scale-factor=1', `--window-size=${width},${height}`,
      '--virtual-time-budget=2500', '--dump-dom',
      `file:///${frameFile.replace(/\\/g, '/')}`,
    ], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    const found = /FRAMEVERDICT(\{.*?\})ENDFRAMEVERDICT/.exec(stdout);
    if (!found) throw new Error(`frame probe produced no verdict at ${width}px`);
    const f = JSON.parse(found[1]);
    const fits = f.scroll <= f.page && f.body === 0;
    const band = f.columns === expected(f.gridBox);
    const sizing = Math.abs(f.gridBox - f.avail) <= 1;
    const clamped = f.bleed <= 1;
    console.log(`\nin a ${f.viewport}px window with a 240px sidebar: centre ${f.page}px ->`
      + ` ${f.avail}px available -> ${f.gridBox}px grid -> ${f.columns} columns of ${f.cardWidth}px`);
    console.log(`  hostile input: long URL ${f.injected}, ${f.slides} slides forced to 660px,`
      + ` long name ${f.named}; card min-content ${f.cardMin}px`
      + ` (${(f.kids || []).join(', ')}); wall min-content ${f.gridMin}px`);
    console.log(`  page scrollWidth ${f.scroll} vs clientWidth ${f.page} (body overflow ${f.body}px);`
      + ` measured against ${f.container}`);
    console.log(`  widest card overflow ${f.bleed}px; description clamped to ${f.descClamp}`
      + ` (${f.descH}px shown of ${f.descScroll}px)`);
    console.log(`  page rows [${(f.rowHeights || []).join(', ')}]px;`
      + ` tab underlines [${(f.underlines || []).join(' | ')}] (aria-selected ${f.tabsSelected})`);
    // Only the card box scrolls: with it dragged 240px down, the tab bar and the
    // search pill must not have moved a pixel, and the page shell must still be
    // at scrollTop 0. (`scrollRoom` is the box's overflow; when the fixture has
    // too few cards to overflow, the assertion is vacuous but reported.)
    const pins = f.chromeShift === 0 && f.searchShift === 0 && f.pageScrolled === 0;
    // No button may clip or wrap its own label (see the CJK min-content note),
    // and no control may stick out of the market body that now clips.
    const labelsFit = (f.clippedButtons || []).length === 0 && (f.pastBody || []).length === 0
      && f.marketBodyScroll === 0;
    console.log(`  card scroller: ${f.scrollRoom}px of room, scrolled ${f.innerScrolled}px ->`
      + ` tab bar moved ${f.chromeShift}px, search moved ${f.searchShift}px,`
      + ` page scrollTop ${f.pageScrolled}`);
    console.log(`  buttons: ${f.searchButtonWidth}px for 搜索, market body overflow`
      + ` ${f.marketBodyScroll}px;`
      + (labelsFit ? ' every label fits and stays inside the body'
        : ` clipped ${JSON.stringify(f.clippedButtons)} past-body ${JSON.stringify(f.pastBody)}`));
    if (!fits || !band || !sizing || !clamped || f.rowMin < 16 || f.inkedTabs !== 1 || !pins || !labelsFit) {
      bad += 1;
      console.error(`FAIL at ${f.viewport}px: expected ${expected(f.avail)} columns for a`
        + ` ${f.avail}px page, got ${f.columns} for a ${f.gridBox}px wall`
        + ` (min-content ${f.gridMin}px); overflow ${f.scroll - f.page}px,`
        + ` card bleed ${f.bleed}px, shortest page row ${f.rowMin}px,`
        + ` inked tabs ${f.inkedTabs} [${(f.underlines || []).join(' | ')}],`
        + ` chrome shift ${f.chromeShift}px / search shift ${f.searchShift}px /`
        + ` page scrollTop ${f.pageScrolled},`
        + ` market body overflow ${f.marketBodyScroll}px,`
        + ` clipped buttons ${JSON.stringify(f.clippedButtons)},`
        + ` controls past the body ${JSON.stringify(f.pastBody)}`);
      console.error(`  chain: ${f.chain.join(' > ')}`);
    }
  }
  // The frame at the width where the panel lands on two columns, and at a wide
  // desktop window (where the page's 1180px cap is what decides): the geometry
  // is asserted above, these are the same page for an eye to check.
  console.log(`\n${await shot('frame-2col', await readFile(frameFile, 'utf8'), 1280, 1000)}`);
  console.log(await shot('frame-wide', await readFile(frameFile, 'utf8'), 2200, 1200));
  if (!process.argv.includes('--keep')) await rm(frameFile, { force: true });
  if (bad) process.exitCode = 1;
  else console.log('\nok  the page fits its column at every width, with a hostile URL in a card');
}

// --- 7. the panel on first paint -------------------------------------------
// Switching to the market tab showed a screenful of gaps: the page is
// `height: 100%`, and a grid with a definite height spreads its rows over the
// whole box (`align-content: normal` is stretch), so the header sat at the top,
// the tabs floated mid-panel and the market body's rows were spaced a hundred
// pixels apart. A column flex container packs its main axis at the start
// instead. The probe hangs the catalogue request, mounts the plugin cold (empty
// hook store, so this is the real first paint) inside the real frame, and
// measures the gaps between the page's own children.
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  frameStore.clear();
  effects.length = 0;
  const firstPaint = await render();
  globalThis.fetch = realFetch;

  const paintScript = `
  const page = document.getElementById('center').firstElementChild;
  // A row that is *meant* to fill (the tab body, and the card scroller inside
  // it) declares flex-grow: 1. Every other row must be exactly as tall as what
  // it painted, so those are the ones this probe measures.
  const grow = (el) => parseFloat(getComputedStyle(el).flexGrow) > 0;
  const all = Array.from(page.children).filter((el) => el.getBoundingClientRect().height > 0);
  const kids = all.filter((el) => !grow(el));
  const filling = all.filter(grow).map((el) => el.getAttribute('data-omkt') || el.tagName);
  // The gap chain runs over every row in document order — the filling row is a
  // real row and its space is *supposed* to be there. Only the slack metric
  // skips it, because "taller than its own content" is exactly what a filling
  // row is allowed to be.
  const boxes = all.map((el) => el.getBoundingClientRect());
  const gaps = [];
  for (let i = 1; i < boxes.length; i += 1) {
    gaps.push(Math.round(boxes[i].top - boxes[i - 1].bottom));
  }
  const maxGap = gaps.reduce((m, g) => Math.max(m, g), 0);
  const painted = Math.round(all.reduce((sum, el) => sum + el.getBoundingClientRect().height, 0));
  // Stretching a grid row does not open a gap between the rows and does not
  // make the row scrollable: it makes the row taller than the content it
  // painted (a block's scrollHeight is just its own box). So the slack is
  // measured against the union of the row's children instead.
  const inner = (el) => {
    const cs = getComputedStyle(el);
    const kids2 = Array.from(el.children);
    if (!kids2.length) return 0;
    const first = kids2[0].getBoundingClientRect();
    const last = kids2[kids2.length - 1].getBoundingClientRect();
    return (last.bottom - first.top) + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  };
  const slackOf = (list) => Math.round(list.reduce((sum, el) => {
    const box = el.getBoundingClientRect();
    return sum + Math.max(0, box.height - inner(el) - parseFloat(getComputedStyle(el).marginTop)
      - parseFloat(getComputedStyle(el).marginBottom));
  }, 0));
  const slack = slackOf(kids);
  // Inside the filling box the chrome must still pack at the top: search row,
  // 分类 row, meta line, then empty space — never rows spread over the panel.
  const filler = all.find(grow);
  const innerSlack = filler ? slackOf(Array.from(filler.children)
    .filter((el) => !grow(el) && el.getBoundingClientRect().height > 0)) : 0;
  const verdict = {
    viewport: window.innerWidth,
    page: Math.round(page.getBoundingClientRect().height),
    rows: all.length,
    measured: kids.length,
    filling: filling,
    painted: painted,
    maxGap: maxGap,
    gaps: gaps,
    slack: slack,
    innerSlack: innerSlack,
  };
  const tag = document.createElement('div');
  tag.textContent = 'PAINTVERDICT' + JSON.stringify(verdict) + 'ENDPAINTVERDICT';
  document.body.appendChild(tag);
`;
  const paintFile = path.join(outDir, '_paint-probe.html');
  const paintHtml = `<!doctype html><meta charset="utf-8"><title>paint-probe</title>
<style>${SHELL}</style><style>${sheetTexts.join('\n')}</style><style>${frameCss}</style>
${process.env.OMKT_RED_PAINT ? '<style>#center > div{display:grid !important}</style>' : ''}
${frameOf(toHtml(firstPaint))}
<script>${paintScript}</script>`;
  await writeFile(paintFile, paintHtml, 'utf8');

  const { stdout } = await execFileP(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', '--window-size=1280,900',
    '--virtual-time-budget=2500', '--dump-dom',
    `file:///${paintFile.replace(/\\/g, '/')}`,
  ], { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (!process.argv.includes('--keep')) await rm(paintFile, { force: true });

  const found = /PAINTVERDICT(\{.*?\})ENDPAINTVERDICT/.exec(stdout);
  if (!found) throw new Error('first-paint probe produced no verdict');
  const p = JSON.parse(found[1]);
  console.log(`\nfirst paint in a ${p.viewport}px window: ${p.rows} rows`
    + ` (${p.measured} sized, filling: ${(p.filling || []).join(', ') || 'none'}),`
    + ` ${p.painted}px painted of a ${p.page}px panel, gaps [${(p.gaps || []).join(', ')}]px,`
    + ` ${p.slack}px of stretched row space, ${p.innerSlack}px inside the filling box`);
  // With the page packed at the top, no sized row is taller than its content and
  // the rows inside the filling box (the tab body) still pack at its top: the
  // only slack is sub-pixel rounding. A grid page in the same panel reported
  // 400px+ here, one row stretched over the whole viewport.
  if (p.slack > 32 || p.innerSlack > 32 || p.maxGap > 56) {
    console.error(`FAIL: a row was stretched over the panel — ${p.slack}px of slack`
      + ` (${p.innerSlack}px inside ${(p.filling || []).join('/')}),`
      + ` widest gap ${p.maxGap}px (page ${p.page}px, painted ${p.painted}px)`);
    process.exitCode = 1;
  } else {
    console.log('ok  the loading state packs at the top instead of stretching its rows');
  }
  // The loading state as an eye sees it: the empty space should be *below* the
  // last row, not spread between four of them.
  console.log(await shot('frame-loading', paintHtml, 1280, 900));
}

