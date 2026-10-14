// tools/render-card.mjs — render MarketCard against a fake React tree.
//
// The card body used to be a <button> with the repo link beside it. When the
// title became the front-door link, a nested <a> inside <button> would have
// raced the click handler instead of navigating — the exact "链接不可直达"
// bug. These assertions walk the real element tree and fail on that shape:
// interactive elements must never nest inside another interactive element,
// and the title must be the anchor when the catalog offers any URL.
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
globalThis.document = undefined; // ensureStyles must not run under a stub
const code = await readFile(bundlePath, 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', 'require', code)(globalThis.window, requireShim);
const { __test } = captured.factory(requireShim);
assert.ok(__test?.MarketCard, 'client exports __test.MarketCard');

function walk(node, out = []) {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out; }
  if (node && typeof node === 'object' && 'type' in node) {
    out.push(node);
    walk(node.children, out);
    walk(node.props?.children, out);
  }
  return out;
}
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
/** Interactive kinds that must never nest inside one another. */
const INTERACTIVE = new Set(['a', 'button']);
function interactiveAncestor(node) { return INTERACTIVE.has(node.type); }

const samples = [
  {
    name: 'official (repo + site): title links the repo',
    item: {
      id: 'official:ac.snag/snag', title: 'snag', source: 'official-registry', author: 'ac.snag',
      description: 'Evidence capture.', version: '1.0.0', transport: 'stdio',
      group: '开发工具', category: 'Developer Tools', tags: ['npm'],
      install: { transport: 'stdio', command: 'npx', args: ['-y', '@snag/mcp'] },
      repository: 'https://github.com/snag/mcp', homepage: 'https://snag.ac',
      official: true, installable: true, installed: false,
    },
    titleHref: 'https://github.com/snag/mcp', installable: true,
    chips: ['开发工具', 'stdio · npx'],
  },
  {
    name: 'awesome-list (repo only): title links the repo',
    item: {
      id: 'awesome:gatyh/3dtexel-mcp', title: '3dtexel-mcp', source: 'awesome-list', author: 'Gatyh',
      description: '3D texels.', transport: 'unknown', install: null,
      group: '游戏娱乐', category: 'Art & Culture',
      repository: 'https://github.com/Gatyh/3dtexel-mcp', tags: ['Art & Culture'],
      installable: false, installed: false,
    },
    titleHref: 'https://github.com/Gatyh/3dtexel-mcp', installable: false,
    chips: ['游戏娱乐', '需手动配置'],
  },
  {
    name: 'smithery (no repo): title links the registry listing',
    item: {
      id: 'smithery:brave', title: 'Brave Search', source: 'smithery', author: 'brave',
      description: 'Web search.', transport: 'stdio', group: '搜索与知识',
      install: { transport: 'stdio', command: 'npx', args: ['-y', '@smithery/cli', 'run', 'brave'] },
      qualifiedName: 'brave', verified: true, installable: true, installed: false,
      tags: ['托管', '搜索与知识'],
    },
    titleHref: 'https://smithery.ai/servers/brave', installable: true,
    chips: ['搜索与知识', 'stdio · npx'],
  },
  {
    name: 'registry entry without a category: 未分类 is stated, not omitted',
    item: {
      id: 'official:ai.example/remote', title: 'Remote Thing', source: 'official-registry',
      description: 'Hosted.', transport: 'http', tags: ['pypi'],
      install: { transport: 'http', url: 'https://mcp.example/mcp' },
      homepage: 'https://mcp.example',
      official: true, installable: true, installed: false,
    },
    titleHref: 'https://mcp.example', installable: true,
    chips: ['未分类', '远程 · 免安装'],
  },
];

