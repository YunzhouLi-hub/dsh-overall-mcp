// tools/probe-submissions.mjs — 「申请收录」: a form, a local queue, a review.
//
// The user's request: 「要更改一下这个逻辑，点击收录之后要求填写名字和链接，或者上传
// 文件，我们会审核，审核如果发现确实是 MCP 服务，就会注册到我们的注册表里面，来源就
// 写个人贡献（如果对方写了名字，就写 *** 贡献）」. The page used to be a link out to
// the awesome-list — a pull request was the only way into a catalogue, and the local
// registry never heard about the submission at all. This probe renders the real
// Section against a fake React and pins the contract the new flow has to keep:
//
//   * 申请收录 opens a form (service name, link, optional note and submitter name,
//     optional attachment) instead of navigating away — and the upstream guide
//     is still reachable from inside that form, because 「个人贡献」 does not
//     replace the public catalogue, it feeds this machine's registry;
//   * a submission leaves the form as ONE request whose body carries every field,
//     including the attachment's bytes as base64 (a form that dropped the file
//     would still look right here, so the body is what gets asserted);
//   * the form stays open with its text when the host refuses it — a failed
//     upload must not cost the user what they typed;
//   * 投稿待审 lists what is waiting, with the note, the attachment's name and
//     size, and who sent it (未署名 when nobody signed);
//   * 通过 asks for the mountable information — because a submission only has a
//     name and a link, and a row with neither a command nor an endpoint would
//     try to spawn `undefined` — and the approval travels as an install payload
//     once it is filled in;
//   * leaving both fields empty is a REAL answer: 仅展示. It travels as
//     `install: null`, the host registers the row, and the page says 「仅展示」
//     rather than claiming a mount that will not happen (this is the case the
//     user's 「如果对方写了名字」 sentence is adjacent to: a name and a link are
//     sometimes all there is);
//   * 驳回 records why, and the reason stays visible on the decided line;
//   * a display-only registry row reads 仅展示, names its submitter, keeps its
//     来源 button (the link is the whole point of the row) and its 启用 switch
//     is dead — there is nothing behind it to start.
//
// Self-contained on purpose: the fake-React harness is copied rather than shared
// with the other probes, so a change in one render path cannot mask a regression
// here (that is the failure mode these files exist to catch).
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
  // Stable per frame, like the real thing: a ref that reset on every render
  // would let a double-click guard pass here while failing in the browser.
  useRef(initial) {
    const frame = frames[frames.length - 1];
    const i = frame.cursor++;
    if (!(i in frame.refs)) frame.refs[i] = { current: initial };
    return frame.refs[i];
  },
};
const requireShim = (id) => {
  if (id === 'react') return reactStub;
  throw new Error(`unexpected module request: ${id}`);
};

// --- a fake FileReader: the attachment travels as base64 --------------------
// The bytes are a stand-in for a real file; what matters is that they arrive.
const ATTACHMENT_TEXT = '{"name":"acme-mcp","version":"1.0.0"}';
const ATTACHMENT_B64 = Buffer.from(ATTACHMENT_TEXT, 'utf8').toString('base64');
globalThis.FileReader = class {
  readAsDataURL() {
    this.result = `data:application/json;base64,${ATTACHMENT_B64}`;
    queueMicrotask(() => this.onload());
  }
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
globalThis.document = {
  head: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, appendChild() {} }),
  getElementById: () => null,
};

// --- fixture: the host's queue, and the registry it writes into -------------
// `/servers` carries the queue (see serversPayload): one fetch tells the page
// both what is registered and what is waiting, which is why the queue updates
// the moment a decision lands without a second request.
const requests = [];
const PENDING = [
  {
    id: 'sub_0001', name: 'acme-mcp', link: 'https://github.com/acme/mcp-server',
    note: '给 Claude 用的示例服务', contributor: '', at: '2026-02-01T09:00:00.000Z',
    file: { name: 'manifest.json', bytes: 2048 }, status: 'pending',
  },
  {
    id: 'sub_0002', name: 'beta-mcp', link: 'https://example.com/beta-mcp',
    note: '', contributor: '王五', at: '2026-02-02T09:00:00.000Z',
    file: null, status: 'pending',
  },
];
const DECIDED = [];
// Two rows a previous review already produced, so the 「个人贡献」 rendering is
// checked against the registry itself and not only against the flow that wrote
// it: one mounted (a command was given), one display-only (only a link).
const SERVERS = [
  {
    name: 'lisi-mcp', serverName: 'lisi_mcp', transport: 'stdio', source: 'contribution',
    contributor: '李四', link: 'https://github.com/lisi/mcp-server',
    enabled: true, connected: true, slot: 0,
    entry: { command: 'npx', args: ['-y', 'lisi-mcp'] },
  },
  {
    name: 'zhangsan-link-only', serverName: 'zhangsan_link_only', transport: 'discovery',
    source: 'contribution', contributor: '张三', link: 'https://example.com/zhangsan-mcp',
    enabled: false, connected: false, displayOnly: true, slot: 1,
  },
];

