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
const kebab = (k) => (k.startsWith('Webkit') ? `-webkit-${k[7].toLowerCase()}${k.slice(8)}`
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
  const read = (host) => Array.from(host.querySelectorAll('.omkt-grid')).map((g) => ({
    columns: getComputedStyle(g).columnCount,
    cardWidth: Math.round(g.querySelector('article').getBoundingClientRect().width),
    boxWidth: Math.round(g.getBoundingClientRect().width),
  }));
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
    process.exitCode = 1;
  } else {
    console.log('ok  column count follows the container, not the window');
  }
}