for (const { name, item, titleHref, installable, chips } of samples) {
  const tree = __test.MarketCard({
    item, stats: {}, media: {}, busy: false, onInstall: () => {}, onOpen: () => {},
    onToggleFavorite: () => {},
  });
  const nodes = walk(tree);
  const anchors = nodes.filter((n) => n.type === 'a');

  // 1. The title IS the link (the dshmarket shape), pointing where promised.
  const title = anchors.find((a) => textOf(a) === item.title);
  assert.ok(title, `${name}: title is not an anchor (front-door link missing)`);
  assert.equal(title.props.href, titleHref, `${name}: title links ${title.props.href}`);
  assert.equal(title.props.target, '_blank', `${name}: title link opens in place`);
  assert.equal(title.props.rel, 'noreferrer', `${name}: title link missing rel`);
  // The anchor must not fall through to the card's open handler.
  assert.equal(typeof title.props.onClick, 'function', `${name}: title link does not stop propagation`);

  // 2. No interactive element ever nests inside another. A link inside a
  //    button is the "链接不可直达" bug: the click races the navigation.
  const deep = walk(tree);
  for (const n of deep) {
    if (!INTERACTIVE.has(n.type)) continue;
    const inner = deep.filter((m) => INTERACTIVE.has(m.type) && m !== n
      && contains(deep, n, m));
    for (const m of inner) {
      assert.fail(`${name}: <${m.type}> nested inside <${n.type}>`);
    }
  }
  // 2b. The footer leads with the two facts a reader wants — the functional
  //     group and how it installs — and never with a source's hosting note.
  //     「托管」/「本地」/package-manager tags are exactly what the chips used
  //     to be, and they answer neither question.
  const footer = deep.find((n) => n.type === 'div' && n.props?.key === 'ft');
  assert.ok(footer, `${name}: card footer missing`);
  const footerSpans = walk(footer).filter((n) => n.type === 'span'
    && typeof n.props?.title === 'string');
  const semantic = footerSpans
    .filter((n) => /^(分类|安装方式)：/.test(n.props.title))
    .map((n) => ({ text: textOf(n), title: n.props.title }));
  assert.deepEqual(semantic.map((c) => c.text), chips,
    `${name}: footer chips are ${JSON.stringify(semantic.map((c) => c.text))}`);
  assert.match(semantic[0]?.title ?? '', /^分类：/, `${name}: first chip is not the taxonomy`);
  assert.match(semantic[1]?.title ?? '', /^安装方式：/, `${name}: second chip is not the install method`);
  const shown = [...semantic.map((c) => c.text),
    ...footerSpans.filter((n) => n.props.title.startsWith('上游标签：')).map(textOf)];
  for (const banned of ['托管', '本地', 'npm', 'pypi']) {
    assert.ok(!shown.includes(banned),
      `${name}: a hosting/registry tag (${banned}) is still rendered as a chip`);
  }
  function contains(nodes, outer, inner) {
    // Walk outer's subtree; inner must not be outer itself.
    let found = false;
    const visit = (n) => {
      if (found || n === inner && n !== outer) { found = true; return; }
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (n && typeof n === 'object') { visit(n.children); visit(n.props?.children); }
    };
    visit(outer.children);
    visit(outer.props?.children);
    return found;
  }

  // 3. The card body is NOT a button (that is what made nesting possible).
  const body = deep.find((n) => n.props?.key === 'body');
  assert.ok(body, `${name}: card body missing`);
  assert.notEqual(body.type, 'button', `${name}: card body is a button again`);
  assert.equal(body.type, 'div', `${name}: card body is not a div`);
  assert.equal(typeof body.props.onClick, 'function', `${name}: body does not open detail`);

  // 4. Install affordance matches installability.
  const buttons = deep.filter((n) => n.type === 'button');
  const installBtn = buttons.find((b) => textOf(b) === '安装');
  const detailBtn = buttons.find((b) => textOf(b) === '详情');
  assert.ok(detailBtn, `${name}: detail button missing`);
  if (item.installed) assert.ok(!installBtn, `${name}: installed entry still offers install`);
  else if (installable) assert.ok(installBtn, `${name}: installable entry offers no install`);
  else assert.ok(!installBtn, `${name}: non-installable entry still offers install`);

  console.log(`ok  ${name} — title anchor, body div, no nested interactive`);
}

