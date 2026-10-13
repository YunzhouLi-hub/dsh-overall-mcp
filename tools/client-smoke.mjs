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
let injectedSlot = null;
const fakeCtx = {
  slots: {
    inject(slotName, callback) {
      injectedSlot = slotName;
      return callback();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

exportsObj.apply(fakeCtx);

if (injectedSlot !== 'settings.section') throw new Error(`inject() called with ${injectedSlot}`);
if (registrations.length !== 1) throw new Error(`expected 1 registration, got ${registrations.length}`);

const { options, component } = registrations[0];
if (options.name !== 'settings.section') throw new Error(`wrong slot name: ${options.name}`);
if (typeof options.id !== 'string' || options.id === '') throw new Error('registration is missing a flat id');
if (typeof options.order !== 'number') throw new Error('registration is missing a numeric order');
if (options.label === undefined) throw new Error('registration is missing label');
if (options.options !== undefined) throw new Error('registration must be FLAT, not nested under options');
if (typeof component !== 'function') throw new Error('registration has no component');

// The bundle shows its own version in the page head but cannot read
// package.json at runtime, so the two are kept equal here instead: a version
// chip that lies is worse than no chip.
const pkg = JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8'));
const clientVersion = exportsObj.__test?.version;
if (!clientVersion) throw new Error('client exports no __test.version');
if (clientVersion !== pkg.version) {
  throw new Error(`client version ${clientVersion} != package.json ${pkg.version}`);
}

console.log(JSON.stringify({
  ok: true,
  moduleId: captured.id,
  version: clientVersion,
  inject: exportsObj.inject,
  slot: injectedSlot,
  registration: { id: options.id, order: options.order, label: options.label },
}, null, 2));

