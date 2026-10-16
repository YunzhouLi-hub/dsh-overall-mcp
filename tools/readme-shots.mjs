// tools/readme-shots.mjs — the pictures in README.md / README.zh-CN.md.
//
// The READMEs describe five panels' worth of behaviour in prose; a reader
// deciding whether to install this plugin should be able to *look* at the two
// tabs and the detail panel first. This renders the real Section (same fake
// React harness as tools/shot.mjs, same real client bundle, same engine) and
// writes three PNGs into docs/images/.
//
// Why its own harness rather than tools/shot.mjs: those shots exist to review
// the layout against the v4 prototype, so their fixtures are hostile on
// purpose (a 6000px card, a 660px banner, a 206-character name). A picture in a
// README has the opposite job — it should show the page as a reader meets it,
// which means the GitHub access card is finished (a census that read, a
// recovery walk that was stopped on purpose) instead of `{}`.
//
// Usage:
//   node tools/readme-shots.mjs           # render + write docs/images/*.png
//   node tools/readme-shots.mjs --check   # no browser: every image the READMEs
//                                         # reference must exist on disk
//   CHROME_PATH=... node tools/readme-shots.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const bundlePath = path.join(root, 'client', 'client.js');
const outDir = path.join(root, 'docs', 'images');
const chrome = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const READMES = ['README.md', 'README.zh-CN.md'];
// The READMEs carry absolute raw.githubusercontent URLs so the pictures also
// load on npm, where a relative path inside the published README has no page to
// resolve against. That means a rename cannot be caught by the browser, so the
// prefix is pinned here and `--check` maps every URL back to a file on disk.
const RAW_PREFIX = 'https://raw.githubusercontent.com/YunzhouLi-hub/dsh-overall-mcp/main/';

// --- check mode: every referenced image exists ------------------------------
if (process.argv.includes('--check')) {
  let bad = 0;
  for (const name of READMES) {
    const text = await readFile(path.join(root, name), 'utf8');
    // Two shapes, because the header icon is HTML (a centred `<img>`) while the
    // panel pictures are markdown: checking only one would leave the image a
    // reader sees first unverified.
    const urls = [
      ...[...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]),
      ...[...text.matchAll(/<img\s[^>]*src="([^"]+)"/g)].map((m) => m[1]),
    ];
    // Only this repo's own pictures are checked: a README may legitimately
    // point at someone else's badge (shields.io), and this script cannot see
    // the network.
    const mine = urls.filter((u) => u.startsWith(RAW_PREFIX));
    if (!mine.length) { console.error(`${name}: no picture inside ${RAW_PREFIX}`); bad += 1; }
    for (const url of mine) {
      const rel = url.slice(RAW_PREFIX.length);
      try {
        await readFile(path.join(root, rel));
        console.log(`${name}: ${rel} ✓`);
      } catch {
        console.error(`${name}: ${url} does not exist at ${rel}`);
        bad += 1;
      }
    }
  }
  if (bad) { console.error(`\nFAIL: ${bad} README picture problem(s)`); process.exitCode = 1; }
  else console.log('\nok  every README picture exists');
  process.exit();
}

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

/** A banner drawn inline, so the picture does not wait on the network. The SVG
 *  is fully percent-encoded: a raw `<` inside an attribute renders as a broken
 *  image in headless Chrome, which is exactly what the first run showed. The
 *  640x400 canvas is near the strip's own ~1.6 aspect ratio, because the client
 *  crops a slide with object-fit: cover. */
const banner = (label, from, to) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#${from}"/><stop offset="1" stop-color="#${to}"/>
</linearGradient></defs>
<rect width="640" height="400" fill="url(#g)"/>
<text x="320" y="215" font-family="sans-serif" font-size="46" text-anchor="middle" fill="#ffffff" opacity="0.95">${label}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

