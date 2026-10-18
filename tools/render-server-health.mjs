// tools/render-server-health.mjs — render a server row's 检查 button and verdict.
//
// 「测试 MCP 服务是否健康」 is a row action, so nothing else in the probe set can
// reach it: the section-level probes render rows from fixtures that never carry a
// `health`, and the verdict line only exists after the sheet has been clicked.
// Rendering ServerRow directly covers the three shapes the host sends — a row
// that was never checked, a healthy one, and one whose tool list came back empty
// (the case a green dot used to hide).
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
assert.ok(__test?.ServerRow, 'client exports __test.ServerRow');

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

const row = (extra = {}) => ({
  name: 'fs-server',
  slot: 0,
  source: 'claude-desktop',
  transport: 'stdio',
  enabled: true,
  connected: true,
  status: 'connected',
  serverName: 'fs-server',
  package: null,
  about: null,
  ...extra,
});

const render = (server, calls) => __test.ServerRow({
  server,
  busy: false,
  job: null,
  onToggle: () => {},
  onRemove: () => {},
  onUpdate: () => {},
  onConfigure: () => {},
  onHealth: (clicked) => calls.push(clicked),
});

// ---- 1. never checked: the button exists, no verdict is invented ------------
const calls = [];
const fresh = walk(render(row(), calls));
const healthButton = fresh.find((node) => node.type === 'button' && textOf(node) === '检查');
assert.ok(healthButton, 'a row offers 检查');
assert.equal(fresh.some((node) => node.props?.className === 'omkt-shealth'), false,
  'a row that was never checked shows no verdict');
healthButton.props.onClick();
assert.equal(calls.length, 1);
assert.equal(calls[0].name, 'fs-server', '检查 sends the row, not a name-only guess');
assert.equal(typeof healthButton.props.title, 'string');

// ---- 2. healthy: one green line, tool count and time in it -----------------
const healthyAt = '2026-10-18T08:31:07.000Z';
const healthy = walk(render(row({
  health: {
    at: healthyAt,
    ok: true,
    toolCount: 5,
    ms: 41,
    checks: [
      { id: 'enabled', ok: true, detail: '已启用' },
      { id: 'mounted', ok: true, detail: '已挂载' },
      { id: 'handshake', ok: true, detail: '握手完成' },
      { id: 'tools', ok: true, detail: '5 个工具在册' },
      { id: 'config', ok: true, detail: '声明的要求已齐' },
    ],
  },
}), calls));
const healthyLine = healthy.find((node) => node.props?.className === 'omkt-shealth');
assert.ok(healthyLine, 'a checked row shows its verdict');
const healthyText = textOf(healthyLine);
assert.match(healthyText, /检查健康/);
assert.match(healthyText, /5 个工具/);
assert.match(healthyText, /08:31:07/);
assert.equal(healthyLine.props.style.color, '#2f7d32', 'healthy is green');
// The hover text is the whole checklist, so a reader can see what passed.
assert.match(healthyLine.props.title, /✓ 握手完成/);

// ---- 3. unhealthy: the failing link is named, not just a red dot ------------
const unhealthy = walk(render(row({
  connected: true,
  status: 'connected',
  health: {
    at: healthyAt,
    ok: false,
    toolCount: 0,
    ms: 12,
    checks: [
      { id: 'enabled', ok: true, detail: '已启用' },
      { id: 'mounted', ok: true, detail: '已挂载' },
      { id: 'handshake', ok: true, detail: '握手完成' },
      { id: 'tools', ok: false, detail: '一个工具都没注册：服务进程可能已经退出' },
      { id: 'config', ok: true, detail: '声明的要求已齐' },
    ],
  },
}), calls));
const unhealthyLine = unhealthy.find((node) => node.props?.className === 'omkt-shealth');
const unhealthyText = textOf(unhealthyLine);
assert.match(unhealthyText, /检查不健康/);
// The row still says 已连接 (a fiber exists) — the verdict is what contradicts it,
// which is exactly why the line names the failed check instead of repeating it.
assert.match(textOf(unhealthy[0]), /已连接/);
assert.match(unhealthyText, /一个工具都没注册/);
assert.equal(unhealthyLine.props.style.color, '#b3261e', 'unhealthy is red');

console.log('ok — 检查 button + verdict line: unchecked rows invent nothing, a healthy verdict carries the tool count and time, an unhealthy one names the failed check');
