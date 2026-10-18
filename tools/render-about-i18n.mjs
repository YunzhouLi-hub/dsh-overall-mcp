// tools/render-about-i18n.mjs — 每行的用途说明按页面语言显示.
//
// The purpose line is the server's own prose (lib/about.js), so a Chinese panel
// otherwise shows an English sentence in a Chinese row. The swap happens in a
// pure function — `localizeRows(rows, translations, lang)` — which is exactly
// what this probe feeds: a server line with a translation, a server line without
// one, and the two lines that must never be touched (the plugin's own 工具：…
// line and a launch command). Rendering a row as well proves the original wording
// survives in the tooltip instead of being replaced by the translation.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'client', 'client.js');

const reactStub = {
  createElement: (type, props, ...children) => {
    const p = props ?? {};
    if (typeof type === 'function') return type({ ...p, children });
    return { type, props: p, children };
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  Component: class {
    constructor(props) { this.props = props; this.state = {}; }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }; }
    render() { return null; }
  },
};
const requireShim = (id) => {
  if (id === 'react') return reactStub;
  throw new Error(`unexpected module request: ${id}`);
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
const code = await readFile(bundlePath, 'utf8');
new Function('window', 'require', code)(globalThis.window, requireShim);
const { __test } = captured.factory(requireShim);
assert.ok(__test?.localizeRows, 'client exports __test.localizeRows');
assert.ok(__test?.ServerRow, 'client exports __test.ServerRow');

const { localizeRows, aboutKey } = __test;

function walk(node, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (node && typeof node === 'object' && 'type' in node) {
    out.push(node);
    walk(node.children, out);
  }
  return out;
}
const textOf = (node) => {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object' && 'children' in node) return textOf(node.children);
  return '';
};

const lang = 'zh-cn';
const SOURCE = 'Tools for reading docs. Use read_page for a page by path.';
const ZH = '读取文档的工具。用 read_page 按路径取一页。';

// ---- 1. only the server's own prose is replaced ----------------------------
const translations = { [aboutKey(lang, SOURCE)]: ZH };
const rows = localizeRows([
  { name: 'docs', about: { text: SOURCE, source: 'server', toolCount: 0 } },
  { name: 'other', about: { text: 'Searches the web.', source: 'server', toolCount: 0 } },
  { name: 'tools-row', about: { text: '工具：read、write 等 2 个', source: 'tools', toolCount: 2 } },
  { name: 'cmd-row', about: { text: 'npx -y @scope/pkg --flag', source: 'command', toolCount: 0 } },
  { name: 'bare' },
], translations, lang);

assert.equal(rows[0].about.text, ZH, 'a translated server line is shown in the page language');
assert.equal(rows[0].about.original, SOURCE, 'the original wording is kept, not overwritten');
assert.equal(rows[1].about.text, 'Searches the web.', 'a line with no translation keeps the server words');
assert.equal(rows[1].about.original, undefined);
assert.equal(rows[2].about.text, '工具：read、write 等 2 个', 'this plugin’s own Chinese line is not translated');
assert.equal(rows[3].about.text, 'npx -y @scope/pkg --flag', 'a command line stays a command line');
assert.equal(rows[4].about, undefined, 'a row without a purpose line survives the map');
assert.deepEqual(rows.map((r) => r.name), ['docs', 'other', 'tools-row', 'cmd-row', 'bare'], 'order is preserved');

// A translation for another language must not leak into this one.
const wrongLang = localizeRows([{ name: 'docs', about: { text: SOURCE, source: 'server', toolCount: 0 } }],
  { [aboutKey('ja', SOURCE)]: 'ドキュメント。' }, lang);
assert.equal(wrongLang[0].about.text, SOURCE, 'the language is part of the cache key');

// Degenerate inputs: a bad map or a non-array must not throw inside a render.
assert.doesNotThrow(() => localizeRows(null, translations, lang));
assert.equal(localizeRows([{ name: 'x', about: { text: SOURCE, source: 'server' } }], null, lang)[0].about.text, SOURCE);

// ---- 2. the row shows the translation and still quotes the source ----------
const rendered = walk(__test.ServerRow({
  server: {
    name: 'docs', transport: 'stdio', enabled: true, connected: true, status: 'connected',
    about: rows[0].about,
    aboutLabel: '来自服务器自身的说明（MCP initialize）',
  },
  busy: false,
  onToggle: () => {}, onRemove: () => {}, onUpdate: () => {},
  onConfigure: () => {}, onHealth: () => {},
}, []));
const aboutNode = rendered.find((node) => node.props?.className === 'omkt-sabout');
assert.ok(aboutNode, 'the row renders a purpose line');
assert.equal(textOf(aboutNode), ZH, 'the row reads in the page language');
assert.match(aboutNode.props.title, /来自服务器自身的说明/, 'the evidence label is still there');
assert.match(aboutNode.props.title, /Use read_page for a page by path/, 'the tooltip still quotes what the server wrote');

console.log('ok — 用途说明: only the server’s own prose is translated, the original stays in the tooltip, and the language is part of the key');