const repo = (n) => `https://github.com/${n}`;
/** Six entries shaped like the real catalogue: installable, link-only, remote. */
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
      id: 'awesome:punkpeye/awesome-mcp-servers', title: 'awesome-mcp-servers', source: 'awesome-list',
      author: 'punkpeye', description: 'A collection of MCP servers. 社区维护的最大 MCP 服务器清单，按功能分类。',
      transport: 'unknown', install: null, repository: repo('punkpeye/awesome-mcp-servers'),
      group: '搜索与知识', installable: false, installed: false, installs: 96300, installsLabel: '次启动',
      tags: ['搜索与知识', '清单'],
    },
    {
      id: 'awesome:makenotion/notion-mcp-server', title: 'notion-mcp-server', source: 'awesome-list',
      author: 'makenotion', description: 'Official Notion MCP server. 读写 Notion 页面、数据库与评论。',
      transport: 'unknown', install: null, repository: repo('makenotion/notion-mcp-server'),
      group: '办公协作', installable: false, installed: false, installs: 4200, installsLabel: '次启动',
      tags: ['办公协作', 'TypeScript', '需 API Key'],
    },
  ],
  counts: { 'official-registry': 2, 'awesome-list': 2, 'awesome-remote': 1, smithery: 1 },
  total: 5362, cached: true, fetchedAt: Date.UTC(2026, 9, 16, 9, 30),
};
const STATS = {
  'modelcontextprotocol/servers': {
    stars: 22400, forks: 1900, issues: 117, license: 'MIT', language: 'TypeScript',
    pushedAt: '2026-10-09T00:00:00Z', homepage: 'https://modelcontextprotocol.io',
    description: 'MCP server for using the GitHub API.', avatar: null,
  },
  'brave/brave-search-mcp-server': { stars: 21900, author: 'brave', avatar: null },
  'punkpeye/awesome-mcp-servers': { stars: 96300, author: 'punkpeye', avatar: null },
  'makenotion/notion-mcp-server': { stars: 4200, author: 'makenotion', avatar: null },
};
const MEDIA = {
  'modelcontextprotocol/servers': {
    images: [{ url: banner('GitHub MCP', '4d6bfe', '7c5cff'), alt: 'GitHub MCP 服务器' }],
  },
  'brave/brave-search-mcp-server': {
    images: [{ url: banner('Brave Search', 'ff6b35', 'ffb03a'), alt: '搜索结果' }],
  },
};
/** The 已注册 tab: a connected server, one described by its tools, one stopped. */
const REGISTERED = [
  {
    name: 'codegraph', serverName: 'codegraph', transport: 'stdio', source: 'claude-code',
    enabled: true, connected: true, status: 'connected',
    about: {
      text: 'Codegraph is a SQLite knowledge graph of every symbol, edge and file in the workspace, and it answers architecture questions from that index instead of re-reading the tree.',
      source: 'server', toolCount: 0,
    },
    aboutLabel: '来自服务器自身的说明（MCP initialize）',
  },
  {
    name: 'tayily-mcp', serverName: 'tayily-mcp', transport: 'stdio', source: 'claude-desktop',
    enabled: true, connected: true, status: 'connected',
    about: { text: '工具：search、fetch、describe 等 4 个', source: 'tools', toolCount: 4 },
    aboutLabel: '根据该服务器已注册的工具推断',
  },
  {
    name: 'rea-cursor', serverName: 'rea-cursor', transport: 'stdio', source: 'cursor',
    enabled: true, connected: true, status: 'connected',
    about: { text: 'REA provides reverse-engineering tools for local artifacts, native binaries, managed code, browser pages, and runtimes.', source: 'server', toolCount: 0 },
    aboutLabel: '来自服务器自身的说明（MCP initialize）',
  },
  {
    name: 'cold-server', serverName: 'cold-server', transport: 'stdio', source: 'vscode',
    enabled: false, connected: false, status: 'stopped', about: null, aboutLabel: '',
  },
];

