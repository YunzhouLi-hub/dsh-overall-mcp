// tools/_check-css.mjs — every className the client applies must exist in the
// injected stylesheet, or the rule silently does nothing.
import { readFile } from 'node:fs/promises';

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
const missing = [...used].filter((c) => !defined.has(c));
console.log('classes used:', [...used].sort().join(' '));
console.log('missing in sheet:', missing.join(', ') || 'none');
if (missing.length) process.exitCode = 1;
