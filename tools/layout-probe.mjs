// tools/layout-probe.mjs — measure real card geometry in headless Chrome.
//
// The bug this guards: a long name ("AFG: agents hire agents (test money)")
// pushed the install/detail buttons past the card's right edge. Inline styles
// and fake React trees cannot reproduce a box-sizing bug — CSS layout only
// happens in a real engine — so this renders genuine MarketCard output to
// HTML, drives Chrome at it, and asserts on the measured rectangles.
//
// Measured, before the fix: CTA at x=760..814 while the card ended at 284,
// title 727px wide, never clamped. After: CTA inside the card, title ellipsized.
//
// Usage: node tools/layout-probe.mjs   (CHROME_PATH overrides the binary)
// Exits non-zero on FAIL so it can sit in a test script.
import { readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'client', 'client.js');

const reactStub = {
  createElement: (type, props, ...children) => {
    const p = props ?? {};
    // Expand function components: a stub that only records the type hides
    // everything the component renders (MarketCard's preview strip).
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
globalThis.document = undefined; // ensureStyles must not run under a stub
const code = await readFile(bundlePath, 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', 'require', code)(globalThis.window, requireShim);
const { __test } = captured.factory(requireShim);

const UNITLESS = new Set([
  'lineHeight', 'fontWeight', 'flexGrow', 'flexShrink', 'opacity', 'zIndex',
  'WebkitLineClamp', 'order', 'zoom',
]);
// The vendor prefix comes off the name: a `slice(8)` here ate the `l` and
// emitted `-webkit-ineClamp`, which the browser drops — the probe then measured
// a description that was never clamped and called it clamped.
const kebab = (k) => (k.startsWith('Webkit')
  ? `-webkit-${k[6].toLowerCase()}${k.slice(7).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
  : k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
const cssText = (style) => Object.entries(style)
  .filter(([, v]) => v != null && v !== '')
  .map(([k, v]) => `${kebab(k)}:${typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : v}`)
  .join(';');
// `key` is a React concept, not an attribute; the rest are event handlers.
// `style` must NOT be skipped — it is the entire point of the fixture.
const ATTR_SKIP = new Set(['key', 'children', 'onClick', 'onKeyDown', 'onLoad', 'onError', 'ref']);

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
    if (k === 'tabIndex') { attrs.push(`tabindex="${v}"`); continue; }
    attrs.push(`${k}="${String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`);
  }
  const open = `<${type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  if (['img', 'input', 'br', 'hr'].includes(type)) return open;
  return `${open}${toHtml(node.children)}${toHtml(props?.children)}</${type}>`;
}

/** The three shapes that historically overflowed a 268px column. */
const items = [
  {
    name: 'long title + installable',
    item: {
      id: 'official:ai.afg/afg',
      title: 'AFG: agents hire agents (test money) — sandbox marketplace where AI agents hire other agents',
      source: 'official-registry', author: 'ai.afg',
      description: 'Sandbox marketplace where AI agents hire agents verified outcomes.',
      version: '1.0.0', transport: 'http', url: 'https://afg.ai/mcp',
      repository: 'https://github.com/ai/afg', official: true,
      installable: true, installed: false,
      installs: 87579, installsLabel: '次启动', updatedAt: '2026-09-26T00:00:00Z',
    },
  },
  {
    name: 'long title + deprecated + manual config',
    item: {
      id: 'awesome:o/r', title: 'A ridiculously long server name that nobody truncated for us',
      source: 'awesome-list', author: 'someone', transport: 'unknown', install: null,
      description: 'No install command, plus a lifecycle badge and a status note.',
      deprecated: true, statusMessage: '上游已归档，不再维护。',
      installable: false, installed: false,
    },
  },
  {
    name: 'absurd title + installed',
    item: {
      id: 'smithery:s/s', title: 'X'.repeat(160),
      source: 'smithery', author: 'smithery-ai', version: '0.4.1', transport: 'stdio',
      description: 'Installed already, so the CTA column renders a badge instead.',
      official: true, installable: true, installed: true,
    },
  },
];

const cards = items.map(({ item }) => __test.MarketCard({
  item, stats: {}, media: {}, busy: false,
  onInstall: () => {}, onOpen: () => {}, onToggleFavorite: () => {},
}));

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  body{margin:0;padding:16px;background:#f5f5f5;font-family:system-ui,sans-serif}
  /* The real market uses CSS columns; each card's *geometry* is just a
     ~268px box, and box geometry is what this probe is about — so the fixture
     states it directly instead of asking multicol to reproduce it too. */
  .col{width:268px;display:inline-block;vertical-align:top;margin-right:14px;overflow:hidden}
  #probe{position:fixed;left:0;top:0;font-size:13px;padding:6px 10px;color:#fff;z-index:9}
</style>
<div id="probe">PENDING</div>
<div id="grid">
${cards.map((c) => `  <div class="col">${toHtml(c)}</div>`).join('\n')}
</div>
<script>
(function () {
  const probe = document.getElementById('probe');
  try {
    const cards = [...document.querySelectorAll('article.omkt-card')];
    if (cards.length !== ${cards.length}) throw new Error('expected ${cards.length} cards, got ' + cards.length);
    const perCard = cards.map((card, i) => {
      const body = card.firstElementChild;
      const hd = body.firstElementChild;
      const cta = hd.querySelector(':scope > div:last-child');
      // The title is an anchor only when the catalog gave us a URL; otherwise
      // it is the bare first child of the header's left column
      // (hd > left column > name row > title).
      const title = card.querySelector('a.omkt-title')
        || hd.querySelector(':scope > div:first-child > :first-child > :first-child');
      if (!cta || !title) throw new Error('card ' + i + ': missing cta/title node');
      const c = card.getBoundingClientRect();
      const r = cta.getBoundingClientRect();
      const t = title.getBoundingClientRect();
      const cs = getComputedStyle(title);
      return {
        ctaInside: r.right <= c.right + 0.5 && r.left >= c.left - 0.5,
        titleInside: t.right <= c.right + 0.5,
        // A long name must be *truncated*, not stretched: nowrap + ellipsis is
        // the CSS contract that keeps one server's name from taking the row.
        truncating: cs.whiteSpace === 'nowrap' && cs.textOverflow === 'ellipsis',
        // …and when the text really is wider than its box, the box stayed put
        // and the text overflowed it (scrollWidth), which is what ellipsis
        // turns into a visible "…".
        clamped: title.clientWidth > 0 && title.scrollWidth > title.clientWidth + 1,
        box: { w: Math.round(c.width), right: Math.round(c.right) },
        cta: { left: Math.round(r.left), right: Math.round(r.right) },
        title: { w: Math.round(t.width), scroll: title.scrollWidth },
      };
    });
    // Every card must keep its actions inside and clamp long names; the
    // 160-character name additionally proves the clamp actually engages.
    const ok = perCard.every((m) => m.ctaInside && m.titleInside && m.truncating)
      && perCard[perCard.length - 1].clamped;
    probe.textContent = JSON.stringify({ verdict: ok ? 'PASS' : 'FAIL', perCard });
    probe.style.background = ok ? '#16a34a' : '#dc2626';
    document.title = ok ? 'PASS' : 'FAIL';
  } catch (e) {
    probe.textContent = 'ERROR ' + (e && e.message);
    probe.style.background = '#dc2626';
    document.title = 'FAIL';
  }
})();
</script>
`;

const fixturePath = path.join(here, '_layout-fixture.html');
await writeFile(fixturePath, html, 'utf8');

const chrome = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const url = `file:///${fixturePath.replace(/\\/g, '/')}`;
let dom = '';
try {
  const { stdout } = await execFileP(chrome, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1000,800',
    '--virtual-time-budget=3000', '--dump-dom', url,
  ], { maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  dom = stdout;
} catch (err) {
  console.error(`chrome failed: ${err.message}`);
  process.exit(2);
}

const m = /<div id="probe"[^>]*>([\s\S]*?)<\/div>/.exec(dom);
const body = m ? m[1] : '';
console.log(body);
if (!m || body === 'PENDING' || body.startsWith('ERROR')) {
  console.error('layout probe could not measure the fixture');
  process.exit(2);
}
let verdict;
try { verdict = JSON.parse(body); } catch { verdict = { verdict: 'FAIL' }; }
await rm(fixturePath, { force: true });
if (verdict.verdict !== 'PASS') {
  console.error('layout probe FAILED — card overflow is back');
  process.exit(1);
}
console.log('layout probe: title clamps, actions stay inside the card');