// The GitHub card in the state the prose describes: a census that read 1758
// rows, and a recovery walk stopped by hand after 77 of a planned 2111.
const CENSUS = {
  rows: 1758, at: '2026-10-16T09:30:00.000Z', complete: true, partial: null, requests: 41,
  walking: false, progress: null, ended: null, loaded: true, damaged: null,
};
const EVIDENCE = {
  rows: 77, withCommand: 54, at: '2026-10-16T09:40:00.000Z', requests: 260,
  partial: '已手动停止（已试 77 个仓库，下次接着走）', walking: false, progress: null,
  ended: { reason: 'user', at: '2026-10-16T09:40:00.000Z' },
  plan: { at: '2026-10-16T09:40:00.000Z', planned: 2111, attempted: 77, remaining: 2034, retries: 3, requests: 260, stopped: 'user' },
  complete: false, loaded: true, damaged: null,
};
const AUTH = {
  source: 'panel', inUse: true, masked: 'ghp_01…wxyz', login: 'harness-user',
  scopes: ['read:user'], rateLimit: { limit: 5000, remaining: 4992, resetAt: '2026-10-16T11:00:00.000Z' },
  storedAt: '2026-10-16T08:00:00.000Z', checkedAt: '2026-10-16T10:00:00.000Z',
};
const STATUS = {
  plugin: {
    id: 'dsh-overall-mcp', version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
    dir: 'C:/dsh/plugins/dsh-overall-mcp', loadedAt: '2026-10-16T07:00:00.000Z',
    source: { newestAt: '2026-10-16T07:00:00.000Z', stale: false, files: [{ name: 'index.js', at: '2026-10-16T07:00:00.000Z', bytes: 120 }] },
  },
  host: {
    pid: 4242, startedAt: '2026-10-16T07:00:00.000Z', uptimeMs: (3 * 3600 + 12 * 60) * 1000,
    node: 'v24.15.0', electron: '38.0.0', platform: 'win32', arch: 'x64',
  },
  data: {
    dir: 'C:/dsh/overall-mcp',
    files: [
      { name: 'registry.json', bytes: 4096, at: '2026-10-16T09:00:00.000Z' },
      { name: 'github-index.json', bytes: 1775060, at: '2026-10-16T09:30:00.000Z' },
      { name: 'github-install.json', bytes: 20480, at: '2026-10-16T09:40:00.000Z' },
    ],
  },
  events: { bytes: 512, at: '2026-10-16T10:00:02.000Z', lines: 2, damaged: 0, lastAt: '2026-10-16T10:00:02.000Z' },
  errors: { registry: '', sources: '' },
  quota: { remaining: 4992, limit: 5000, resetMs: 0 },
  auth: AUTH, census: CENSUS, evidence: EVIDENCE,
};

let captured = null;
// The client injects its stylesheet at runtime (`ensureStyles`); a naive DOM
// stub would drop it and the pictures would show an unstyled page.
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
  if (p.startsWith('/servers')) return ok({ servers: REGISTERED.map((s) => ({ ...s })) });
  if (p.startsWith('/repo-stats')) return ok({ stats: STATS });
  if (p.startsWith('/repo-media')) return ok({ media: MEDIA });
  if (p.startsWith('/status')) return ok(STATUS);
  if (p.startsWith('/updates')) return ok({ updates: [] });
  if (p.startsWith('/favorites')) return ok({ favorites: [] });
  if (p.startsWith('/events')) return ok({ total: 2, damaged: 0, events: [] });
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

