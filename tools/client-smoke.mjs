// tools/client-smoke.mjs — headless smoke test for the client bundle contract.
//
// Simulates the web frontend's module loader:
//   window.__ModuleLoader__.load({ id, factory }) is captured, the factory is
//   called with a `require` shim, and the module's apply(ctx) runs against a
//   fake slots service. This reproduces the desktop failure
//   ("web boot: 1 entry did not activate / dsh-overall-mcp: failed") whenever
//   apply() throws or the registration shape is wrong.
//
// Usage: node tools/client-smoke.mjs [--render]

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'client', 'client.js');

// React is provided by the app's module loader at runtime (it is bundled inside
// the frontend), so the shim supplies a minimal stand-in: the component is only
// rendered by the real shell, and this test validates the registration contract.
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  Fragment: Symbol('Fragment'),
};
const requireShim = (id) => {
  if (id === 'react') return reactStub;
  if (id === 'react/jsx-runtime') return { jsx: reactStub.createElement, jsxs: reactStub.createElement };
  throw new Error(`unexpected module request: ${id}`);
};

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { captured = spec; },
  },
};

const code = await readFile(bundlePath, 'utf8');
// eslint-disable-next-line no-new-func
new Function('window', 'require', code)(globalThis.window, (id) => requireShim(id));

if (!captured) throw new Error('client bundle did not call window.__ModuleLoader__.load');
if (captured.id !== 'dsh-overall-mcp') throw new Error(`unexpected module id: ${captured.id}`);

const exportsObj = captured.factory((id) => requireShim(id));
if (typeof exportsObj.apply !== 'function') throw new Error('module exports no apply()');
if (!Array.isArray(exportsObj.inject)) throw new Error('module exports no inject array');

const registrations = [];
const injectedSlots = [];
const fakeCtx = {
  slots: {
    inject(slotName, callback) {
      injectedSlots.push(slotName);
      return callback();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

exportsObj.apply(fakeCtx);

// One arrival, two halves: the rail row and the panel it opens. Registering
// only one of them is the failure this test exists for — a row with no panel
// throws on click, and a panel with no row is unreachable.
if (!injectedSlots.includes('sidebar.panellist')) {
  throw new Error(`inject() never asked for sidebar.panellist (got: ${injectedSlots.join(', ')})`);
}
if (!injectedSlots.includes('main')) {
  throw new Error(`inject() never asked for main (got: ${injectedSlots.join(', ')})`);
}
if (registrations.length !== 2) throw new Error(`expected 2 registrations, got ${registrations.length}`);

const row = registrations.find((r) => r.options.name === 'sidebar.panellist');
const panel = registrations.find((r) => r.options.name === 'main');
if (!row) throw new Error('no sidebar.panellist registration');
if (!panel) throw new Error('no main registration');

for (const { options, component } of registrations) {
  if (options.options !== undefined) throw new Error(`${options.name}: registration must be FLAT`);
  if (typeof component !== 'function') throw new Error(`${options.name}: registration has no component`);
}

// The row carries identity and order; the panel is keyed by the row's id, and
// the layout throws when a row is selected whose key is missing — so the two
// strings have to be the same or the rail is a dead link.
if (typeof row.options.id !== 'string' || row.options.id === '') {
  throw new Error('sidebar row is missing its id');
}
if (panel.options.key !== row.options.id) {
  throw new Error(`main key ${panel.options.key} != sidebar row id ${row.options.id}`);
}
if (typeof row.options.label !== 'string' || row.options.label === '') {
  throw new Error('sidebar row is missing its label');
}
if (typeof row.options.order !== 'number') {
  throw new Error('sidebar row is missing a numeric order');
}
// The plugin page sits at 0 and the task manager at 10; this entry belongs
// between them, i.e. directly below 插件.
if (!(row.options.order > 0 && row.options.order < 10)) {
  throw new Error(`sidebar order ${row.options.order} does not sit between the plugins page (0) and the task manager (10)`);
}

// The bundle cannot read package.json at runtime, so the values the host keys
// off are pinned here instead. A drift produces a plugin nobody can find rather
// than one that fails loudly, and a version chip that lies is worse than none.
const pkg = JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8'));
const clientVersion = exportsObj.__test?.version;
if (!clientVersion) throw new Error('client exports no __test.version');
if (clientVersion !== pkg.version) {
  throw new Error(`client version ${clientVersion} != package.json ${pkg.version}`);
}
// The changelog's newest section names the version it documents. A file that
// stops at an older release is the same class of lie as a stale version chip:
// it tells a reader what changed in a build they are not running.
const changelog = await readFile(path.join(here, '..', 'CHANGELOG.md'), 'utf8').catch(() => null);
if (changelog === null) throw new Error('CHANGELOG.md is missing');
const newestSection = changelog.match(/^##\s*\[?([0-9]+\.[0-9]+\.[0-9]+)/m);
if (!newestSection) throw new Error('CHANGELOG.md has no versioned section');
if (newestSection[1] !== pkg.version) {
  throw new Error(`CHANGELOG.md newest section is ${newestSection[1]}, package.json is ${pkg.version}`);
}
const bundleName = exportsObj.__test?.bundleName;
if (!bundleName) throw new Error('client exports no __test.bundleName');
if (bundleName !== pkg.name) {
  throw new Error(`client bundleName ${bundleName} != package.json name ${pkg.name}`);
}
const panelId = exportsObj.__test?.panelId;
if (!panelId) throw new Error('client exports no __test.panelId');
if (panelId !== row.options.id) {
  throw new Error(`__test.panelId ${panelId} != registered row id ${row.options.id}`);
}

// Both slots live in packages this bundle must declare, or `slots.inject` waits
// forever and nothing appears at all.
const inject = exportsObj.inject ?? [];
if (!inject.includes('slots')) throw new Error('module does not inject the slots service');
const declared = pkg.dsh?.client?.inject ?? [];
for (const surface of ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-layout']) {
  if (!declared.includes(surface)) {
    throw new Error(`package.json dsh.client.inject is missing ${surface}`);
  }
}
for (const stale of ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-plugin-manager']) {
  if (declared.includes(stale)) {
    throw new Error(`package.json dsh.client.inject still pulls in ${stale}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  moduleId: captured.id,
  version: clientVersion,
  inject: exportsObj.inject,
  slots: injectedSlots,
  rail: { id: row.options.id, order: row.options.order, label: row.options.label },
  panel: { key: panel.options.key },
}, null, 2));

