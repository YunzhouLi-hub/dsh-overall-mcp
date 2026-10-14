// tools/_check-css.mjs — every className the client applies must exist in the
// injected stylesheet, or the rule silently does nothing.
import { readFile } from 'node:fs/promises';

// Classes that exist only as selection hooks for the browser probes: a row's
// purpose line and facts line are built inline, and once those styles are
// written as attributes the only way to find them again is a class. They carry
// no rules on purpose — adding a no-op rule just to satisfy this check would be
// exactly the dead class the check exists to catch.
const HOOKS = new Set(['omkt-srow', 'omkt-srow-main', 'omkt-sname', 'omkt-sabout', 'omkt-smeta']);

const src = await readFile('client/client.js', 'utf8');
const used = new Set();
for (const m of src.matchAll(/className:\s*(`[^`]*`|"[^"]*"|'[^']*')/g)) {
  const literal = m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, '');
  for (const cls of literal.split(/\s+/)) if (cls) used.add(cls);
}
const sheetStart = src.indexOf('el.textContent = [');
const sheetEnd = src.indexOf('].join("\\n")', sheetStart);
if (sheetStart < 0 || sheetEnd < 0) throw new Error('stylesheet block not found');
const sheet = src.slice(sheetStart, sheetEnd);
const defined = new Set([...sheet.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]));
const missing = [...used].filter((c) => !defined.has(c) && !HOOKS.has(c));
console.log('classes used:', [...used].sort().join(' '));
console.log('probe hooks (no rules by design):', [...used].filter((c) => HOOKS.has(c)).sort().join(' ') || 'none');
console.log('missing in sheet:', missing.join(', ') || 'none');
if (missing.length) process.exitCode = 1;