const serversBody = () => ({
  servers: SERVERS,
  submissions: { items: [...PENDING, ...DECIDED], pending: PENDING.length },
});
/** The registry row an approval produces, mirroring lib/submissions.js. */
function contributionRow(item, body) {
  const install = body.install;
  const row = {
    name: body.name || item.name,
    serverName: String(body.name || item.name).replace(/[^A-Za-z0-9_]/g, '_'),
    source: 'contribution',
    contributor: item.contributor,
    link: item.link,
    slot: SERVERS.length,
  };
  if (!install) return { ...row, transport: 'discovery', enabled: false, connected: false, displayOnly: true };
  return {
    ...row, transport: install.transport, entry: install,
    enabled: true, connected: true,
  };
}

globalThis.fetch = async (url, init = {}) => {
  const route = String(url).replace('/api/overall-mcp', '');
  const method = init.method ?? 'GET';
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
  requests.push({ route, method, body });
  const json = (payload) => ({ ok: true, status: 200, json: async () => payload });
  if (route === '/servers' && method === 'GET') return json(serversBody());
  if (route === '/submissions' && method === 'POST') {
    const item = {
      id: `sub_${String(PENDING.length + 1).padStart(4, '0')}`,
      name: body.name, link: body.link, note: body.note || '', contributor: body.contributor || '',
      at: '2026-02-03T09:00:00.000Z',
      file: body.file ? { name: body.file.name, bytes: Buffer.from(body.file.data, 'base64').length } : null,
      status: 'pending',
    };
    PENDING.push(item);
    return json({ ok: true, name: item.name, submissions: { pending: PENDING.length } });
  }
  if (route === '/submission-review' && method === 'POST') {
    const item = PENDING.find((s) => s.id === body.id);
    assert.ok(item, `review targets a queued submission (${body.id})`);
    PENDING.splice(PENDING.indexOf(item), 1);
    if (body.decision === 'reject') {
      DECIDED.unshift({ ...item, status: 'rejected', reason: body.reason });
      return json({ ok: true });
    }
    DECIDED.unshift({ ...item, status: 'approved' });
    const row = contributionRow(item, body);
    SERVERS.push(row);
    return json({
      ok: true, entry: row.name,
      ...(body.install ? {} : { note: `「${row.name}」已登记为仅展示（只有链接，没有挂载信息），不会挂载` }),
    });
  }
  throw new Error(`unexpected request: ${method} ${route}`);
};

// The 来源 button reaches the right Sidebar's Browser tab through `hostCtx`,
// which only `apply(ctx)` sets — so the context is applied here, exactly as the
// shell would. Its services are recorded to prove the click went somewhere.
const openedTabs = [];
globalThis.__openedTabs = openedTabs;
const fakeCtx = {
  slots: { inject: (name, cb) => { cb(); return () => {}; }, register: () => () => {} },
  get: (name) => (name === 'sidebarRightTabs'
    ? { get: (kind) => (kind === 'browser' ? {} : undefined) }
    : name === 'sidebarRight'
      ? { openTab: (kind, opts) => { openedTabs.push({ kind, url: opts?.params?.url }); } }
      : undefined),
};

