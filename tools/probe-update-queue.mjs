// tools/probe-update-queue.mjs — the 更新 queue: one bar, honest progress.
//
// The user's request: 「MCP 服务器更新的时候可以有进度条之类的进度展示，可以放在
// 「已注册」下面，如果有多个的话支持下拉查看」. The host cannot help here — an
// /update request answers once, when the whole registry rewrite and reconnect is
// done — so the page's own queue is the only thing that knows where an update is.
// This probe renders the real Section against a fake React and pins the contract:
//
//   * 已注册 carries one 全部更新 button that acts on exactly the servers the
//     host's last update check marked updatable, and is disabled when there are
//     none (the affordance 检查更新 fills in, not a dead control);
//   * items run SEQUENTIALLY (proved by ordering the request/response events,
//     not by trusting the code to look sequential), so the summary bar's
//     (i/N) count is a real measure rather than a guess;
//   * the bar exposes role=progressbar with aria-valuenow/max — a determinate
//     count, never a fabricated download percentage;
//   * a batch's per-item outcomes are listed, and 更新 / 无需更新 / 失败 are
//     told apart;
//   * one failure still reports as an error while the rest of the batch keeps
//     going, and a single row's 更新 reports through the same bar (1 item);
//   * a queue that settled everything outstanding stops asking 「全部更新（N）」
//     and states the outcome (a green ✓) instead — the fix for a bar that kept
//     offering work it had just answered, including the 「无需更新」 answer,
//     whose count came from a badge older than the update;
//   * a settled outcome never hides a batch affordance while some other
//     updatable server is still waiting;
//   * the plugin's own update is revealed by 检查更新 beside the version chip on
//     the registry tab too, where it used to be invisible.
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

// --- fixture: three updatable servers, one that is not ----------------------
// `/servers` clears a name's badge once it has been updated, which is what the
// host does (it rewrites the entry's update check). A fixture that kept saying
// 「可更新」 after a successful update would let the page pass here while the real
// one kept offering work it had just answered.
const SERVERS = [
  {
    name: 'alpha-mcp', serverName: 'alpha_mcp', transport: 'stdio', source: 'claude-code',
    enabled: true, connected: true, slot: 0, package: { name: 'alpha-mcp', version: '1.0.0' },
    update: { updateAvailable: true, latest: '2.0.0', current: '1.0.0' },
  },
  {
    name: 'beta-mcp', serverName: 'beta_mcp', transport: 'stdio', source: 'cursor',
    enabled: true, connected: true, slot: 1, package: { name: 'beta-mcp', version: '3.0.0' },
    update: { updateAvailable: true, latest: '3.1.0', current: '3.0.0' },
  },
  {
    name: 'gamma-mcp', serverName: 'gamma_mcp', transport: 'stdio', source: 'cursor',
    enabled: true, connected: true, slot: 2, package: { name: 'gamma-mcp', version: '1.0.0' },
    update: { updateAvailable: true, latest: '2.0.0', current: '1.0.0' },
  },
  {
    name: 'delta-mcp', serverName: 'delta_mcp', transport: 'stdio', source: 'claude-desktop',
    enabled: true, connected: true, slot: 3, package: { name: 'delta-mcp', version: '1.4.0' },
    update: { updateAvailable: false, latest: '1.4.0' },
  },
];
// Rows a later section adds to the listing (the duplicate-name case).
const extraServers = [];
// Rows the host has dropped, and every row action's body, in order. Which row a
// click aimed at is the whole question in a registry whose names repeat — and
// the answer has to survive 停用/移除 too, not just 更新.
const removedAddresses = new Set();
const actionBodies = [];

let captured = null;
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };
globalThis.document = {
  head: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, appendChild() {} }),
  getElementById: () => null,
};