// ---- 5. the facts the card states statically -----------------------------
// The prototype shows these as plain facts on the card face. They must be
// present as text, not hidden behind a rotating strip: a figure you have to
// wait for is a figure you cannot compare.
{
  const item = {
    id: 'official:ac.snag/snag', title: 'snag', source: 'official-registry', author: 'ac.snag',
    description: 'Evidence capture.', version: '1.0.0', transport: 'stdio',
    install: { transport: 'stdio', command: 'npx', args: ['-y', '@snag/mcp'] },
    repository: 'https://github.com/snag/mcp', updatedAt: '2026-03-11T00:00:00Z',
    installs: 87579, installsLabel: '次启动', installable: true, installed: false,
  };
  const stats = { 'snag/mcp': { stars: 22400, forks: 12, pushedAt: '2026-03-11T00:00:00Z', license: 'MIT' } };
  const text = textOf(__test.MarketCard({
    item, stats, media: {}, busy: false, onInstall: () => {}, onOpen: () => {},
    onToggleFavorite: () => {},
  }));
  assert.match(text, /22\.4k/, 'star count missing from the card face');
  assert.match(text, /87\.5k/, 'install count missing from the card face');
  assert.match(text, /更新于 2026-03-11/, 'update date missing from the card face');
  // v4 puts the transport in a small compatibility chip and keeps the shell
  // command for the detail panel. The card must still say WHICH KIND of thing
  // this is — the chip is that statement — but a wall of monospace on every
  // card is exactly what the prototype drops.
  assert.match(text, /MCP · stdio/, 'compatibility chip missing from the card face');
  assert.doesNotMatch(text, /npx -y @snag\/mcp/, 'the install command belongs to the detail panel, not the card');
  console.log('ok  card face states Star / 使用量 / 更新时间 / 传输 as static facts, command stays in the panel');
}

// ---- 6. the preview strip shows the repository's own pictures ------------
// The carousel slot v4 reserves for a preview carries README screenshots (or
// GitHub's social card when there are none). It must scroll, never rotate:
// nothing in the tree may schedule a change, and the images must be real URLs
// fetched through the same resize proxy the plugin market uses.
{
  const item = {
    id: 'awesome:x/y', title: 'y', source: 'awesome-list', author: 'x',
    description: 'd', repository: 'https://github.com/x/y', transport: 'stdio',
    install: { transport: 'stdio', command: 'npx', args: ['-y', 'y'] },
    installable: true, installed: false,
  };
  const media = {
    'x/y': {
      images: [
        { url: 'https://raw.githubusercontent.com/x/y/HEAD/docs/a.png', alt: '架构图' },
        { url: 'https://raw.githubusercontent.com/x/y/HEAD/docs/b.png', alt: '' },
      ],
      og: null,
    },
  };
  const tree = __test.MarketCard({
    item, stats: {}, media, busy: false, onInstall: () => {}, onOpen: () => {},
    onToggleFavorite: () => {},
  });
  const nodes = walk(tree);
  const imgs = nodes.filter((n) => n.type === 'img');
  assert.equal(imgs.length, 2, `expected one <img> per README picture, got ${imgs.length}`);
  // v4 sizes the carousel slide at ~72% of the card, which on a 370px column
  // is ~166px tall; the strip asks the proxy for a 2x copy of that.
  assert.equal(imgs[0].props.src,
    'https://images.weserv.nl/?url=raw.githubusercontent.com%2Fx%2Fy%2FHEAD%2Fdocs%2Fa.png&h=332&fit=inside&we=1',
    'picture is not fetched through the resize proxy');
  assert.equal(imgs[0].props.alt, '架构图', 'picture alt is dropped');
  assert.ok(imgs[1].props.loading === 'lazy' || imgs[1].props.loading === 'eager',
    'picture has no loading strategy');
  // Two pictures => the manual nav buttons appear; one => they do not.
  const navs = nodes.filter((n) => n.type === 'button' && (textOf(n) === '‹' || textOf(n) === '›'));
  assert.equal(navs.length, 2, 'nav buttons missing for a multi-picture strip');
  // No autoplay: the strip scrolls by hand, so nothing may be scheduled.
  const timers = nodes.filter((n) => n.props?.onMouseEnter && typeof n.props.onMouseEnter === 'function'
    && textOf(n) === '');
  assert.equal(timers.length, 0, 'strip registers hover handlers that imply auto-advance');
  console.log('ok  preview strip: README pictures, resize proxy, manual nav, no autoplay');
}

