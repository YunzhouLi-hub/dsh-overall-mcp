// tools/render-config-dialog.mjs — render the config sheet against a fake React tree.
//
// The sheet is reached only by clicking 配置 on a row, so every probe that
// renders the section walks straight past it. It shipped broken for that
// reason: `rowRef` was declared inside `Section`, while `ConfigDialog` is its
// sibling at module scope, so the first thing the sheet did was throw
// `ReferenceError: rowRef is not defined` — before painting anything. With no
// error boundary in the page, the panel went blank and the button looked dead.
//
// This renders the two shapes the host actually sends: a row whose spec was
// derived from a schema (Smithery / brave-search), and a row that declares
// nothing at all.
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
    // would never run ConfigDialog's body, which is the whole point here.
    if (typeof type === 'function') return type({ ...p, children });
    return { type, props: p, children };
  },
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  Component: class {
    constructor(props) { this.props = props; this.state = {}; }
    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) };
    }
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
assert.ok(__test?.ConfigDialog, 'client exports __test.ConfigDialog');

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

// The derived shape: `maskedFields()` over a spec rebuilt from the Smithery
// schema, which is what brave-search answers after the empty-list fix.
const declaredRow = {
  name: 'brave-search', slot: 6, transport: 'stdio', serverName: 'brave-search',
  enabled: true, connected: false, status: 'stopped', providedExternally: false, needConfig: true,
  channel: 'cli-json',
  config: {
    origin: 'smithery', missing: ['braveApiKey'], pending: [],
    fields: [{
      key: 'braveApiKey', kind: 'config', label: 'Brave API Key',
      help: 'Your Brave Search subscription token.',
      required: true, secret: true, hasValue: false, value: '',
    }],
  },
};

// A row nothing declares: the form is still the place to add a key by hand.
const bareRow = {
  name: 'my-own-fs', slot: 2, transport: 'stdio', enabled: true, connected: true,
  status: 'connected', providedExternally: false, needConfig: false, config: null,
};

// 1. Both shapes paint. This is the assertion the shipped bug failed.
for (const [label, server] of [['declared', declaredRow], ['bare', bareRow]]) {
  let tree;
  try {
    tree = __test.ConfigDialog({ server, onClose: () => {}, onSaved: async () => {} });
  } catch (error) {
    assert.fail(`ConfigDialog threw while rendering the ${label} row: ${error?.message ?? error}\n${error?.stack ?? ''}`);
  }
  const nodes = walk(tree);
  assert.ok(nodes.length > 5, `${label}: the sheet rendered nothing`);
  assert.ok(textOf(tree).includes(`配置 ${server.name}`), `${label}: the sheet does not name the server`);
}

// 2. A declared field shows its label, its raw key, and both of its truths.
{
  const all = textOf(__test.ConfigDialog({ server: declaredRow, onClose: () => {}, onSaved: async () => {} }));
  for (const want of ['Brave API Key', 'braveApiKey', '必填', '· 密钥']) {
    assert.ok(all.includes(want), `declared row: "${want}" missing from the sheet`);
  }
  // The missing key is stated, not implied by an empty input.
  assert.ok(all.includes('还缺 braveApiKey'), 'declared row: the missing key is not named');
  // And the source is described as declaring them, not denying it.
  assert.ok(all.includes('Smithery'), 'declared row: the sheet does not say where the fields came from');
  assert.ok(!all.includes('这个来源没有声明配置项'), 'declared row: the sheet denies declaring fields it shows');
}

// 3. A bare row still offers the key/value escape hatch, and claims nothing.
{
  const all = textOf(__test.ConfigDialog({ server: bareRow, onClose: () => {}, onSaved: async () => {} }));
  assert.ok(all.includes('其他键值'), 'bare row: no way to add a key by hand');
  // 「不用配置」 is an answer, not a shrug: the sheet says it looked and found
  // nothing declared, instead of leaving the reader to wonder if it gave up.
  assert.ok(all.includes('没有声明要填的配置项'), 'bare row: the sheet does not say why it is empty');
  assert.ok(all.includes('都查过了'), 'bare row: the sheet does not say where it looked');
  // …and it may not borrow the Smithery line: no Smithery row was asked here.
  assert.ok(!all.includes('已向 Smithery 确认'), 'bare row: it claims a source that never answered');
  assert.ok(!all.includes('还缺'), 'bare row: nothing is missing, so nothing may be reported missing');
}

// 4. Saving an untouched form must not send the masked echo back as a value.
//    The host never returns a secret, so a form that submitted every input
//    would write 「••••」 as the token itself.
{
  const sent = [];
  const before = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ saved: true, needConfig: false }) };
  };
  try {
    const tree = __test.ConfigDialog({ server: declaredRow, onClose: () => {}, onSaved: async () => {} });
    const save = walk(tree).find((n) => n.type === 'button' && textOf(n) === '保存并重新挂载');
    assert.ok(save, 'the sheet has no save button');
    await save.props.onClick();
    assert.equal(sent.length, 1, `save must make exactly one request (made ${sent.length})`);
    assert.ok(sent[0].url.endsWith('/configure'), `save posted to ${sent[0].url}`);
    assert.equal(sent[0].body.env, undefined, 'save sent an env bag for a form nobody touched');
    assert.equal(sent[0].body.headers, undefined, 'save sent a headers bag for a form nobody touched');
    assert.equal(sent[0].body.name, 'brave-search', 'save did not address the row by name');
    assert.equal(sent[0].body.slot, 6, 'save lost the row slot');
  } finally {
    globalThis.fetch = before;
  }
}

// 5. A `--config` row must not offer 环境变量 as the home for its keys. The
//    declared braveApiKey is `kind: 'config'`, and a value written to `env` is a
//    value `@smithery/cli run` never reads — the save reports success while the
//    row keeps saying 还缺 forever.
{
  const all = textOf(__test.ConfigDialog({ server: declaredRow, onClose: () => {}, onSaved: async () => {} }));
  assert.ok(
    all.includes('写进那份 --config JSON'),
    'cli-json row: the escape hatch does not say where an extra key goes',
  );

  const bags = __test.splitValues(
    declaredRow.config.fields,
    { 'config:braveApiKey': 'BSA-example' },
    [{ key: ' extraMode ', kind: 'config', value: 'fast' }, { key: 'MODE', kind: 'env', value: 'dev' }],
  );
  assert.deepEqual(bags.config, { braveApiKey: 'BSA-example', extraMode: 'fast' }, 'a config key did not reach the --config bag');
  assert.deepEqual(bags.env, { MODE: 'dev' }, 'an env key did not reach the env bag');
  assert.deepEqual(bags.headers, {}, 'a headers bag was invented for a stdio row');

  // Untouched fields still contribute nothing, whichever channel they are on.
  const untouched = __test.splitValues(declaredRow.config.fields, {}, [{ key: '', kind: 'config', value: '' }]);
  assert.deepEqual(untouched, { env: {}, headers: {}, config: {} }, 'an untouched form produced a value');
}

console.log('\nconfig sheet renders: declared and bare rows both paint, untouched saves stay empty');