// The event log is what proves sequencing: a request for the second item may
// only appear AFTER the first item's answer arrived. Timestamps would be weaker
// (two parallel requests can still be ordered in time).
const events = [];
let betaAttempts = 0;
const updatedNames = new Set();
// Every /update body, in order: the row identity the client sent, which is what
// a same-named second entry turns into the difference between updating the row
// somebody clicked and updating whichever row the host finds first.
const updateBodies = [];
// A listing that keeps advertising a name the queue already answered models the
// state the panel was reported in: the host had not rewritten the entry yet, so
// the badge — and the 「全部更新（N）」 count built from it — outlived the answer
// that settled it. Only the last section turns this on, deliberately.
const stale = new Map();
// One answer the probe holds open by hand, so the mid-queue state is observable
// instead of instantaneous. It is switched on only for the last section: the
// earlier sections must run their own updates to completion.
let gateAlpha = false;
let releaseAlpha = () => {};
const alphaGate = new Promise((resolve) => { releaseAlpha = resolve; });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// A check that fails is a different answer from "already up to date": the host
// counts the two apart (`failed` vs `updatable`). The last section switches this
// on to prove the page tells them apart too.
let checkFailures = 0;
globalThis.fetch = async (url, init) => {
  const ok = (value) => ({ ok: true, status: 200, json: async () => value });
  const p = String(url).replace('/api/overall-mcp', '');
  if (p.startsWith('/servers')) {
    return ok({
      servers: [...SERVERS, ...extraServers]
        .filter((s) => !removedAddresses.has(s.slot ?? s.name))
        .map((s) => {
          // Keyed by row address (slot when the host reports one), because the host
          // rewrites the entry it was given and leaves its same-named sibling alone.
          const address = s.slot ?? s.name;
          const forced = stale.get(address);
          if (forced) return { ...s, update: { updateAvailable: true, latest: forced } };
          return updatedNames.has(address)
            ? { ...s, update: { ...s.update, updateAvailable: false } }
            : { ...s };
        }),
    });
  }
  if (p.startsWith('/favorites')) return ok({ keys: [], total: 0 });
  if (p.startsWith('/updates')) {
    events.push('updates');
    return ok({
      checked: 4,
      updatable: 3,
      failed: checkFailures,
      self: { updateAvailable: true, latest: '0.9.0', version: '0.1.0', profileName: 'default' },
    });
  }
  if (p.startsWith('/update')) {
    const body = JSON.parse(init?.body ?? '{}');
    const { name } = body;
    // The body is evidence: a name alone cannot say which row was clicked when a
    // config defines the same server twice.
    updateBodies.push({ name, slot: body.slot ?? null, from: body.from ?? null });
    events.push(`request:${name}`);
    // Only the last section holds alpha's answer open, so the row behind it is
    // observable while it is still queued; earlier sections must run their own
    // updates to completion. The gate sits before the answer is logged, so the
    // event stream stays honest about when an item was really answered.
    if (name === 'alpha-mcp' && gateAlpha) await alphaGate;
    // alpha answers a few turns later, so a parallel client could not hide.
    await tick(); await tick();
    events.push(`answer:${name}`);
    // Transient on purpose: a real runner can fail one rewrite and succeed on
    // the retry, and the bar has to tell those two states apart.
    if (name === 'beta-mcp' && betaAttempts++ === 0) {
      return { ok: false, status: 500, json: async () => ({ error: 'registry rewrite failed: EPERM' }) };
    }
    // The last section's two items: one real update, one entry the host answers
    // as already current.
    if (name === 'alpha-mcp') {
      updatedNames.add(body.slot ?? name);
      // The advertised version is whatever the listing claims, so the last
      // section can ask for a release newer than the one already installed.
      const to = stale.get(body.slot ?? name) ?? '3.0.0';
      return ok({ name, updated: true, package: 'alpha-mcp', from: '2.0.0', to, reconnected: true });
    }
    if (name === 'delta-mcp') {
      // No `updatedNames.add`: the host has not rewritten this entry yet, which
      // is exactly the state being tested.
      return ok({ name, updated: false, package: 'delta-mcp', version: '1.2.0', reason: 'already up to date' });
    }
    updatedNames.add(body.slot ?? name);
    return ok({ name, updated: true, package: `${name}`, from: body.from ?? '1.0.0', to: '2.0.0', reconnected: true });
  }
  // The row actions other than 更新. Their bodies are kept for the same reason
  // the update bodies are: a name is not a row identity when a config defines
  // the same server twice, and 移除 aiming at the first match is how clicking the
  // last of four `rea-cursor` rows removed a different one.
  if (p.startsWith('/set-enabled')) {
    const body = JSON.parse(init?.body ?? '{}');
    actionBodies.push({ url: '/set-enabled', name: body.name, slot: body.slot ?? null, from: body.from ?? null, enabled: body.enabled });
    const row = [...SERVERS, ...extraServers].find((s) => (s.slot ?? s.name) === body.slot);
    if (row) row.enabled = body.enabled;
    return ok({ name: body.name, enabled: body.enabled });
  }
  if (p.startsWith('/remove')) {
    const body = JSON.parse(init?.body ?? '{}');
    actionBodies.push({ url: '/remove', name: body.name, slot: body.slot ?? null, from: body.from ?? null });
    removedAddresses.add(body.slot ?? body.name);
    return ok({ name: body.name, removed: body.name });
  }
  // One action for the whole set of rows the host proved are gone. It reports
  // the same shape the real route does: a count plus the names it dropped.
  if (p.startsWith('/forget-orphans')) {
    const ghosts = [...SERVERS, ...extraServers]
      .filter((s) => s.orphan === true && !removedAddresses.has(s.slot ?? s.name));
    actionBodies.push({ url: '/forget-orphans', names: ghosts.map((s) => s.name) });
    ghosts.forEach((s) => removedAddresses.add(s.slot ?? s.name));
    return ok({
      count: ghosts.length,
      removed: ghosts.map((s) => ({ name: s.name, source: s.source, version: null, heldFiber: false })),
    });
  }
  return ok({});
};