// ---- 7. the social card is the fallback, and nothing is invented ---------
{
  const item = {
    id: 'awesome:x/z', title: 'z', source: 'awesome-list', author: 'x',
    description: 'd', repository: 'https://github.com/x/z', transport: 'stdio',
    install: { transport: 'stdio', command: 'npx', args: ['-y', 'z'] },
    installable: true, installed: false,
  };
  const withCard = walk(__test.MarketCard({
    item, stats: {}, media: { 'x/z': { images: [], og: 'https://opengraph.githubassets.com/x/z' } },
    busy: false, onInstall: () => {}, onOpen: () => {}, onToggleFavorite: () => {},
  })).filter((n) => n.type === 'img');
  assert.equal(withCard.length, 1, 'social card not used as the fallback picture');
  assert.match(withCard[0].props.src, /opengraph\.githubassets\.com/, 'fallback is not the repo social card');

  const bare = walk(__test.MarketCard({
    item, stats: {}, media: { 'x/z': { images: [], og: null } },
    busy: false, onInstall: () => {}, onOpen: () => {}, onToggleFavorite: () => {},
  })).filter((n) => n.type === 'img');
  assert.equal(bare.length, 0, 'a repo with no pictures gets an invented one');
  console.log('ok  fallback: GitHub social card, then nothing at all');
}
// ---- 6. the two v4-prototype details on the card face --------------------
// The prototype puts a GitHub mark beside the title and the published version
// at the end of the author row. Both were missing, and both are cheap to lose
// again — a refactor that rewrites the name row would silently drop them.
{
  const repoItem = {
    id: 'official:ac.snag/snag', title: 'snag', source: 'official-registry', author: 'ac.snag',
    description: 'Evidence capture.', version: '1.0.0', transport: 'stdio',
    install: { transport: 'stdio', command: 'npx', args: ['-y', '@snag/mcp'] },
    repository: 'https://github.com/snag/mcp', official: true, installable: true, installed: false,
  };
  const nodes = walk(__test.MarketCard({
    item: repoItem, stats: {}, media: {}, busy: false,
    onInstall: () => {}, onOpen: () => {}, onToggleFavorite: () => {},
  }));

  const marks = nodes.filter((n) => n.type === 'a' && n.props?.className === 'omkt-gh');
  assert.equal(marks.length, 1, 'repo-backed card has no GitHub mark beside the title');
  assert.equal(marks[0].props.href, repoItem.repository, 'GitHub mark links somewhere else');
  assert.equal(marks[0].props.target, '_blank', 'GitHub mark opens in place');
  assert.equal(typeof marks[0].props.onClick, 'function', 'GitHub mark does not stop propagation');
  assert.equal(marks[0].children?.type ?? marks[0].children?.[0]?.type, 'svg',
    'GitHub mark is not drawn (icon font / missing glyph)');

  const version = nodes.find((n) => textOf(n) === 'v1.0.0');
  assert.ok(version, 'published version is not shown in the author row');

  // A repository that is not a GitHub repo must NOT get the mark: Smithery's
  // `repository` field points at its own listing, and an octocat promises GitHub.
  const noRepo = walk(__test.MarketCard({
    item: { ...repoItem, source: 'smithery', repository: 'https://smithery.ai/server/@brave/brave-search', version: null },
    stats: {}, media: {}, busy: false,
    onInstall: () => {}, onOpen: () => {}, onToggleFavorite: () => {},
  }));
  assert.equal(noRepo.filter((n) => n.props?.className === 'omkt-gh').length, 0,
    'non-GitHub repository still shows the GitHub mark');
  assert.equal(noRepo.filter((n) => textOf(n) === 'vnull').length, 0,
    'absent version rendered as text');
  console.log('ok  prototype face: GitHub mark beside title, version in author row');
}

console.log('\ncard renders: title links, no nested interactives, actions sane');