const code = await readFile(bundlePath, 'utf8');
let source = code;
// Red self-tests, one per claim this file exists to defend. Each must make the
// probe exit non-zero; a probe that cannot fail is not evidence.
//   OMKT_RED_NOFILE=1 — send the submission without its attachment (the form
//     looks complete, and the reviewer never sees the file the user attached).
//   OMKT_RED_INSTALL=1 — always approve display-only, so a submission whose
//     reviewer typed a command is registered as a name and a link.
//   OMKT_RED_DISPLAY=1 — leave 启用 live on a display-only row: a switch that
//     promises to start something the host refuses to start (409).
//   OMKT_RED_QUEUE=1 — hide 投稿待审: submissions land in a file nobody opens.
const RED_NOFILE = process.env.OMKT_RED_NOFILE === '1';
const RED_INSTALL = process.env.OMKT_RED_INSTALL === '1';
const RED_DISPLAY = process.env.OMKT_RED_DISPLAY === '1';
const RED_QUEUE = process.env.OMKT_RED_QUEUE === '1';
if (RED_NOFILE) source = source.replace('...(file ? { file } : {}),', '...(false ? { file } : {}),');
if (RED_INSTALL) source = source.replace(': { install: installFromDraft(review), name:', ': { install: null, name:');
if (RED_DISPLAY) source = source.replace('disabled: busy || displayOnly,', 'disabled: busy,');
if (RED_QUEUE) source = source.replace('if (!waiting.length && !decided.length) return null;', 'return null;');
if (RED_NOFILE || RED_INSTALL || RED_DISPLAY || RED_QUEUE) {
  assert.notEqual(source, code, 'red mutation applied (the code it removes still exists)');
}
// eslint-disable-next-line no-new-func
new Function('window', 'require', source)(globalThis.window, requireShim);
const mod = captured.factory(requireShim);
assert.equal(typeof mod.Section, 'function', 'client exports Section');
mod.apply(fakeCtx);

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
    if (!frame) { frame = { hooks: [], refs: [], cursor: 0 }; frameStore.set(key, frame); }
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
/** Click, let the async work finish, then hand back the flattened tree. */
async function clickAndSettle(node, event) {
  node.props.onClick(event ?? {
    defaultPrevented: false, button: 0,
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    preventDefault() { this.defaultPrevented = true; },
  });
  for (let i = 0; i < 30; i += 1) await settle();
  return walk(await render());
}
/** A plain left click, as a browser would deliver it. */
const clickEvent = () => ({
  defaultPrevented: false, button: 0,
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
  preventDefault() { this.defaultPrevented = true; },
});

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
const keyed = (nodes, key) => nodes.filter((n) => n.props?.key === key);
const buttonByText = (nodes, text) => nodes.find((n) => n.type === 'button' && textOf(n) === text);
/** The registry row (`.omkt-srow`) whose text names `name`. */
const rowByName = (nodes, name) => nodes.find((n) => n.props?.className === 'omkt-srow' && textOf(n).includes(name));
/** A text field, by where it is and what it says, never by node index. */
const inputByPlaceholder = (nodes, placeholder) => nodes.find((n) => n.type === 'input' && n.props?.placeholder === placeholder);
const field = (nodes, mark) => nodes.find((n) => n.props?.['data-omkt'] === mark);
const lastRequest = (route) => [...requests].reverse().find((r) => r.route === route);
/**
 * Repaint, so a handler comes from the render that saw the latest state.
 *
 * A handler closes over the state of the render it was created in, so a button
 * clicked before the repaint would act on the values from before the typing —
 * a form that appears to submit its fields while sending the empty ones.
 */
async function repaint() {
  nodes = walk(await render());
  return nodes;
}
/** Type into a field, then repaint. Returns the fresh tree. */
async function fill(node, value) {
  assert.ok(node, 'the field being typed into exists');
  node.props.onChange({ target: { value } });
  return repaint();
}

// --- 1. the queue: who is waiting, and what they attached -------------------
let nodes = walk(await render());
const bar = keyed(nodes, 'queue')[0];
assert.ok(bar, '已注册 shows the submission queue');
const barText = textOf(bar);
assert.match(barText, /投稿待审 2 条/, 'the queue counts what is pending');
assert.match(barText, /acme-mcp/, 'a pending submission lists its name');
assert.match(barText, /给 Claude 用的示例服务/, "a pending submission shows the submitter's note");
assert.match(barText, /manifest\.json/, "a pending submission names its attachment");
assert.match(barText, /未署名/, 'a submission with no name says so');
assert.match(barText, /王五 投稿/, 'a signed submission names its submitter');
assert.equal(keyed(nodes, 'sub_0001').length, 1, 'each pending submission is one row');

// --- 2. 申请收录 opens the form, and the upstream guide is inside it --------
const headerBtn = buttonByText(nodes, '申请收录 MCP 服务 · 待审 2');
assert.ok(headerBtn, 'the header button advertises the pending count');
assert.equal(keyed(nodes, 'submit').length, 0, 'the form starts closed');
nodes = await clickAndSettle(headerBtn);
const sheet = keyed(nodes, 'submit')[0];
assert.ok(sheet, '申请收录 opens the submission form');
assert.match(textOf(sheet), /申请收录 MCP 服务/, 'the form is titled');
assert.match(textOf(sheet), /个人贡献/, 'the form says what the row will be credited as on approval');
assert.ok(field(nodes, 'submit-name'), 'the form asks for the service name');
assert.ok(field(nodes, 'submit-link'), 'the form asks for the link');
assert.ok(field(nodes, 'submit-file'), 'the form accepts an attachment');
assert.ok(buttonByText(walk(sheet), '上游市场投稿指南 ↗'), 'the upstream guide is still reachable from the form');