// --- descriptor → HTML (same rules as tools/shot.mjs) ----------------------
const UNITLESS = new Set([
  'lineHeight', 'fontWeight', 'flexGrow', 'flexShrink', 'opacity', 'zIndex',
  'WebkitLineClamp', 'order', 'zoom', 'columns', 'columnCount', 'flex',
]);
const kebab = (k) => (k.startsWith('Webkit')
  ? `-webkit-${k[6].toLowerCase()}${k.slice(7).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
  : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
const cssText = (style) => Object.entries(style)
  .filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => `${kebab(k)}:${typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : v}`)
  .join(';');
const ATTR_SKIP = new Set(['key', 'children', 'onClick', 'onKeyDown', 'onLoad', 'onError', 'onChange', 'onInput', 'ref', 'role', 'tabIndex']);
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

const SHELL = `
  *{box-sizing:border-box}
  /* The panel animates its entrance (the detail overlay fades in). A still
     picture taken mid-transition shows a half-transparent panel, so every
     animation is collapsed to its end state before the screenshot. */
  *,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}
  body{margin:0;background:#f5f5f5;color:#111;font:13.5px/1.55 "Inter",ui-sans-serif,-apple-system,system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
  button,input,select{font:inherit}
  .wrap{max-width:1180px;margin:0 auto;padding:20px 20px 60px}
  img{max-width:none}
`;

/**
 * The plugin's own mark — the constellation hub the sidebar draws next to
 * 全局 MCP — hand-mirrored from `brandMark` in `client/client.js` (`g` spokes at
 * 1.6, five satellites, one accent hub at `T.brand`), because a README cannot
 * import a React component.
 *
 * Two deliberate departures from the rail's glyph:
 *   - the hub keeps the brand blue but the mark sits on a light chip, so a
 *     near-black constellation still reads on GitHub's dark theme;
 *   - the canvas is square with padding, so the mark is not cropped by the
 *     rounded chip.
 * Written to docs/images/icon.svg (the editable source) and icon.png (what the
 * READMEs link to: a few renderers still refuse SVG).
 */
const ICON_CHIP = '#f1f3f9';
const ICON_INK = '#1f2430';
const ICON_BRAND = '#4d6bfe';
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<rect width="256" height="256" rx="56" fill="${ICON_CHIP}"/>
<g transform="translate(40 40) scale(5.5)">
<g fill="none" stroke="${ICON_INK}" stroke-width="1.6" stroke-linecap="round">
<path d="M16 16 L8 8 M16 16 L24 8 M16 16 L7 20 M16 16 L25 20 M16 16 L16 26"/>
</g>
<circle cx="16" cy="16" r="3.2" fill="${ICON_BRAND}"/>
<circle cx="8" cy="8" r="2.2" fill="${ICON_INK}"/>
<circle cx="24" cy="8" r="2.2" fill="${ICON_INK}"/>
<circle cx="7" cy="20" r="2" fill="${ICON_INK}"/>
<circle cx="25" cy="20" r="2" fill="${ICON_INK}"/>
<circle cx="16" cy="26" r="2" fill="${ICON_INK}"/>
</g>
</svg>`;

await mkdir(outDir, { recursive: true });
const scratch = path.join(os.tmpdir(), 'dsh-readme-shots');
await mkdir(scratch, { recursive: true });
// The client resizes repository pictures through images.weserv.nl and only
// falls back to the original URL from an `onError` handler. A static picture
// cannot fire that handler, and a headless run has no network, so every strip
// would show a broken image. This rewrites the proxy wrapper back to the URL it
// wrapped — a picture-only concern: the panel itself is untouched, and the
// fallback it implements is exactly the behaviour being simulated.
const unproxy = (html) => html.replace(
  // toHtml escapes `&` as `&amp;`, so the query separators may arrive escaped.
  /https:\/\/images\.weserv\.nl\/\?url=([^&"]+)&(?:amp;)?h=\d+&(?:amp;)?fit=inside&(?:amp;)?we=1/g,
  (_whole, enc) => decodeURIComponent(enc),
);
const shot = async (name, html, width, height) => {
  // The intermediate HTML goes to the OS temp directory, not next to the PNG:
  // docs/images/ should hold the pictures and nothing else.
  const file = path.join(scratch, `${name}.html`);
  const png = path.join(outDir, `${name}.png`);
  await writeFile(file, unproxy(html), 'utf8');
  await execFileP(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=1', `--window-size=${width},${height}`,
    '--virtual-time-budget=2500', '--default-background-color=00000000',
    `--screenshot=${png}`,
    `file:///${file.replace(/\\/g, '/')}`,
  ], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return png;
};

// The icon first: it is a picture of the plugin's own mark, and the README
// shows it above everything else. Both files are written so a reader who wants
// to edit the mark has the SVG, and the README gets a PNG that any renderer
// will show.
await writeFile(path.join(outDir, 'icon.svg'), `${ICON}\n`, 'utf8');
const iconPng = await shot('icon', `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:transparent}</style>${ICON}`, 256, 256);

let tree = await render();
const page = (title, node) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>${SHELL}</style><style>${sheetTexts.join('\n')}</style><div class="wrap">${toHtml(node)}</div>`;

// 1. 已注册 — the tab that opens first, GitHub access card included.
const registered = page('registered', tree);
// 2. MCP 市场 — the aggregation, its three chrome rows and the card wall.
const marketTab = walk(tree).filter((n) => n.type === 'button' && textOf(n).startsWith('MCP 市场'));
if (!marketTab.length) throw new Error('market tab button not found');
marketTab[0].props.onClick();
tree = await render();
const market = page('market', tree);
// 3. 详情 — one card opened, so the picture shows what is behind 详情.
const detailBtn = walk(tree).find((n) => n.type === 'button' && textOf(n) === '详情'
  && (n.props?.className ?? '').includes('omkt-btn'));
if (!detailBtn) throw new Error('detail button not found');
detailBtn.props.onClick({ stopPropagation() {} });
tree = await render();
const detail = page('detail', tree);

const shots = [
  iconPng,
  await shot('registered', registered, 1180, 760),
  await shot('market', market, 1180, 1560),
  await shot('detail', detail, 1180, 1120),
];
for (const p of shots) console.log(p);
console.log(`\n${shots.length} picture(s) for the READMEs — commit docs/images/ to update them`);