// Red self-tests, one per claim this file exists to defend. Each must make the
// probe exit non-zero; a probe that cannot fail is not evidence.
//   OMKT_RED_QUEUE=1 — remove the progress track (an update with no progress).
//   OMKT_RED_GUARD=1 — remove the one-writer guard (two queues at once).
//   OMKT_RED_SETTLED=1 — keep offering the batch after it settled (the reported bug:
//     a 「全部更新（1）」 that survived the update it was offering).
//   OMKT_RED_ANSWERED=1 — let an answered row keep advertising its old badge and
//     button (the other half of the same report: 更新 完成之后按钮还在).
//   OMKT_RED_SLOT=1 — send only the name, the way the client used to. A config
//     that defines one server twice then cannot be told apart by the answer, so
//     this one is caught wherever an answer lands on the wrong entry first.
//   OMKT_RED_ROWREF=1 — drop the slot from 停用/移除 the same way, which is how
//     移除 on the last of four same-named rows removed the first one.
//   OMKT_RED_ORPHAN=1 — let a row whose source no longer defines it advertise an
//     update anyway: the ghost's whole problem is that it looks like live work.
//   OMKT_RED_CHECKFAIL=1 — fold a failed lookup back into 「均已是最新版本」,
//     the two-way message this section exists to keep out: it told an offline
//     machine that everything was current.
const RED_QUEUE = process.env.OMKT_RED_QUEUE === '1';
const RED_GUARD = process.env.OMKT_RED_GUARD === '1';
const RED_SETTLED = process.env.OMKT_RED_SETTLED === '1';
const RED_ANSWERED = process.env.OMKT_RED_ANSWERED === '1';
const RED_SLOT = process.env.OMKT_RED_SLOT === '1';
const RED_ROWREF = process.env.OMKT_RED_ROWREF === '1';
const RED_ORPHAN = process.env.OMKT_RED_ORPHAN === '1';
const RED_CHECKFAIL = process.env.OMKT_RED_CHECKFAIL === '1';
const code = await readFile(bundlePath, 'utf8');
let source = code;
if (RED_QUEUE) source = source.replace('key: "track", className:', 'key: "track-red", className:');
if (RED_GUARD) source = source.replace('if (updateRunRef.current) return;', '// guard removed');
if (RED_SETTLED) {
  source = source.replace(
    'const queueSettled = jobsFinished && jobsFailed === 0 && pending.length === 0;',
    'const queueSettled = false;',
  );
}
if (RED_ANSWERED) {
  source = source.replace(
    'const settled = job?.answered === true && (job.status === "updated" || job.status === "skipped");',
    'const settled = false;',
  );
}
if (RED_SLOT) {
  source = source.replace(
    'body: JSON.stringify({ name: row.name, from: row.from, slot: row.slot }),',
    'body: JSON.stringify({ name: row.name }),',
  );
}
if (RED_ROWREF) {
  source = source.replace(
    'slot: Number.isInteger(server.slot) ? server.slot : null,',
    'slot: null,',
  );
}
if (RED_ORPHAN) {
  source = source.replace(
    'const newVersion = !orphan && update?.updateAvailable ? update.latest : null;',
    'const newVersion = update?.updateAvailable ? update.latest : null;',
  );
}
if (RED_CHECKFAIL) {
  source = source.replace(
    'const failed = r.failed ?? 0;',
    'const failed = 0;',
  );
}
if (RED_QUEUE || RED_GUARD || RED_SETTLED || RED_ANSWERED || RED_SLOT || RED_ROWREF || RED_ORPHAN || RED_CHECKFAIL) {
  assert.notEqual(source, code, 'red mutation applied (the code it removes still exists)');
}
// eslint-disable-next-line no-new-func
new Function('window', 'require', source)(globalThis.window, requireShim);
const mod = captured.factory(requireShim);
assert.equal(typeof mod.Section, 'function', 'client exports Section');

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
/** Click, let the async queue finish, then hand back the flattened tree. */
async function clickAndSettle(node) {
  node.props.onClick();
  for (let i = 0; i < 30; i += 1) await settle();
  return walk(await render());
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
const keyed = (nodes, key) => nodes.filter((n) => n.props?.key === key);
const buttonByText = (nodes, text) => nodes.find((n) => n.type === 'button' && textOf(n) === text);

// --- 1. the bar, and the button that owns the batch ------------------------
let nodes = walk(await render());
if (process.env.DEBUG_QUEUE) {
  console.log('[debug] nodes:', nodes.length);
  console.log('[debug] registry text:', textOf(keyed(nodes, 'reg')[0] ?? nodes[0]).slice(0, 800));
}
const bar = keyed(nodes, 'updatebar')[0];
assert.ok(bar, '已注册 shows the update row');

const allBtn = keyed(nodes, 'all')[0];
assert.ok(allBtn, '全部更新 button is present');
assert.equal(textOf(allBtn), '全部更新（3）',
  'it counts exactly the servers the host marked updatable (3 of 4)');
assert.equal(allBtn.props.disabled, false, 'and it is enabled when there is work');
assert.match(String(allBtn.props.title ?? ''), /3 台/, 'the tooltip says how many it will touch');

// No queue has run yet, so there is no progress to show — and no 0% bar
// pretending an update is under way.
assert.equal(keyed(nodes, 'track').length, 0, 'no progress bar before anything is updated');

// --- 2. the plugin's own update appears beside the version chip -------------
assert.equal(keyed(nodes, 'hd-self').length, 0, 'no self-update button before 检查更新');
nodes = await clickAndSettle(keyed(nodes, 'hd-updates')[0]);
assert.ok(events.includes('updates'), '检查更新 asked the host');
const chipBtn = keyed(nodes, 'hd-self')[0];
assert.ok(chipBtn, 'an available plugin update surfaces beside the version chip');
assert.equal(textOf(chipBtn), '更新到 v0.9.0', 'and it names the version it installs');
assert.match(String(chipBtn.props.title ?? ''), /v0\.9\.0/, 'the tooltip carries the version too');

// --- 3. one row's 更新 reports through the same bar -------------------------
// The host fixture clears a server's badge once it has been updated, exactly as
// the host does — so what still reads as updatable here really is.
const rowUpdate = keyed(nodes, 'update')[0];
assert.ok(rowUpdate, 'a row with an available update carries its own 更新 button');
nodes = await clickAndSettle(rowUpdate);
assert.equal(events.filter((e) => e.startsWith('request:')).length, 1,
  'the row clicked one update, not the batch');
const single = keyed(nodes, 'track')[0];
assert.ok(single, 'a single update gets the same progress bar');
assert.equal(single.props.role, 'progressbar', 'and it announces itself as one');
assert.equal(single.props['aria-valuemax'], 1, 'counting its one item');
assert.equal(single.props['aria-valuenow'], 1, 'which is done');
assert.equal(keyed(nodes, 'jobs').length, 0, 'one item needs no detail list');
assert.equal(keyed(nodes, 'togglejobs').length, 0, 'and no toggle either');
// Two updatable servers are still waiting, so this slot has to stay a batch
// button: an outcome here would strand the servers nobody has updated yet.
const stillBatch = keyed(nodes, 'all')[0];
assert.equal(textOf(stillBatch), '全部更新（2）',
  'the updated row drops off the batch count, and the batch stays');
assert.ok(!String(stillBatch.props.className).includes('omkt-btn-done'),
  'and it does not report an outcome while updatable servers are left');

// --- 4. the batch: sequential, determinate, told apart ---------------------
{
  const before = events.length;
  nodes = await clickAndSettle(keyed(nodes, 'all')[0]);
  assert.deepEqual(events.slice(before).filter((e) => e !== 'updates'), [
    'request:beta-mcp', 'answer:beta-mcp',
    'request:gamma-mcp', 'answer:gamma-mcp',
  ], 'items run one at a time: no second request before the first answer');
}

const track = keyed(nodes, 'track')[0];
assert.ok(track, 'the queue renders a progress bar');
assert.equal(track.props.role, 'progressbar', 'and announces itself as one');
assert.equal(track.props['aria-valuemax'], 2, 'the bar counts the items, not a download');
assert.equal(track.props['aria-valuenow'], 2, 'both items are accounted for');
assert.match(String(track.props['aria-label'] ?? ''), /2\/2/, 'the label states the count');

const fill = keyed(nodes, 'fill')[0];
assert.equal(fill.props.style.width, '100%', 'the fill is the real share of finished items');

const text = textOf(keyed(nodes, 'text')[0]);
assert.doesNotMatch(text, /\d\/\d/,
  `a finished queue stops reporting a fraction — (i/N) reads as work in flight — got: ${text}`);
assert.doesNotMatch(text, /正在更新/, 'a finished queue is not still "updating"');
assert.match(text, /已用时 \d+s/, 'and it says how long it took');

// The failed item is still outstanding, so the batch keeps offering exactly it —
// and nothing else. Its count is the queue's own result, not a rerun of the
// listing the queue started from.
const afterFailure = keyed(nodes, 'all')[0];
assert.equal(textOf(afterFailure), '全部更新（1）',
  'the one failed item stays on the batch list, and the settled ones are off it');
assert.equal(afterFailure.props.disabled, false, 'so the retry is available');

// The outcome: one updated, one failed — and the failure is the headline.
const err = keyed(nodes, 'error')[0];
assert.ok(err, 'a batch with a failure reports an error, not a success toast');
assert.match(textOf(err), /2 台服务器：1 台已更新，1 台失败/,
  `the summary separates updated from failed — got: ${textOf(err)}`);

const jobRows = keyed(nodes, 'jobs')[0];
assert.ok(jobRows, 'the batch lists its items');
const jobText = textOf(jobRows);
assert.match(jobText, /gamma-mcp/, 'the updated item is listed');
assert.match(jobText, /1\.0\.0 → 2\.0\.0（已重连）/, 'with what it moved from and to');
assert.match(jobText, /beta-mcp/, 'the failed item is listed too');
assert.match(jobText, /EPERM/, 'with the host\'s own reason, not a swallowed one');
assert.equal(keyed(nodes, 'togglejobs').length, 1, 'a multi-item batch can collapse its details');

// --- 5. the finished bar is dismissible ------------------------------------
nodes = await clickAndSettle(buttonByText(nodes, '关闭进度'));
assert.equal(keyed(nodes, 'track').length, 0, '关闭进度 clears the finished bar');
assert.ok(keyed(nodes, 'updatebar')[0], 'the row itself stays, with the batch button in it');
assert.equal(textOf(keyed(nodes, 'all')[0]), '全部更新（1）',
  'and the outstanding retry is still offered after the bar is dismissed');

// --- 6. a double click cannot start two queues -----------------------------
// The registry file and the mcp-client fibers have exactly one writer while a
// queue runs, so the guard has to hold at click time: the second click lands
// before `busy` has re-rendered the buttons into their disabled state.
{
  const before = events.filter((e) => e.startsWith('request:')).length;
  const btn = keyed(nodes, 'all')[0];
  assert.ok(btn, 'the batch button is still there to double-click');
  btn.props.onClick();
  btn.props.onClick();
  for (let i = 0; i < 30; i += 1) await settle();
  nodes = walk(await render());
  const started = events.filter((e) => e.startsWith('request:')).length - before;
  assert.equal(started, 1,
    `two clicks queued one retry of the one outstanding item, not two — got ${started} requests`);
}

// --- 7. a settled queue states the outcome instead of re-offering it -------
// beta's retry succeeded, so nothing is outstanding. This is the state that was
// reported broken: the bar still read 「全部更新（1）」 and never said 「已完成」.
const settled = keyed(nodes, 'all')[0];
assert.ok(settled, 'the slot is kept, so the layout does not jump');
assert.equal(textOf(settled), '✓ 已完成（1 台已更新）',
  `a settled queue reports its outcome where the button was — got: ${textOf(settled)}`);
assert.ok(String(settled.props.className).includes('omkt-btn-done'),
  'and it is drawn as a result, not as a live primary button');
assert.equal(settled.props.disabled, true,
  'so it cannot start a batch it has nothing to put in');
assert.doesNotMatch(String(settled.props.title ?? ''), /台有可用更新/,
  'and its tooltip offers no work');
assert.equal(keyed(nodes, 'track')[0].props.style.display, 'none',
  'the progress track is out of the way once there is no progress left to report');
assert.equal(keyed(nodes, 'jobs').length, 0, 'a one-item queue still lists no details');
assert.ok(buttonByText(nodes, '关闭进度'), 'and the outcome is still dismissible');

// --- 8. a queued row says so, an answered row stops offering, and a closed bar
//        stays closed ---------------------------------------------------------
// The three states the panel was reported in. A listing that still advertises an
// entry the queue already answered is not hypothetical: the host loads once at
// startup, so the page routinely runs ahead of the check it is reading.
stale.set(0, '4.0.0'); // strictly newer than the 3.0.0 section 3 installed
stale.set(3, '1.2.0'); // the entry the host has not rewritten yet
// Hold alpha's own answer open, and only now: the earlier sections had to run
// their updates to completion, including alpha's own from section 3.
gateAlpha = true;
nodes = walk(await render());
const staleBatch = keyed(nodes, 'all')[0];
assert.equal(textOf(staleBatch), '全部更新（2）',
  'a listing that still advertises answered work is offered again once a newer version needs it');
{
  const before = events.length;
  staleBatch.props.onClick();
  for (let i = 0; i < 6; i += 1) await settle();
  assert.deepEqual(events.slice(before).filter((e) => e !== 'updates'),
    ['request:alpha-mcp'],
    'the second item is not even asked for while the first is still in flight');

  nodes = walk(await render());
  const runningBtn = keyed(nodes, 'update')[0];
  assert.ok(runningBtn, 'the row being rewritten keeps its button in place, so nothing moves under the pointer');
  assert.equal(textOf(runningBtn), '更新中…', 'and that button reports what is happening to it');
  assert.equal(runningBtn.props.disabled, true, 'it is not clickable while the host owns the entry');
  assert.equal(runningBtn.props.style.cursor, 'default', 'and it reads as busy rather than as a live control');
  const queuedBtn = keyed(nodes, 'update')[1];
  assert.ok(queuedBtn, 'the row still waiting behind it keeps its button too');
  assert.equal(textOf(queuedBtn), '等待中', 'and says where it stands in the queue');
  assert.equal(queuedBtn.props.disabled, true, 'instead of inviting a second click at the same entry');
  releaseAlpha();
  for (let i = 0; i < 30; i += 1) await settle();
  nodes = walk(await render());
}

assert.equal(keyed(nodes, 'update').length, 0,
  'once an entry is answered its 更新 button is gone — not merely disabled');
const labelTexts = keyed(nodes, 'newv').map(textOf);
assert.ok(labelTexts.some((t) => /✓ 已更新到 4\.0\.0/.test(t)),
  `the updated row states what it moved to — got: ${labelTexts.join(' | ')}`);
assert.ok(!labelTexts.some((t) => /可更新/.test(t)),
  'and no row still advertises a badge the run answered');
assert.equal(textOf(keyed(nodes, 'all')[0]), '✓ 已完成（1 台已更新）',
  'the run reports one updated and one already current');

// The reported bug, exactly: 关闭进度 used to be undone one render later, when the
// batch count was rebuilt from a listing that still carried those badges.
nodes = await clickAndSettle(buttonByText(nodes, '关闭进度'));
assert.equal(keyed(nodes, 'updatebar').length, 0,
  'a dismissed bar stays dismissed — answered entries do not come back as 全部更新（1）');
assert.equal(keyed(nodes, 'all').length, 0, 'and the batch button goes with it');

// Dismissing the panel does not make the page forget what it knows: a release
// newer than the answered one is offered again, with its row button back.
stale.set(3, '1.3.0');
nodes = walk(await render());
assert.equal(textOf(keyed(nodes, 'all')[0]), '全部更新（1）',
  'a newer release than the one that was answered is offered again');
assert.equal(textOf(keyed(nodes, 'update')[0]), '更新', 'with its own row button back');

// --- 9. one name, two rows: the click decides which entry moves --------------
// The registry in the field defines rea-cursor four times. A name is therefore
// not a row identity: 更新 has to carry the row's slot and the version that row
// was showing, or the host updates whichever entry it finds first — which is how
// a row that had just moved to 6.5.0 came back advertising 「可更新 → 6.5.0」.
stale.clear();
[0, 1, 2, 3].forEach((address) => updatedNames.add(address));
extraServers.push(
  {
    name: 'dup-mcp', serverName: 'dup_one', transport: 'stdio', source: 'cursor',
    enabled: true, connected: true, slot: 90, package: { name: 'dup-mcp', version: '1.0.0' },
    update: { updateAvailable: true, latest: '2.0.0', current: '1.0.0' },
  },
  {
    name: 'dup-mcp', serverName: 'dup_two', transport: 'stdio', source: 'cursor',
    enabled: true, connected: true, slot: 91, package: { name: 'dup-mcp', version: '1.1.0' },
    update: { updateAvailable: true, latest: '2.0.0', current: '1.1.0' },
  },
);
nodes = walk(await render());
const dupButtons = keyed(nodes, 'update');
assert.equal(dupButtons.length, 2, 'a name defined twice offers a button per row');
assert.equal(textOf(dupButtons[0]), '更新', 'the first row is offered on its own');
assert.equal(textOf(dupButtons[1]), '更新', 'and so is the second');
{
  const before = updateBodies.length;
  dupButtons[1].props.onClick();
  for (let i = 0; i < 30; i += 1) await settle();
  const sent = updateBodies[before];
  assert.equal(sent.name, 'dup-mcp');
  assert.equal(sent.slot, 91, 'the request names the row that was clicked, not just its name');
  assert.equal(sent.from, '1.1.0', 'and the version that row was showing');
  nodes = walk(await render());
  assert.equal(keyed(nodes, 'update').length, 1,
    'only the clicked row is settled; the other one still needs its own update');
}

// --- 10. a row its own source no longer defines -------------------------------
// The registry in the field held four `rea-cursor` rows; three of them came from
// an old scanner rename (`name-<source>`) and no config file on the machine has
// defined that name for days. They are ghosts: the first one held the fiber for
// the name, the rest were inert, and all four counted as servers and answered to
// their name. The panel marks them instead of quietly dropping them, and offers
// one action for the whole set — because a per-row 移除 aimed by name is what
// removed the wrong row in the first place.
extraServers.push({
  name: 'ghost-mcp', serverName: null, transport: 'stdio', source: 'cursor',
  enabled: true, connected: false, slot: 4, orphan: true,
  package: { name: 'ghost-mcp', version: '9.0.0' },
  // Deliberately offered an update: a ghost must not advertise one, and a probe
  // that cannot see the badge it suppresses proves nothing.
  update: { updateAvailable: true, latest: '9.9.9', current: '9.0.0' },
});
nodes = walk(await render());
{
  assert.ok(!keyed(nodes, 'newv').map(textOf).some((t) => t.includes('9.9.9')),
    'a ghost does not advertise the update its entry still carries');
  const rows = nodes.filter((n) => n.props?.className === 'omkt-srow');
  const ghostRow = rows.find((n) => textOf(n).includes('来源已删除'));
  assert.ok(ghostRow, 'a row the scan proved its source has dropped is marked as such');
  const ghostButtons = walk(ghostRow).filter((n) => n.type === 'button');
  assert.ok(!ghostButtons.some((b) => textOf(b) === '更新'),
    'and it is not offered an update: nothing would ever re-import it');
  const before = keyed(nodes, 'update').length;

  const orphanBar = keyed(nodes, 'orphanbar')[0];
  assert.ok(orphanBar, 'the ghosts are collected into one notice instead of four odd-looking rows');
  const cleanBtn = walk(orphanBar).find((n) => n.type === 'button');
  assert.equal(textOf(cleanBtn), '清理 1 条', 'with the count and one action for all of them');

  // 停用 still belongs to the row that was clicked.
  const off = ghostButtons.find((b) => textOf(b) === '停用');
  assert.ok(off, 'a ghost row can still be turned off by hand');
  off.props.onClick();
  for (let i = 0; i < 6; i += 1) await settle();
  const toggled = actionBodies.filter((b) => b.url === '/set-enabled').pop();
  assert.equal(toggled.name, 'ghost-mcp');
  assert.equal(toggled.slot, 4, '停用 names the row that was clicked, not just its name');

  // And the cleanup action is one request for the whole set.
  const sentBefore = actionBodies.length;
  nodes = walk(await render());
  const barNow = keyed(nodes, 'orphanbar')[0];
  walk(barNow).find((n) => n.type === 'button').props.onClick();
  for (let i = 0; i < 8; i += 1) await settle();
  const swept = actionBodies.slice(sentBefore).filter((b) => b.url === '/forget-orphans');
  assert.equal(swept.length, 1, '清理 asks the host once, not once per row');
  assert.deepEqual(swept[0].names, ['ghost-mcp'], 'and names what it is dropping');
  nodes = walk(await render());
  assert.equal(keyed(nodes, 'orphan').length, 0, 'the ghost is gone from the listing');
  assert.equal(keyed(nodes, 'orphanbar').length, 0, 'and the notice goes with it');
  assert.equal(keyed(nodes, 'update').length, before,
    'cleaning a ghost does not disturb the live rows around it');
}

// 移除 aims by slot too — the row that was clicked is the row that leaves.
{
  const rows = nodes.filter((n) => n.props?.className === 'omkt-srow');
  const dupRow = rows.find((n) => textOf(n).includes('dup_two') || textOf(n).includes('1.1.0'));
  assert.ok(dupRow, 'the second same-named row is still in the listing');
  walk(dupRow).filter((n) => n.type === 'button').find((b) => textOf(b) === '移除').props.onClick();
  for (let i = 0; i < 8; i += 1) await settle();
  const removed = actionBodies.filter((b) => b.url === '/remove').pop();
  assert.equal(removed.name, 'dup-mcp');
  assert.equal(removed.slot, 91, '移除 carries the row it was clicked on');
  nodes = walk(await render());
  const remaining = nodes.filter((n) => n.props?.className === 'omkt-srow' && textOf(n).includes('dup-mcp'));
  assert.equal(remaining.length, 1, 'the row that was removed is the one that left');
  assert.ok(textOf(remaining[0]).includes('dup_one'),
    'and its same-named sibling is untouched — the one that is left is the first row');
}

// --- 11. a check that failed is not "already up to date" ----------------------
// The host reports failed lookups apart from up-to-date ones; the page used to
// fold both into one 「均已是最新版本」 line, so a machine that could not reach
// the registry was told everything was current. The count is named now, and the
// row whose verdict carries an error keeps a red chip instead of silence.
checkFailures = 1;
extraServers.push({
  name: 'offline-mcp', serverName: null, transport: 'stdio', source: 'cursor',
  enabled: true, connected: false, slot: 5,
  package: { name: 'offline-mcp', version: '1.0.0' },
  update: { error: 'fetch failed', updateAvailable: false, current: '1.0.0' },
});
nodes = walk(await render());
nodes = await clickAndSettle(keyed(nodes, 'hd-updates')[0]);
{
  const said = textOf(keyed(nodes, 'message')[0]);
  assert.match(said, /查不到最新版本/,
    `the failed lookups are named instead of folded into 「已是最新」 — got: ${said}`);
  assert.doesNotMatch(said, /均已是最新/,
    'and a check that could not reach the registry never claims everything is current');
  const chips = keyed(nodes, 'checkfail');
  assert.equal(chips.length, 1, 'the row whose check failed says so instead of staying silent');
  assert.match(String(chips[0].props.title ?? ''), /fetch failed/, 'and the chip carries the reason');
}

console.log('ok — update queue: single run + batch run sequentially, queued rows say so, answered rows stop offering, settled bar dismissible, a repeated name still updates the row that was clicked, a row whose source is gone is marked and swept in one action, and a check that failed is never reported as up to date');