// --- 3. submitting: one request, every field, attachment bytes included -----
// An invalid link is refused in the page, with no request: the host should
// never have to reject a form the page could have checked.
const goBtn = (tree) => buttonByText(walk(keyed(tree, 'submit')[0]), '提交审核');
nodes = await fill(field(nodes, 'submit-name'), 'gamma-mcp');
nodes = await fill(field(nodes, 'submit-link'), 'not-a-link');
nodes = await clickAndSettle(goBtn(nodes));
// Counted by route, not by request: the page re-reads /servers on its own
// schedule, so only a POST to /submissions proves a form was sent.
assert.equal(lastRequest('/submissions'), undefined, 'an invalid link never reaches the host');
assert.match(textOf(keyed(nodes, 'submit')[0]), /http\(s\) 链接/, 'the form says why it refused');

// The refusal kept the text it had — fixing one field must not mean retyping
// the others.
assert.equal(field(nodes, 'submit-name').props.value, 'gamma-mcp', 'a refused submit keeps the name');
assert.equal(field(nodes, 'submit-link').props.value, 'not-a-link', 'a refused submit keeps the link');
nodes = await fill(field(nodes, 'submit-link'), 'https://github.com/acme/gamma-mcp');
nodes = await fill(
  nodes.find((n) => n.type === 'textarea' && n.props?.placeholder === '它提供什么工具、需要什么凭据'),
  '带 3 个工具',
);
field(nodes, 'submit-file').props.onChange({
  target: { files: [{ name: 'manifest.json', size: 2048, type: 'application/json' }] },
});
nodes = await repaint();
nodes = await clickAndSettle(goBtn(nodes));
const submit = lastRequest('/submissions');
assert.ok(submit, '提交审核 posts to /submissions');
assert.equal(submit.method, 'POST');
assert.equal(submit.body.name, 'gamma-mcp');
assert.equal(submit.body.link, 'https://github.com/acme/gamma-mcp');
assert.equal(submit.body.note, '带 3 个工具');
assert.equal(submit.body.contributor, '');
assert.equal(submit.body.file?.name, 'manifest.json');
assert.equal(submit.body.file?.data, ATTACHMENT_B64, "the attachment's bytes travel with the submission");
assert.equal(keyed(nodes, 'submit').length, 0, 'the form closes once the host takes it');
assert.match(textOf(nodes[0]), /已提交「gamma-mcp」，等待审核（待审 3 条）/, 'the page reports the new queue depth');
assert.match(textOf(keyed(nodes, 'queue')[0]), /gamma-mcp/, 'the new submission joins the queue');

// --- 4. 通过 with a command: the install payload is what carries the mount --
const gammaRow = keyed(nodes, 'sub_0003')[0];
assert.ok(gammaRow, 'the new submission is its own row');
nodes = await clickAndSettle(buttonByText(walk(gammaRow), '通过…'));
const reviewForm = keyed(nodes, 'review')[0];
assert.ok(reviewForm, '通过 opens the reviewer’s form inside the row it decides');
assert.match(textOf(reviewForm), /它怎么启动/, 'the reviewer is asked how it starts');
assert.ok(inputByPlaceholder(walk(reviewForm), 'npx'), 'stdio asks for the command');
// The name the reviewer is shown starts as the submitted one, so approving
// without touching it writes the name the submitter gave.
assert.equal(nodes.find((n) => n.type === 'input' && n.props?.value === 'gamma-mcp')?.props.value, 'gamma-mcp');
nodes = await fill(inputByPlaceholder(nodes, 'npx'), 'npx');
nodes = await fill(inputByPlaceholder(nodes, '-y @acme/mcp-server'), '-y @acme/gamma-mcp');
nodes = await clickAndSettle(buttonByText(nodes, '通过并写入注册表'));
const approve = lastRequest('/submission-review');
assert.ok(approve, '通过并写入注册表 posts to /submission-review');
assert.equal(approve.body.id, 'sub_0003');
assert.equal(approve.body.decision, 'approve');
assert.deepEqual(approve.body.install, { transport: 'stdio', command: 'npx', args: ['-y', '@acme/gamma-mcp'] },
  "the reviewer's command is what makes the row mountable");
assert.equal(approve.body.name, 'gamma-mcp');
assert.match(textOf(nodes[0]), /gamma-mcp 已写入注册表，来源标记为「个人贡献」/, 'the page names the source it wrote');
assert.ok(rowByName(nodes, 'gamma-mcp'), 'the approved submission is now a registry row');

// --- 5. 通过 with nothing filled: 仅展示, never a fake mount ----------------
const betaRow = keyed(nodes, 'sub_0002')[0];
nodes = await clickAndSettle(buttonByText(walk(betaRow), '通过…'));
assert.match(textOf(keyed(nodes, 'review')[0]), /留空＝登记为「仅展示」/, 'the form says an empty command is a real answer');
nodes = await clickAndSettle(buttonByText(nodes, '通过并写入注册表'));
const displayApprove = lastRequest('/submission-review');
assert.equal(displayApprove.body.install, null, 'an empty command approves as display-only, not as a broken stdio row');
// The host's own note is what the page must show: asserting on 「仅展示」 alone
// would pass on the seeded display-only row, which is on screen either way.
assert.match(textOf(nodes[0]), /「beta-mcp」已登记为仅展示/, 'the page repeats the host’s 仅展示 note rather than claiming a mount');
assert.match(textOf(nodes[0]), /不会挂载/, 'and says the row will never be mounted');

// --- 6. 驳回 records why, and the reason stays on the line ------------------
const acmeRow = keyed(nodes, 'sub_0001')[0];
nodes = await clickAndSettle(buttonByText(walk(acmeRow), '驳回…'));
const reasonBox = nodes.find((n) => n.type === 'textarea' && n.props?.placeholder?.includes('链接打不开'));
assert.ok(reasonBox, '驳回 asks for a reason');
nodes = await fill(reasonBox, '链接打不开');
nodes = await clickAndSettle(buttonByText(nodes, '驳回'));
const reject = lastRequest('/submission-review');
assert.equal(reject.body.decision, 'reject');
assert.equal(reject.body.reason, '链接打不开');
assert.match(textOf(nodes[0]), /已驳回「acme-mcp」/, 'the page reports the rejection');
assert.match(textOf(keyed(nodes, 'queue')[0]), /acme-mcp 已驳回（链接打不开）/, 'the reason stays visible on the decided line');
assert.equal(PENDING.length, 0, 'every submission was answered');

// --- 7. a display-only row: honest badge, named submitter, dead switch ------
const zhangsanRow = rowByName(nodes, 'zhangsan-link-only');
assert.ok(zhangsanRow, 'the display-only contribution is in the registry');
assert.equal(textOf(keyed(walk(zhangsanRow), 'displayonly')[0]), '仅展示', 'the row is badged 仅展示');
assert.match(textOf(zhangsanRow), /由 张三 提交/, 'the row names its submitter');
const toggle = keyed(walk(zhangsanRow), 'toggle')[0];
assert.equal(toggle.props.disabled, true, '启用 is dead on a row with nothing to start');
assert.match(String(toggle.props.title), /无法挂载/, '启用 says why it is dead');
const lisiRow = rowByName(nodes, 'lisi-mcp');
const linkBtn = keyed(walk(lisiRow), 'link')[0];
assert.ok(linkBtn, 'a contribution with a link keeps its 来源 button');
assert.equal(linkBtn.props.title, '打开投稿里给的链接：https://github.com/lisi/mcp-server');
const plainClick = clickEvent();
await clickAndSettle(linkBtn, plainClick);
assert.deepEqual(openedTabs, [{ kind: 'browser', url: 'https://github.com/lisi/mcp-server' }],
  '来源 opens the link the submitter gave, in the right Sidebar');
assert.equal(plainClick.defaultPrevented, true, 'and the anchor does not also navigate');
// A modified click is the user asking for their own browser: the plugin's own
// navigation must stay out of it.
openedTabs.length = 0;
const ctrlClick = { ...clickEvent(), ctrlKey: true };
await clickAndSettle(linkBtn, ctrlClick);
assert.deepEqual(openedTabs, [], 'ctrl-click is left to the platform, not the Sidebar');
assert.equal(ctrlClick.defaultPrevented, false, 'and the anchor keeps its own behaviour');

console.log('ok — 投稿: one form, one request, a queue that says who is waiting, and a review that');
console.log('     either produces a mountable row or an honest 仅展示 — never a row that spawns undefined.');
